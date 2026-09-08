// ----------------------------------------------------------------------------
// ReservationDisabledRangeCreatePage — create or edit a manual blocked range
// (route `blocked/edit/:rangeId` reuses this page in edit mode) plus
// per-service automatic Hungarian-holiday toggles below.
// ----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Loader2, CalendarOff } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModulePath } from "@/lib/workspace-navigation";
import {
  getDisableSettings,
  getReservationById,
  createDisabledRange,
  updateDisabledRange,
  toggleDisabledDate,
} from "@/lib/reservations";

// Hardcoded 2026 days off — exact names and dates as listed, no other year.
// Flipping a row creates/removes a full-day manual range for that date.
const DAYS_OFF_2026: Array<{ name: string; month: number; day: number }> = [
  { name: "Újév", month: 1, day: 1 },
  { name: "Pihenőnap", month: 1, day: 2 },
  { name: "Nemzeti ünnep (Az 1848–49-es forradalom és szabadságharc emléknapja)", month: 3, day: 15 },
  { name: "Nagypéntek", month: 4, day: 3 },
  { name: "Húsvétvasárnap", month: 4, day: 5 },
  { name: "Húsvéthétfő", month: 4, day: 6 },
  { name: "A munka ünnepe", month: 5, day: 1 },
  { name: "Pünkösdvasárnap", month: 5, day: 24 },
  { name: "Pünkösdhétfő", month: 5, day: 25 },
  { name: "Az államalapítás ünnepe", month: 8, day: 20 },
  { name: "Pihenőnap", month: 8, day: 21 },
  { name: "Nemzeti ünnep (Az 1956-os forradalom emléknapja)", month: 10, day: 23 },
  { name: "Mindenszentek", month: 11, day: 1 },
  { name: "Pihenőnap (Szenteste)", month: 12, day: 24 },
  { name: "Karácsony", month: 12, day: 25 },
  { name: "Karácsony másnapja", month: 12, day: 26 },
];
// Budapest weekday name for a 2026 date. Noon UTC always falls inside the
// Budapest day, so the browser timezone cannot shift it.
const huWeekday = (month: number, day: number) =>
  new Date(Date.UTC(2026, month - 1, day, 12)).toLocaleDateString("hu", {
    weekday: "long",
    timeZone: "Europe/Budapest",
  });

// Live auto-format while typing: digits only, grouped as ÉÉÉÉ.HH.NN.
const formatHuDate = (raw: string) => {
  const d = raw.replace(/[^0-9]/g, "").slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
};

// Same time auto-format as the schedule page: digits grouped as ÓÓ:PP.
const formatHuTime = (raw: string) => {
  const d = raw.replace(/[^0-9]/g, "").slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}:${d.slice(2)}` : d;
};

// Strict parse of ÉÉÉÉ.HH.NN — rejects impossible dates (e.g. month 13).
// Returns YYYY-MM-DD or null.
const parseHuDate = (s: string) => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (dt.getFullYear() !== Number(m[1]) || dt.getMonth() !== Number(m[2]) - 1 || dt.getDate() !== Number(m[3])) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
};

// Strict parse of ÓÓ:PP — returns the string itself or null.
const parseHuTime = (s: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return s;
};

// Format an ISO instant as reservation wall-clock parts for the HU inputs.
const isoToHuParts = (iso: string, tz: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(new Date(iso))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return { date: `${parts.year}.${parts.month}.${parts.day}`, time: `${hour}:${parts.minute}` };
};

export default function ReservationDisabledRangeCreatePage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam, rangeId: rangeIdParam } = useParams<{
    projectId: string;
    moduleId: string;
    rangeId: string;
  }>();
  const projectId = Number(projectIdParam);
  const moduleId = Number(moduleIdParam);
  const editRangeId = rangeIdParam ? Number(rangeIdParam) : null;
  const editing = editRangeId !== null && Number.isFinite(editRangeId);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["reservation-disable-settings", reservationId],
    queryFn: () => getDisableSettings(reservationId!),
    enabled: !!reservationId,
  });

  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const services = settings?.services ?? [];
  const editRange = editing
    ? (settings?.disabledRanges ?? []).find((r) => r.id === editRangeId) ?? null
    : null;
  const [selectedServiceIds, setSelectedServiceIds] = useState<number[]>([]);
  // Staged day flips: date -> wanted state. Empty until the user flips a row;
  // applied to the CURRENTLY selected services on save. Cleared after save.
  const [dayOverrides, setDayOverrides] = useState<Record<string, boolean>>({});

  // Custom date range state — Hungarian display format, same approach as the
  // schedule page: plain text inputs auto-formatted while typing, so no
  // browser locale can re-localize them. Dates: ÉÉÉÉ.HH.NN, times: ÓÓ:PP.
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");

  const toggleService = (id: number) =>
    setSelectedServiceIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );

  const allSelected = services.length > 0 && selectedServiceIds.length === services.length;

  // Hardcoded 2026 days off — exact names and dates, no other year shown.
  // Flipping a row creates/removes a full-day manual range for that date
  // (see the day-toggle endpoint); all generic rule-toggle logic is gone.
  const dayIso = (month: number, day: number) =>
    `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const daysOffTz = reservation?.timezone || "Europe/Budapest";

  const huWallParts = (iso: string) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: daysOffTz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
        .formatToParts(new Date(iso))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    return {
      y: Number(parts.year),
      mo: Number(parts.month),
      d: Number(parts.day),
      h: parts.hour === "24" ? 0 : Number(parts.hour),
      mi: Number(parts.minute),
    };
  };

  // A day counts as off when EVERY selected service has a manual range
  // spanning the full day in wall time. Partial ranges don't count.
  // Wall parts are compared as plain numbers, so no timezone math needed.
  const wallMin = (p: { y: number; mo: number; d: number; h: number; mi: number }) =>
    Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) / 60000;

  const isDayOff = (month: number, day: number) => {
    if (selectedServiceIds.length === 0) return false;
    const ranges = settings?.disabledRanges ?? [];
    const dayStart = Date.UTC(2026, month - 1, day) / 60000;
    const dayEnd = dayStart + 24 * 60;
    return selectedServiceIds.every((id) =>
      ranges.some((r) => {
        if (!r.serviceIds.map(Number).includes(id)) return false;
        return wallMin(huWallParts(r.startsAt)) <= dayStart && wallMin(huWallParts(r.endsAt)) >= dayEnd;
      }),
    );
  };
  const [prefilled, setPrefilled] = useState(false);
  useEffect(() => {
    if (!editing || prefilled || !editRange) return;
    const tz = reservation?.timezone || "Europe/Budapest";
    const start = isoToHuParts(editRange.startsAt, tz);
    const end = isoToHuParts(editRange.endsAt, tz);
    setSelectedServiceIds(editRange.serviceIds.map((id) => Number(id)));
    setStartDate(start.date);
    setStartTime(start.time === "00:00" ? "" : start.time);
    setEndDate(end.date);
    setEndTime(end.time === "23:59" ? "" : end.time);
    setReason(editRange.reason ?? "");
    setPrefilled(true);
  }, [editing, prefilled, editRange, reservation?.timezone]);

  const buildManualPayload = () => {
    const startDay = parseHuDate(startDate);
    const endDay = parseHuDate(endDate);
    if (!startDay || !endDay) {
      throw new Error(t("reservations:disabled_range_dates_required"));
    }
    const startT = startTime ? parseHuTime(startTime) : null;
    const endT = endTime ? parseHuTime(endTime) : null;
    if ((startTime && !startT) || (endTime && !endT)) {
      throw new Error(t("reservations:disabled_range_times_invalid"));
    }
    return {
      startsAt: new Date(`${startDay}T${startT ?? "00:00"}:00`).toISOString(),
      endsAt: new Date(`${endDay}T${endT ?? "23:59"}:00`).toISOString(),
      reason: reason.trim() || null,
      serviceIds: selectedServiceIds,
    };
  };

  const overrideCount = Object.keys(dayOverrides).length;
  const manualTouched = !!startDate || !!endDate;

  // One save for everything: the manual range (when dates are filled) plus
  // every staged day flip that still differs, applied to the selected
  // services. Manual save keeps the old flow (toast + back); days-only
  // stays on the page with cleared flips.
  const saveAllMutation = useMutation({
    mutationFn: async () => {
      const jobs: Array<Promise<unknown>> = [];
      let manualSaved = false;
      if (startDate || endDate) {
        const payload = buildManualPayload();
        manualSaved = true;
        jobs.push(
          editing && editRange
            ? updateDisabledRange(reservationId!, editRange.id, payload)
            : createDisabledRange(reservationId!, payload),
        );
      }
      const dayDiffs = DAYS_OFF_2026.filter((d) => {
        const date = dayIso(d.month, d.day);
        return dayOverrides[date] !== undefined && dayOverrides[date] !== isDayOff(d.month, d.day);
      });
      for (const d of dayDiffs) {
        jobs.push(toggleDisabledDate(reservationId!, {
          date: dayIso(d.month, d.day),
          serviceIds: selectedServiceIds,
          enabled: dayOverrides[dayIso(d.month, d.day)],
          reason: d.name,
        }));
      }
      await Promise.all(jobs);
      return { manualSaved, dayCount: dayDiffs.length };
    },
    onSuccess: ({ manualSaved, dayCount }) => {
      setDayOverrides({});
      queryClient.invalidateQueries({ queryKey: ["reservation-disable-settings", reservationId] });
      // onSuccess only runs after EVERY save (manual + all day flips) resolves,
      // so navigating here can never cut a pending write short.
      if (manualSaved) {
        showSuccess(t(editing ? "reservations:disabled_range_updated" : "reservations:disabled_range_created"));
      } else if (dayCount > 0) {
        showSuccess(t("reservations:days_off_saved"));
      }
      goBack();
    },
    onError: (err: Error) => showError(err.message),
  });

  const flipDay = (date: string, displayed: boolean) =>
    setDayOverrides((prev) => ({ ...prev, [date]: !displayed }));


  const goBack = () => {
    navigate(buildWorkspaceModulePath(projectId, "reservation", moduleId, "blocked"));
  };

  if (settingsLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 w-full">
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      </div>
    );
  }

  if (editing && !editRange) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 w-full">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <p className="text-muted-foreground">{t("common:invalid_id")}</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 w-full">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={goBack}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <h2 className="text-lg font-semibold break-words">{t(editing ? "reservations:disabled_range_edit" : "reservations:disabled_range_add")}</h2>
      </div>

      {/* Custom blocked range — applies to all selected services */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("reservations:disabled_ranges_section")}</CardTitle>
          <CardDescription>{t("reservations:range_services_help")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("reservations:range_services")}</Label>
            {services.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("reservations:no_services")}</p>
            ) : (
              <div className="contents">
              <div className="flex flex-wrap gap-2">
                <button
                  key="all"
                  type="button"
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    allSelected
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background hover:bg-accent border-border"
                  }`}
                  onClick={() =>
                    setSelectedServiceIds(allSelected ? [] : services.map((s) => s.id))
                  }
                >
                  {t("reservations:select_all_services")}
                </button>
                {services.map((svc) => {
                  const active = selectedServiceIds.includes(svc.id);
                  return (
                    <button
                      key={svc.id}
                      type="button"
                      aria-pressed={active}
                      className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                        active
                          ? "bg-primary text-primary-foreground border-primary"
                          : "bg-background hover:bg-accent border-border"
                      }`}
                      onClick={() => toggleService(svc.id)}
                    >
                      {svc.name}
                      {svc.workerFirstName && (
                        <span className="text-xs ml-1 opacity-70">
                          ({svc.workerFirstName})
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            <p className="text-xs text-muted-foreground">
              {selectedServiceIds.length === 0
                ? t("reservations:no_services_selected")
                : t("reservations:services_selected", { count: selectedServiceIds.length })}
            </p>
          </div>
            )}
          </div>
          <Separator />
          <p className="text-sm font-medium">{t("reservations:disabled_range_add")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("reservations:disabled_range_start_date")}</Label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="ÉÉÉÉ.HH.NN"
                maxLength={10}
                value={startDate}
                onChange={(e) => setStartDate(formatHuDate(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("reservations:disabled_range_start_time")}</Label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{2}:[0-9]{2}"
                placeholder="HH:MM"
                maxLength={5}
                value={startTime}
                onChange={(e) => setStartTime(formatHuTime(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("reservations:disabled_range_end_date")}</Label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="ÉÉÉÉ.HH.NN"
                maxLength={10}
                value={endDate}
                onChange={(e) => setEndDate(formatHuDate(e.target.value))}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("reservations:disabled_range_end_time")}</Label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]{2}:[0-9]{2}"
                placeholder="HH:MM"
                maxLength={5}
                value={endTime}
                onChange={(e) => setEndTime(formatHuTime(e.target.value))}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>{t("reservations:disabled_range_reason")}</Label>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("reservations:disabled_range_reason_placeholder")}
              maxLength={500}
            />
          </div>
          <Separator />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("reservations:days_off_2026_section")}</p>
            <p className="text-xs text-muted-foreground">{t("reservations:days_off_2026_help")}</p>
          </div>
                <div className="space-y-1">
                  {DAYS_OFF_2026.map((d) => {
                    const date = dayIso(d.month, d.day);
                    const displayed = dayOverrides[date] ?? isDayOff(d.month, d.day);
                    return (
                      <div
                        key={date}
                        className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-accent/20"
                      >
                        <div className="min-w-0">
                          <div className="text-sm">{d.name}</div>
                          <div className="text-xs text-muted-foreground">
                            2026. {String(d.month).padStart(2, "0")}. {String(d.day).padStart(2, "0")}. ({huWeekday(d.month, d.day)})
                          </div>
                        </div>
                        <Switch
                          checked={displayed}
                          onCheckedChange={() => flipDay(date, displayed)}
                          disabled={saveAllMutation.isPending || selectedServiceIds.length === 0}
                          aria-label={`${d.name} 2026. ${d.month}. ${d.day}.`}
                        />
                      </div>
                    );
                  })}
            </div>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button
              onClick={() => saveAllMutation.mutate()}
              disabled={
                saveAllMutation.isPending ||
                selectedServiceIds.length === 0 ||
                (!startDate && !endDate && overrideCount === 0)
              }
            >
              {saveAllMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t(editing ? "common:save" : "reservations:disabled_range_create_confirm")}
            </Button>
            <Button variant="ghost" onClick={goBack}>
              {t("common:cancel")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
