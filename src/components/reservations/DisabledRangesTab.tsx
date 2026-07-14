// ----------------------------------------------------------------------------
// DisabledRangesTab — manage date/time blackouts for a reservation.
// Shows auto-generated Hungarian holidays (with individual toggle switches)
// and manually created ranges (with delete buttons).
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { Loader2, Plus, Trash2, Ban, CalendarOff, Pencil } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  getDisabledRanges,
  createDisabledRange,
  deleteDisabledRange,
  toggleDisabledRange,
  updateDisabledRange,
  getReservationById,
  updateReservation,
} from "@/lib/reservations";
import type { ReservationDisabledRangeDTO } from "@/types/reservation";

interface Props {
  reservationId: number;
}

export function DisabledRangesTab({ reservationId }: Props) {
  const { t } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();

  // Create form state
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<ReservationDisabledRangeDTO | null>(null);

  // Edit state
  const [editTarget, setEditTarget] = useState<ReservationDisabledRangeDTO | null>(null);
  const [editStartDate, setEditStartDate] = useState("");
  const [editStartTime, setEditStartTime] = useState("");
  const [editEndDate, setEditEndDate] = useState("");
  const [editEndTime, setEditEndTime] = useState("");
  const [editReason, setEditReason] = useState("");

  // Fetch reservation to get disableHungarianHolidays state
  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId),
    enabled: !!reservationId,
  });

  const { data: ranges, isLoading } = useQuery({
    queryKey: ["reservation-disabled-ranges", reservationId],
    queryFn: () => getDisabledRanges(reservationId),
    enabled: !!reservationId,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!startDate || !endDate) {
        throw new Error(t("reservations:disabled_range_dates_required"));
      }
      // Convert local date+time to UTC ISO. HTML inputs return values in
      // the browser's local timezone, so we must offset to UTC before
      // sending Z-suffixed strings to the API. new Date(str) with no Z
      // parses as local, then .toISOString() emits UTC.
      const startIso = startTime
        ? new Date(`${startDate}T${startTime}:00`).toISOString()
        : new Date(`${startDate}T00:00:00`).toISOString();
      const endIso = endTime
        ? new Date(`${endDate}T${endTime}:00`).toISOString()
        : new Date(`${endDate}T23:59:00`).toISOString();

      return createDisabledRange(reservationId, {
        startsAt: startIso,
        endsAt: endIso,
        reason: reason.trim() || null,
      });
    },
    onSuccess: () => {
      showSuccess(t("reservations:disabled_range_created"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-disabled-ranges", reservationId],
      });
      setStartDate("");
      setStartTime("");
      setEndDate("");
      setEndTime("");
      setReason("");
      setShowCreateForm(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDisabledRange(reservationId, deleteTarget!.id),
    onSuccess: () => {
      showSuccess(t("reservations:disabled_range_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-disabled-ranges", reservationId],
      });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (rangeId: number) => toggleDisabledRange(reservationId, rangeId),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["reservation-disabled-ranges", reservationId],
      });
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  // Master toggle for Hungarian holidays
  const holidayToggleMutation = useMutation({
    mutationFn: async () => {
      const newValue = !reservation?.disableHungarianHolidays;
      return updateReservation(reservationId, {
        disableHungarianHolidays: newValue,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservations", reservationId] });
      queryClient.invalidateQueries({
        queryKey: ["reservation-disabled-ranges", reservationId],
      });
      showSuccess(
        reservation?.disableHungarianHolidays
          ? t("reservations:holidays_disabled")
          : t("reservations:holidays_enabled"),
      );
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  // Edit mutation for manual disabled ranges
  const editMutation = useMutation({
    mutationFn: async () => {
      if (!editTarget || !editStartDate || !editEndDate) {
        throw new Error(t("reservations:disabled_range_dates_required"));
      }
      const startIso = editStartTime
        ? new Date(`${editStartDate}T${editStartTime}:00`).toISOString()
        : new Date(`${editStartDate}T00:00:00`).toISOString();
      const endIso = editEndTime
        ? new Date(`${editEndDate}T${editEndTime}:00`).toISOString()
        : new Date(`${editEndDate}T23:59:00`).toISOString();
      return updateDisabledRange(reservationId, editTarget.id, {
        startsAt: startIso,
        endsAt: endIso,
        reason: editReason.trim() || null,
      });
    },
    onSuccess: () => {
      showSuccess(t("reservations:disabled_range_updated"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-disabled-ranges", reservationId],
      });
      setEditTarget(null);
      setEditStartDate("");
      setEditStartTime("");
      setEditEndDate("");
      setEditEndTime("");
      setEditReason("");
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  const locale = navigator.language || "en";

  const formatRange = (range: ReservationDisabledRangeDTO) => {
    const start = new Date(range.startsAt);
    const end = new Date(range.endsAt);
    // Auto-holidays are always full-day — show date only
    if (range.source === "auto_holiday") {
      return start.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
    }
    // Convert UTC ISO to local browser time for display.
    // The HTML inputs show local time, so the admin expects to see local time here too.
    const startLocal = start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const endLocal = end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const isFullDayStart = startLocal === "00:00";
    const isFullDayEnd = endLocal === "23:59" || endLocal === "00:00";
    const sameDay = start.toDateString() === end.toDateString();

    // Full-day range (no time set) — show date only
    if (isFullDayStart && isFullDayEnd) {
      return start.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" })
        + " – "
        + new Date(range.endsAt).toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
    }

    const dateStr = start.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
    const endDateStr = end.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });

    if (sameDay) {
      return `${dateStr} ${isFullDayStart ? "00:00" : startLocal} – ${isFullDayEnd ? "23:59" : endLocal}`;
    }
    return `${dateStr} ${isFullDayStart ? "" : startLocal} – ${endDateStr} ${isFullDayEnd ? "" : endLocal}`;
  };

  // Split ranges into auto-holidays and manual.
  // When the master toggle is OFF, hide auto-holidays entirely.
  const holidaysEnabled = !!reservation?.disableHungarianHolidays;
  const autoHolidays = holidaysEnabled
    ? (ranges?.filter((r) => r.source === "auto_holiday") ?? [])
    : [];
  const manualRanges = ranges?.filter((r) => r.source !== "auto_holiday") ?? [];

  return (
    <>
      <div className="space-y-4">
        {/* Master toggle for Hungarian holidays */}
        <div className="flex items-center justify-between gap-3 p-3 border rounded-md bg-muted/30">
          <div className="flex items-center gap-2">
            <CalendarOff className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">
              {t("reservations:disable_hungarian_holidays")}
            </span>
          </div>
          <Switch
            checked={!!reservation?.disableHungarianHolidays}
            onCheckedChange={() => holidayToggleMutation.mutate()}
            disabled={holidayToggleMutation.isPending}
            aria-label={t("reservations:disable_hungarian_holidays")}
          />
        </div>

        {/* Auto-generated Hungarian holidays */}
        {autoHolidays.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CalendarOff className="h-4 w-4" />
              {t("reservations:holidays_auto_section")}
            </div>
            <div className="space-y-1">
              {autoHolidays.map((range) => (
                <div
                  key={range.id}
                  className="flex items-center justify-between gap-3 p-3 border rounded-md hover:bg-accent/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <CalendarOff className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium truncate">
                        {t(`reservations:holiday_${range.reason}`, range.reason)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 ml-6 truncate">
                      {formatRange(range)}
                    </p>
                  </div>
                  <Switch
                    checked={range.enabled}
                    onCheckedChange={() => toggleMutation.mutate(range.id)}
                    disabled={toggleMutation.isPending}
                    aria-label={range.reason ?? t("reservations:holidays_auto_toggle")}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Manual ranges */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            {autoHolidays.length > 0 && (
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Ban className="h-4 w-4" />
                {t("reservations:manual_ranges_section")}
              </div>
            )}
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreateForm(!showCreateForm)}
            >
              <Plus className="mr-1 h-4 w-4" />
              {t("reservations:disabled_range_add")}
            </Button>
          </div>

          {/* Create form */}
          {showCreateForm && (
            <div className="border rounded-md border-dashed p-4 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>{t("reservations:disabled_range_start_date")}</Label>
                  <Input
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("reservations:disabled_range_start_time")}</Label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    placeholder={t("reservations:disabled_range_time_optional")}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("reservations:disabled_range_end_date")}</Label>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label>{t("reservations:disabled_range_end_time")}</Label>
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    placeholder={t("reservations:disabled_range_time_optional")}
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
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => createMutation.mutate()}
                  disabled={createMutation.isPending || !startDate || !endDate}
                >
                  {createMutation.isPending && (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  )}
                  {t("reservations:disabled_range_create_confirm")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCreateForm(false)}
                >
                  {t("common:cancel")}
                </Button>
              </div>
            </div>
          )}

          {/* Ranges list */}
          {isLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("common:loading")}
            </div>
          ) : manualRanges.length === 0 && autoHolidays.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
              <Ban className="h-8 w-8" />
              <p>{t("reservations:no_disabled_ranges")}</p>
            </div>
          ) : manualRanges.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">
              {t("reservations:no_manual_ranges")}
            </p>
          ) : (
            <div className="space-y-2">
              {manualRanges.map((range) => (
                <div key={range.id}>
                  {/* Edit form — shown when this range is being edited */}
                  {editTarget?.id === range.id ? (
                    <div className="border rounded-md border-dashed p-4 space-y-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label>{t("reservations:disabled_range_start_date")}</Label>
                          <Input
                            type="date"
                            value={editStartDate}
                            onChange={(e) => setEditStartDate(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>{t("reservations:disabled_range_start_time")}</Label>
                          <Input
                            type="time"
                            value={editStartTime}
                            onChange={(e) => setEditStartTime(e.target.value)}
                            placeholder={t("reservations:disabled_range_time_optional")}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>{t("reservations:disabled_range_end_date")}</Label>
                          <Input
                            type="date"
                            value={editEndDate}
                            onChange={(e) => setEditEndDate(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label>{t("reservations:disabled_range_end_time")}</Label>
                          <Input
                            type="time"
                            value={editEndTime}
                            onChange={(e) => setEditEndTime(e.target.value)}
                            placeholder={t("reservations:disabled_range_time_optional")}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label>{t("reservations:disabled_range_reason")}</Label>
                        <Input
                          value={editReason}
                          onChange={(e) => setEditReason(e.target.value)}
                          placeholder={t("reservations:disabled_range_reason_placeholder")}
                          maxLength={500}
                        />
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => editMutation.mutate()}
                          disabled={editMutation.isPending || !editStartDate || !editEndDate}
                        >
                          {editMutation.isPending && (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                          )}
                          {t("common:save")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditTarget(null)}
                        >
                          {t("common:cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* Range display */
                    <div className="flex items-center justify-between gap-3 p-3 border rounded-md hover:bg-accent/30 transition-colors">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Ban className="h-4 w-4 text-destructive shrink-0" />
                          <span className="text-sm font-medium truncate">
                            {formatRange(range)}
                          </span>
                        </div>
                        {range.reason && (
                          <p className="text-xs text-muted-foreground mt-0.5 ml-6 truncate">
                            {range.reason}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            setEditTarget(range);
                            const s = new Date(range.startsAt);
                            const e = new Date(range.endsAt);
                            // Convert UTC back to local date strings for the HTML inputs
                            setEditStartDate(s.toLocaleDateString('sv-SE')); // 'sv-SE' gives YYYY-MM-DD
                            setEditStartTime(
                              range.startsAt.includes("T00:00:00") ? "" : s.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5),
                            );
                            setEditEndDate(e.toLocaleDateString('sv-SE'));
                            setEditEndTime(
                              range.endsAt.includes("T23:59:00") ? "" : e.toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5),
                            );
                            setEditReason(range.reason ?? "");
                          }}
                          aria-label={t("reservations:disabled_range_edit")}
                          title={t("reservations:disabled_range_edit")}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleteTarget(range)}
                          aria-label={t("reservations:disabled_range_delete")}
                          title={t("reservations:disabled_range_delete")}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:disabled_range_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reservations:disabled_range_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("common:deleting")
                : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
