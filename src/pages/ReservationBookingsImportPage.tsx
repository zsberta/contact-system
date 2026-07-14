// ----------------------------------------------------------------------------
// ReservationBookingsImportPage — admin-only sub-tab on the bookings page.
//
// Use case: bulk-migrate bookings from another production system into this CRM.
//
// Flow:
//   1. Paste JSON in the textarea → click "Verify".
//   2. Client-side: parse + extract the items array, JSON.parse it.
//   3. Server-side: POST /api/reservations/:id/bookings/dry-run with the
//      parsed items; the BE runs the EXACT SAME checks as the create endpoint
//      (shape, slot alignment, availability schedules, extra_fields_enabled,
//      bounded-bag size). Returns per-item { ok, error?, startsAt, endsAt,
//      hasData } — i.e. what the preview shows is *literally* what Save will
//      do.
//
// Why BE dry-run instead of mirroring validation in JS: the FE cannot know
// reservation-specific rules (schedules, disabled ranges, slot grids,
// extra_fields_enabled) without hitting the API. Duplicating them client-
// side would drift from BE truth over time.
//
//   4. Preview = first 100 valid items, rendered with their `data` field
//      expanded (key/value list so the user can see the customer info
//      that will be saved).
//   5. Save → confirm dialog → sequential POSTs each valid item with its
//      `data` payload. Post-Save: a persistent result card shows the
//      count + (if any) a table of failed rows with reasons, so the user
//      can act on them instead of wondering what disappeared.
//
// Why sequential, not parallel: the DB EXCLUDE constraint on the bookings
// table rejects overlapping inserts as 409. Parallel POSTs would race;
// sequential gives a clean per-item status, lets the user see which slot
// blocked which item.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ClipboardPaste,
  FileUp,
  List,
  FileText,
  CalendarDays,
  Clock,
  Ban,
  Loader2,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { showError, showSuccess } from "@/utils/toast";
import { cn } from "@/lib/utils";
import {
  createReservationBooking,
  dryRunBookingImport,
  getReservationById,
} from "@/lib/reservations";
import type {
  BookingImportDryRunRow,
} from "@/lib/reservations";
import type { ReservationBookingDTO } from "@/types/reservation";

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Defensive error-message extraction. Our `apiFetch` helper throws a
 * PLAIN OBJECT of shape `{ message: string, status: number }`, NOT a
 * real `Error` instance — so `err instanceof Error` is false and
 * `String(err)` renders as "[object Object]". We need to handle all
 * three shapes the codebase produces:
 *   1. apiFetch plain object: { message, status }
 *   2. Native Error (FE thrown, e.g. JSON.parse failure, AbortError)
 *   3. Anything else → fall back to String()
 */
function errorMessageFromApiError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  if (err instanceof Error) return err.message || err.name || "Unknown error";
  if (typeof err === "string") return err;
  return String(err);
}

// ── shared tab nav styling (matches ReservationViewPage siblings) ──────────

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-accent-foreground";

const PREVIEW_LIMIT = 100;

// ── types ───────────────────────────────────────────────────────────────────

interface ValidItem {
  /** 1-based original input position — kept so the preview rows align with
   *  the user-pasted JSON, NOT the position in the BE slice. */
  originalIndex: number;
  startsAt: string;
  endsAt: string;
  startsAtDate: Date;
  endsAtDate: Date;
  durationMinutes: number;
  /** The original raw `data` blob from the input. Null if the input item
   *  had no `data` field. POSTed back verbatim on Save. */
  rawData: Record<string, unknown> | null;
}

interface ParseError {
  /** 1-based original input position. */
  originalIndex: number;
  message: string;
}

interface DryRunState {
  valid: ValidItem[];
  errors: ParseError[];
  rawCount: number;
}

type ClientParseResult =
  | { kind: "fatal"; error: string }
  | { kind: "ok"; clientErrors: ParseError[]; rawCount: number };

// Per-item save-time failure (after the BE has rejected with 400/409 etc.)
interface SaveFailure {
  originalIndex: number;
  startsAt?: string;
  endsAt?: string;
  reason: string;
}

type SaveOutcome =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "saved"; created: number; failed: SaveFailure[]; total: number }
  | { status: "error"; message: string };

// ── helpers ────────────────────────────────────────────────────────────────

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}min`;
}

/** Render a `data` object as a compact chip-style preview (up to 4 entries). */
function DataPreview({ data }: { data: Record<string, unknown> | null }) {
  if (!data || Object.keys(data).length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const entries = Object.entries(data).slice(0, 4);
  const overflow = Object.keys(data).length - entries.length;
  return (
    <div className="text-xs font-mono space-y-0.5">
      {entries.map(([k, v]) => {
        let display: string;
        if (v === null) display = "null";
        else if (typeof v === "string") display = JSON.stringify(v);
        else if (typeof v === "number" || typeof v === "boolean") {
          display = String(v);
        } else {
          display = JSON.stringify(v);
        }
        if (display.length > 60) display = display.slice(0, 57) + "…";
        return (
          <div key={k} className="flex gap-1.5">
            <span className="text-muted-foreground shrink-0">{k}:</span>
            <span className="truncate" title={display}>
              {display}
            </span>
          </div>
        );
      })}
      {overflow > 0 && (
        <div className="text-muted-foreground">+{overflow} more</div>
      )}
    </div>
  );
}

// ── client-side parsing ────────────────────────────────────────────────────

/**
 * Splits the JSON input into the shape the BE dry-run endpoint expects.
 * Two accepted shapes:
 *   - top-level array:  [{ startsAt, endsAt, data? }, ...]
 *   - wrapper:          { bookings: [...] }
 *
 * Per-item client checks (anything beyond goes to BE dry-run):
 *   - item must be an object
 *   - startsAt + endsAt must be strings
 *   - `data` if present must be a plain object (no arrays)
 *
 * `rawDataByOriginal` lets us keep the original `data` blob keyed by
 * 1-based original input position, so we can POST it back verbatim on Save.
 */
function parseClientInput(
  json: unknown,
): ClientParseResult & { rawDataByOriginal?: Map<number, Record<string, unknown> | null> } {
  let rawItems: unknown[];
  if (Array.isArray(json)) {
    rawItems = json;
  } else if (
    json &&
    typeof json === "object" &&
    Array.isArray((json as { bookings?: unknown }).bookings)
  ) {
    rawItems = (json as { bookings: unknown[] }).bookings;
  } else {
    return { kind: "fatal", error: "import_no_array" };
  }

  const clientErrors: ParseError[] = [];
  const rawDataByOriginal = new Map<number, Record<string, unknown> | null>();
  rawItems.forEach((raw, i) => {
    const originalIndex = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      clientErrors.push({
        originalIndex,
        // Returns the i18n KEY, not the translated string — caller
        // (handleVerify) resolves it via t() once it has the translator
        // in scope. This keeps parseClientInput pure (no React hook dep).
        message: "import_error_not_object",
      });
      return;
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.startsAt !== "string" || typeof obj.endsAt !== "string") {
      clientErrors.push({
        originalIndex,
        message: "import_error_required_field",
      });
      return;
    }
    if (
      obj.data !== undefined &&
      obj.data !== null &&
      (typeof obj.data !== "object" || Array.isArray(obj.data))
    ) {
      clientErrors.push({
        originalIndex,
        message: "import_error_data_must_be_object",
      });
      return;
    }
    rawDataByOriginal.set(
      originalIndex,
      obj.data && typeof obj.data === "object" && !Array.isArray(obj.data)
        ? (obj.data as Record<string, unknown>)
        : null,
    );
  });

  return {
    kind: "ok",
    clientErrors,
    rawCount: rawItems.length,
    rawDataByOriginal,
  };
}

// ── main component ─────────────────────────────────────────────────────────

export default function ReservationBookingsImportPage() {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const { id } = useParams<{ id: string }>();
  const reservationId = id ? Number.parseInt(id) : null;
  const queryClient = useQueryClient();

  // Locale for Date display — same trick the calendar page uses.
  const locale = i18n.language || "hu";

  // Source input + JSON-parse verdict + dry-run result
  const [input, setInput] = useState<string>("");
  const [parsed, setParsed] = useState<ClientParseResult | null>(null);
  const [dryRun, setDryRun] = useState<DryRunState | null>(null);

  // Save flow state
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome>({ status: "idle" });
  const [isVerifying, setIsVerifying] = useState(false);

  const { data: reservation, isLoading } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  // ── verify — JSON.parse → BE dry-run ────────────────────────────────────
  const handleVerify = useCallback(async () => {
    setOutcome({ status: "idle" });
    setDryRun(null);

    const trimmed = input.trim();
    if (!trimmed) {
      setParsed({ kind: "fatal", error: t("reservations:import_no_array") });
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      setParsed({ kind: "fatal", error: t("reservations:import_json_invalid") });
      return;
    }
    const client = parseClientInput(json);
    if (client.kind === "fatal") {
      setParsed({ kind: "fatal", error: t(`reservations:${client.error}`) });
      return;
    }

    // Build BE payload by re-walking raw items, skipping the ones the
    // client already rejected. Keep a parallel array so we can map the BE
    // result rows back to their ORIGINAL input index (not the slice index).
    type BeItem = {
      startsAt: string;
      endsAt: string;
      data: Record<string, unknown> | null;
    };
    const bePayload: BeItem[] = [];
    const beOriginalIndices: number[] = [];
    const skipClientIndices = new Set(
      client.clientErrors.map((e) => e.originalIndex),
    );
    const raw = json;
    const arr: unknown[] = Array.isArray(raw)
      ? (raw as unknown[])
      : ((raw as { bookings: unknown[] }).bookings || []);
    for (let i = 0; i < arr.length; i++) {
      const originalIndex = i + 1;
      if (skipClientIndices.has(originalIndex)) continue;
      const item = arr[i];
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.startsAt !== "string" || typeof obj.endsAt !== "string") continue;
      bePayload.push({
        startsAt: obj.startsAt,
        endsAt: obj.endsAt,
        data: client.rawDataByOriginal?.get(originalIndex) ?? null,
      });
      beOriginalIndices.push(originalIndex);
    }

    const translatedClientErrors: ParseError[] = client.clientErrors.map(
      (e) => ({ originalIndex: e.originalIndex, message: t(`reservations:${e.message}`) }),
    );
    setParsed({
      kind: "ok",
      clientErrors: translatedClientErrors,
      rawCount: client.rawCount,
    });

    if (bePayload.length === 0) {
      setDryRun({ valid: [], errors: translatedClientErrors, rawCount: client.rawCount });
      return;
    }

    setIsVerifying(true);
    let resp: { results: BookingImportDryRunRow[] };
    try {
      resp = await dryRunBookingImport(reservationId!, bePayload);
    } catch (err) {
      const msg = errorMessageFromApiError(err);
      setIsVerifying(false);
      showError(
        t("reservations:import_dry_run_failed") + ` (${msg})`,
      );
      return;
    }
    setIsVerifying(false);

    // Fold BE verdict back into the user's expected input ordering.
    const valid: ValidItem[] = [];
    const errors: ParseError[] = [...translatedClientErrors];
    resp.results.forEach((row, sliceIdx) => {
      const originalIndex = beOriginalIndices[sliceIdx];
      if (row.ok && row.startsAt && row.endsAt) {
        const startDate = new Date(row.startsAt);
        const endDate = new Date(row.endsAt);
        valid.push({
          originalIndex,
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          startsAtDate: startDate,
          endsAtDate: endDate,
          durationMinutes: Math.round(
            (endDate.getTime() - startDate.getTime()) / 60000,
          ),
          rawData: bePayload[sliceIdx].data,
        });
      } else if (!row.ok) {
        errors.push({
          originalIndex,
          message: row.error || t("reservations:import_error_invalid_iso"),
        });
      }
    });
    valid.sort((a, b) => a.originalIndex - b.originalIndex);
    errors.sort((a, b) => a.originalIndex - b.originalIndex);
    setDryRun({ valid, errors, rawCount: client.rawCount });
  }, [input, reservationId, t]);

  // ── save — sequential POSTs, each with its own `data` blob ──────────────

  const importMutation = useMutation({
    mutationFn: async (items: ValidItem[]) => {
      const created: ReservationBookingDTO[] = [];
      const failed: SaveFailure[] = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        setOutcome({ status: "running", done: i, total: items.length });
        try {
          const row = await createReservationBooking(
            reservationId!,
            it.startsAt,
            it.endsAt,
            {
              data: it.rawData,
              source: "import",
            },
          );
          created.push(row);
        } catch (err) {
          const msg = errorMessageFromApiError(err);
          failed.push({
            originalIndex: it.originalIndex,
            startsAt: it.startsAt,
            endsAt: it.endsAt,
            reason: msg,
          });
        }
      }
      setOutcome({
        status: "saved",
        created: created.length,
        failed,
        total: items.length,
      });
      return { created: created.length, failed };
    },
    onSuccess: ({ created, failed }) => {
      const total = created + failed.length;
      if (failed.length === 0) {
        showSuccess(t("reservations:import_success", { count: created }));
      } else if (created > 0) {
        showSuccess(
          t("reservations:import_partial", {
            created,
            failed: failed.length,
          }),
        );
      } else {
        showError(
          t("reservations:import_partial", {
            created: 0,
            failed: failed.length,
          }),
        );
      }
      // Refresh bookings tables so the new rows show up.
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings-calendar", reservationId],
      });
      setOutcome({ status: "saved", created, failed, total });
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      const msg = errorMessageFromApiError(err);
      showError(t("common:operation_failed", { error: msg }));
      setOutcome({ status: "error", message: msg });
      setConfirmOpen(false);
    },
  });

  const handleSave = useCallback(() => {
    if (!dryRun || dryRun.valid.length === 0) return;
    setConfirmOpen(true);
  }, [dryRun]);

  const handleConfirmSave = useCallback(() => {
    if (!dryRun || dryRun.valid.length === 0) return;
    setOutcome({
      status: "running",
      done: 0,
      total: dryRun.valid.length,
    });
    importMutation.mutate(dryRun.valid);
  }, [dryRun, importMutation]);

  const handleClear = useCallback(() => {
    setInput("");
    setParsed(null);
    setDryRun(null);
    setOutcome({ status: "idle" });
    setConfirmOpen(false);
  }, []);

  // ── derived state for the UI ─────────────────────────────────────────────

  const previewItems = useMemo(
    () => (dryRun ? dryRun.valid.slice(0, PREVIEW_LIMIT) : []),
    [dryRun],
  );
  const previewOverflow = dryRun ? dryRun.valid.length - previewItems.length : 0;
  const validCount = dryRun ? dryRun.valid.length : 0;
  const invalidCount = dryRun ? dryRun.errors.length : 0;
  const rawCount = dryRun ? dryRun.rawCount : parsed?.kind === "ok" ? parsed.rawCount : 0;

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto space-y-6 w-full">
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      </div>
    );
  }

  const isRunning = outcome.status === "running";
  const isPendingAny = isVerifying || importMutation.isPending || isRunning;

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      {/* Tab navigation — matches the sibling reservation pages */}
      <nav className="flex gap-1 border-b pb-px overflow-x-auto">
        <NavLink
          to={`/reservations/view/${reservationId}`}
          end
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <FileText className="h-4 w-4" />
          {t("reservations:details_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/bookings`}
          end
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <List className="h-4 w-4" />
          {t("reservations:bookings_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/bookings/import`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <FileUp className="h-4 w-4" />
          {t("reservations:import_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/calendar`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <CalendarDays className="h-4 w-4" />
          {t("reservations:calendar_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/schedules`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <Clock className="h-4 w-4" />
          {t("reservations:schedules_tab")}
        </NavLink>
        <NavLink
          to={`/reservations/view/${reservationId}/blocked`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <Ban className="h-4 w-4" />
          {t("reservations:blocked_tab")}
        </NavLink>
      </nav>

      {/* Title card */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-bold flex items-center gap-2">
            <FileUp className="h-5 w-5 text-muted-foreground" />
            {t("reservations:import_title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>{t("reservations:import_description")}</p>
          <p className="text-xs">{t("reservations:import_or_object")}</p>
          {reservation && (
            <p className="text-xs">
              <span className="font-medium">{reservation.name}</span>
              {" — "}
              <span className="font-mono">
                granularity={reservation.granularity}
              </span>
              {reservation.slotDurationMinutes !== null && (
                <>
                  {", "}
                  <span className="font-mono">
                    slot={reservation.slotDurationMinutes}m
                  </span>
                </>
              )}
              {", "}
              <span className="font-mono">
                extra_fields={String(reservation.extraFieldsEnabled)}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Input card */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ClipboardPaste className="h-4 w-4 text-muted-foreground" />
            JSON input
          </CardTitle>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleClear}
              disabled={isPendingAny}
            >
              <X className="mr-1 h-4 w-4" />
              {t("reservations:import_clear")}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleVerify}
              disabled={isPendingAny || !input.trim()}
            >
              {isVerifying ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1 h-4 w-4" />
              )}
              {isVerifying
                ? t("reservations:import_verifying")
                : t("reservations:import_verify")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("reservations:import_placeholder")}
            rows={12}
            spellCheck={false}
            disabled={isPendingAny}
            className={cn(
              "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono",
              "shadow-sm placeholder:text-muted-foreground",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          />
        </CardContent>
      </Card>

      {/* Client-side fatal parse error (JSON syntax / shape) */}
      {parsed?.kind === "fatal" && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="pt-6 flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{parsed.error}</span>
          </CardContent>
        </Card>
      )}

      {/* Server-side dry-run verdict */}
      {dryRun && (
        <>
          {/* Summary */}
          <Card>
            <CardContent className="pt-6">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="font-medium">
                  {t("reservations:import_summary", {
                    valid: validCount,
                    invalid: invalidCount,
                    total: rawCount,
                  })}
                </span>
                {previewOverflow > 0 && (
                  <span className="text-muted-foreground text-xs">
                    {t("reservations:import_preview_truncated", {
                      shown: PREVIEW_LIMIT,
                      total: validCount,
                    })}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Preview of first 100 valid items with extra-fields column */}
          {previewItems.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">
                  {t("reservations:import_preview", {
                    shown: Math.min(previewItems.length, PREVIEW_LIMIT),
                    total: validCount,
                  })}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        {t("reservations:import_preview_col_index")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_preview_col_starts")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_preview_col_ends")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_preview_col_duration")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_preview_col_data")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {previewItems.map((it) => (
                      <TableRow key={it.originalIndex}>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {it.originalIndex}
                        </TableCell>
                        <TableCell>
                          {it.startsAtDate.toLocaleString(locale)}
                        </TableCell>
                        <TableCell>
                          {it.endsAtDate.toLocaleString(locale)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {formatDuration(it.durationMinutes)}
                        </TableCell>
                        <TableCell>
                          <DataPreview data={it.rawData} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          {/* Per-item BE validation errors */}
          {dryRun.errors.length > 0 && (
            <Card className="border-amber-500/50 bg-amber-50/40 dark:bg-amber-950/20">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold flex items-center gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="h-4 w-4" />
                  {t("reservations:import_errors_title")} ({dryRun.errors.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="text-sm space-y-1 max-h-48 overflow-y-auto">
                  {dryRun.errors.slice(0, 50).map((e) => (
                    <li
                      key={`${e.originalIndex}-${e.message}`}
                      className="font-mono text-xs"
                    >
                      {t("reservations:import_error_item", {
                        index: e.originalIndex,
                        error: e.message,
                      })}
                    </li>
                  ))}
                  {dryRun.errors.length > 50 && (
                    <li className="text-muted-foreground text-xs">
                      … +{dryRun.errors.length - 50} more
                    </li>
                  )}
                </ul>
              </CardContent>
            </Card>
          )}

          {/* Save action */}
          <Card>
            <CardContent className="pt-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-sm text-muted-foreground">
                {validCount === 0
                  ? t("reservations:import_no_valid_items")
                  : t("reservations:import_dialog_description", {
                      count: validCount,
                    })}
              </div>
              <Button
                type="button"
                onClick={handleSave}
                disabled={validCount === 0 || isRunning}
              >
                {isRunning && outcome.status === "running" ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("reservations:import_saving", {
                      done: outcome.done,
                      total: outcome.total,
                    })}
                  </>
                ) : (
                  <>
                    <FileUp className="mr-2 h-4 w-4" />
                    {t("reservations:import_save", { count: validCount })}
                  </>
                )}
              </Button>
            </CardContent>
          </Card>
        </>
      )}

      {/* Persistent result card — stays visible after Save completes */}
      {outcome.status === "saved" && (
        <Card
          className={cn(
            outcome.failed.length === 0
              ? "border-green-500/50 bg-green-50/40 dark:bg-green-950/20"
              : outcome.created > 0
                ? "border-amber-500/50 bg-amber-50/40 dark:bg-amber-950/20"
                : "border-destructive/50 bg-destructive/5",
          )}
          data-testid="import-result-card"
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              {outcome.failed.length === 0 ? (
                <CheckCircle2 className="h-4 w-4 text-green-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-amber-600" />
              )}
              {t("reservations:import_result_title")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              {outcome.failed.length === 0
                ? t("reservations:import_result_saved_all", {
                    count: outcome.created,
                  })
                : outcome.created > 0
                  ? t("reservations:import_result_saved_partial", {
                      created: outcome.created,
                      count: outcome.total,
                      failed: outcome.failed.length,
                    })
                  : t("reservations:import_result_failed_zero", {
                      count: outcome.total,
                      failed: outcome.failed.length,
                    })}
            </p>
            {outcome.failed.length > 0 && (
              <div className="border rounded-md overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-12">
                        {t("reservations:import_result_failed_table_index")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_result_failed_table_starts")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_result_failed_table_ends")}
                      </TableHead>
                      <TableHead>
                        {t("reservations:import_result_failed_table_reason")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {outcome.failed.map((f) => (
                      <TableRow
                        key={`${f.originalIndex}-${f.reason}`}
                        className="text-xs"
                      >
                        <TableCell className="font-mono text-muted-foreground">
                          {f.originalIndex}
                        </TableCell>
                        <TableCell className="font-mono">
                          {f.startsAt ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono">
                          {f.endsAt ?? "—"}
                        </TableCell>
                        <TableCell>{f.reason}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Confirm dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:import_dialog_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dryRun
                ? t("reservations:import_dialog_description", {
                    count: dryRun.valid.length,
                  })
                : t("reservations:import_no_changes")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRunning}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmSave}
              disabled={isRunning}
            >
              {t("reservations:import_save", {
                count: dryRun ? dryRun.valid.length : 0,
              })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
