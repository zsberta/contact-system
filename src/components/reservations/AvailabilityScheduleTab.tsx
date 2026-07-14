// ----------------------------------------------------------------------------
// AvailabilityScheduleTab — manage recurring time-slot templates for a
// reservation. Defines WHEN the reservation is open for bookings.
//
// Three frequency modes:
//   daily   — same hours every day
//   weekly  — specific hours per weekday (Mon–Sun)
//   monthly — specific hours on a day-of-month (1–31)
//
// Multiple entries per day are allowed (e.g. morning + afternoon shifts).
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Badge } from "@/components/ui/badge";
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  Clock,
  CalendarDays,
  Calendar,
  CalendarRange,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  getAvailabilitySchedules,
  createAvailabilitySchedule,
  updateAvailabilitySchedule,
  deleteAvailabilitySchedule,
} from "@/lib/reservations";
import type {
  AvailabilityScheduleDTO,
  AvailabilityScheduleFrequency,
} from "@/types/reservation";

interface Props {
  reservationId: number;
}

const FREQUENCY_OPTIONS: AvailabilityScheduleFrequency[] = [
  "daily",
  "weekly",
  "monthly",
];

// Day-of-week labels indexed by PostgreSQL DOW (0=Sunday ... 6=Saturday).
const DAY_OF_WEEK_LABELS: Record<number, string> = {
  0: "Vasárnap",
  1: "Hétfő",
  2: "Kedd",
  3: "Szerda",
  4: "Csütörtök",
  5: "Péntek",
  6: "Szombat",
};

const DAY_OF_WEEK_LABELS_EN: Record<number, string> = {
  0: "Sunday",
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
  6: "Saturday",
};

// Display order: Monday first, Sunday last (Hungarian convention).
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function AvailabilityScheduleTab({ reservationId }: Props) {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();
  const isHu = i18n.language?.startsWith("hu");
  const dayLabels = isHu ? DAY_OF_WEEK_LABELS : DAY_OF_WEEK_LABELS_EN;

  // Create form state
  const [frequency, setFrequency] = useState<AvailabilityScheduleFrequency>("daily");
  const [dayOfWeek, setDayOfWeek] = useState<string>("1"); // Monday default
  const [dayOfMonth, setDayOfMonth] = useState<string>("1");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<AvailabilityScheduleDTO | null>(null);

  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<AvailabilityScheduleDTO | null>(null);

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["reservation-availability-schedules", reservationId],
    queryFn: () => getAvailabilitySchedules(reservationId),
    enabled: !!reservationId,
  });

  const resetForm = () => {
    setStartTime("");
    setEndTime("");
    setShowCreateForm(false);
    setEditingSchedule(null);
    setFrequency("daily");
    setDayOfWeek("1");
    setDayOfMonth("1");
  };

  const handleEdit = (schedule: AvailabilityScheduleDTO) => {
    setEditingSchedule(schedule);
    setFrequency(schedule.frequency);
    setDayOfWeek(schedule.dayOfWeek !== null ? String(schedule.dayOfWeek) : "1");
    setDayOfMonth(schedule.dayOfMonth !== null ? String(schedule.dayOfMonth) : "1");
    setStartTime(schedule.startTime);
    setEndTime(schedule.endTime);
    setShowCreateForm(true);
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!startTime || !endTime) {
        throw new Error(t("reservations:schedule_times_required"));
      }
      const payload: {
        frequency: AvailabilityScheduleFrequency;
        dayOfWeek?: number;
        dayOfMonth?: number;
        startTime: string;
        endTime: string;
      } = {
        frequency,
        startTime,
        endTime,
      };
      if (frequency === "weekly") {
        payload.dayOfWeek = parseInt(dayOfWeek, 10);
      } else if (frequency === "monthly") {
        payload.dayOfMonth = parseInt(dayOfMonth, 10);
      }
      return createAvailabilitySchedule(reservationId, payload);
    },
    onSuccess: () => {
      showSuccess(t("reservations:schedule_created"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-availability-schedules", reservationId],
      });
      resetForm();
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingSchedule) return;
      if (!startTime || !endTime) {
        throw new Error(t("reservations:schedule_times_required"));
      }
      const payload: {
        frequency: AvailabilityScheduleFrequency;
        dayOfWeek?: number;
        dayOfMonth?: number;
        startTime: string;
        endTime: string;
      } = {
        frequency,
        startTime,
        endTime,
      };
      if (frequency === "weekly") {
        payload.dayOfWeek = parseInt(dayOfWeek, 10);
      } else if (frequency === "monthly") {
        payload.dayOfMonth = parseInt(dayOfMonth, 10);
      }
      return updateAvailabilitySchedule(reservationId, editingSchedule.id, payload);
    },
    onSuccess: () => {
      showSuccess(t("reservations:schedule_updated"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-availability-schedules", reservationId],
      });
      resetForm();
    },
    onError: (err: Error) => {
      showError(err.message || t("common:operation_failed", { error: err.message }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAvailabilitySchedule(reservationId, deleteTarget!.id),
    onSuccess: () => {
      showSuccess(t("reservations:schedule_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-availability-schedules", reservationId],
      });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  // Group schedules by frequency for display.
  const grouped = {
    daily: (schedules ?? []).filter((s) => s.frequency === "daily"),
    weekly: (schedules ?? []).filter((s) => s.frequency === "weekly"),
    monthly: (schedules ?? []).filter((s) => s.frequency === "monthly"),
  };

  // Sub-group weekly by day_of_week.
  const weeklyByDay = new Map<number, AvailabilityScheduleDTO[]>();
  for (const s of grouped.weekly) {
    const dow = s.dayOfWeek ?? 0;
    if (!weeklyByDay.has(dow)) weeklyByDay.set(dow, []);
    weeklyByDay.get(dow)!.push(s);
  }

  // Sub-group monthly by day_of_month.
  const monthlyByDay = new Map<number, AvailabilityScheduleDTO[]>();
  for (const s of grouped.monthly) {
    const dom = s.dayOfMonth ?? 1;
    if (!monthlyByDay.has(dom)) monthlyByDay.set(dom, []);
    monthlyByDay.get(dom)!.push(s);
  };

  const frequencyIcon = (f: AvailabilityScheduleFrequency) => {
    switch (f) {
      case "daily":
        return <Clock className="h-4 w-4" />;
      case "weekly":
        return <CalendarDays className="h-4 w-4" />;
      case "monthly":
        return <Calendar className="h-4 w-4" />;
    }
  };

  const formatScheduleTime = (s: AvailabilityScheduleDTO) =>
    `${s.startTime} – ${s.endTime}`;

  const renderScheduleRow = (s: AvailabilityScheduleDTO, label?: string) => (
    <div
      key={s.id}
      className="flex items-center justify-between gap-3 p-3 border rounded-md hover:bg-accent/30 transition-colors"
    >
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">{formatScheduleTime(s)}</span>
        {label && (
          <span className="text-xs text-muted-foreground">({label})</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => handleEdit(s)}
          aria-label={t("reservations:schedule_edit")}
          title={t("reservations:schedule_edit")}
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setDeleteTarget(s)}
          aria-label={t("reservations:schedule_delete")}
          title={t("reservations:schedule_delete")}
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );

  return (
    <>
      <div className="space-y-4">
        {/* Add button */}
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              resetForm();
              setShowCreateForm(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" />
            {t("reservations:schedule_add")}
          </Button>
        </div>

        {/* Create form */}
        {showCreateForm && (
          <div className="border rounded-md border-dashed p-4 space-y-4">
            {/* Frequency selector */}
            <div className="space-y-1">
              <Label>{t("reservations:schedule_frequency")}</Label>
              <Select
                value={frequency}
                onValueChange={(v) => setFrequency(v as AvailabilityScheduleFrequency)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCY_OPTIONS.map((f) => (
                    <SelectItem key={f} value={f}>
                      {t(`reservations:schedule_freq_${f}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Day selector — conditional on frequency */}
            {frequency === "weekly" && (
              <div className="space-y-1">
                <Label>{t("reservations:schedule_day_of_week")}</Label>
                <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_DISPLAY_ORDER.map((dow) => (
                      <SelectItem key={dow} value={String(dow)}>
                        {dayLabels[dow]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {frequency === "monthly" && (
              <div className="space-y-1">
                <Label>{t("reservations:schedule_day_of_month")}</Label>
                <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {d}.
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Time range */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("reservations:schedule_start_time")}</Label>
                <Input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("reservations:schedule_end_time")}</Label>
                <Input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                />
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => editingSchedule ? updateMutation.mutate() : createMutation.mutate()}
                disabled={createMutation.isPending || updateMutation.isPending || !startTime || !endTime}
              >
                {(createMutation.isPending || updateMutation.isPending) && (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                )}
                {editingSchedule
                  ? t("reservations:schedule_update_confirm")
                  : t("reservations:schedule_create_confirm")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={resetForm}
              >
                {t("common:cancel")}
              </Button>
            </div>
          </div>
        )}

        {/* Schedules list — grouped by frequency */}
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t("common:loading")}
          </div>
        ) : !schedules || schedules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground gap-2">
            <CalendarRange className="h-8 w-8" />
            <p>{t("reservations:no_schedules")}</p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Daily schedules */}
            {grouped.daily.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {frequencyIcon("daily")}
                  <h3 className="text-sm font-semibold">
                    {t("reservations:schedule_freq_daily")}
                  </h3>
                  <Badge variant="secondary" className="text-xs">
                    {grouped.daily.length}
                  </Badge>
                </div>
                {grouped.daily.map((s) => renderScheduleRow(s))}
              </div>
            )}

            {/* Weekly schedules — grouped by day */}
            {grouped.weekly.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {frequencyIcon("weekly")}
                  <h3 className="text-sm font-semibold">
                    {t("reservations:schedule_freq_weekly")}
                  </h3>
                  <Badge variant="secondary" className="text-xs">
                    {grouped.weekly.length}
                  </Badge>
                </div>
                {Array.from(weeklyByDay.entries())
                  .sort(([a], [b]) => {
                    // Monday-first order: shift so Monday (1) sorts before Sunday (0)
                    const orderA = a === 0 ? 7 : a;
                    const orderB = b === 0 ? 7 : b;
                    return orderA - orderB;
                  })
                  .map(([dow, items]) => (
                    <div key={dow} className="ml-6 space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {dayLabels[dow]}
                      </p>
                      {items.map((s) => renderScheduleRow(s))}
                    </div>
                  ))}
              </div>
            )}

            {/* Monthly schedules — grouped by day */}
            {grouped.monthly.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  {frequencyIcon("monthly")}
                  <h3 className="text-sm font-semibold">
                    {t("reservations:schedule_freq_monthly")}
                  </h3>
                  <Badge variant="secondary" className="text-xs">
                    {grouped.monthly.length}
                  </Badge>
                </div>
                {Array.from(monthlyByDay.entries())
                  .sort(([a], [b]) => a - b)
                  .map(([dom, items]) => (
                    <div key={dom} className="ml-6 space-y-1">
                      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                        {dom}.
                      </p>
                      {items.map((s) => renderScheduleRow(s))}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete confirmation */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:schedule_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reservations:schedule_delete_description")}
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
