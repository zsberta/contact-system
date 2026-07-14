// SubmissionsCalendarTab — monthly calendar showing all bookings across
// accessible reservations, with custom booking creation via day-click modal.

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  Clock,
  Loader2,
  Plus,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { labelFor, formatValue } from "@/components/submissions/field-labels";
import {
  getSubmissionsCalendar,
  createSubmissionBooking,
} from "@/lib/submissions";
import type {
  ActiveReservationDTO,
  CalendarBookingDTO,
} from "@/types/submissions";

interface Props {
  projectId?: number;
}

// ── helpers ──────────────────────────────────────────────────────────────

const DAYS_IN_WEEK = 7;
const CELL_H = "min-h-[100px] md:min-h-[120px]";

function buildMonthGrid(year: number, month: number): Date[][] {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startDow = firstOfMonth.getUTCDay();
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(gridStart.getUTCDate() - startDow);

  const rows: Date[][] = [];
  const cursor = new Date(gridStart);
  for (let r = 0; r < 6; r++) {
    const row: Date[] = [];
    for (let c = 0; c < DAYS_IN_WEEK; c++) {
      row.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    rows.push(row);
  }
  return rows;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatMonth(year: number, month: number, locale: string): string {
  return new Date(Date.UTC(year, month, 1)).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
  });
}

// ── sub-component: single booking row in the day modal ──────────────────

function BookingRow({
  booking,
  locale,
  t,
}: {
  booking: CalendarBookingDTO;
  locale: string;
  t: (key: string) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const start = new Date(booking.startsAt);
  const end = new Date(booking.endsAt);

  const timeRange = `${start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;

  return (
    <div className="border rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{timeRange}</span>
          {booking.userAgent === "admin-panel" && (
            <Badge variant="secondary" className="text-[10px] shrink-0">
              Admin
            </Badge>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t bg-muted/20">
          {(() => {
            const sameDay =
              start.toISOString().slice(0, 10) ===
              end.toISOString().slice(0, 10);
            return sameDay ? (
              <DetailRow
                label={t("submissions:time_range")}
                value={`${start.toLocaleDateString()} ${start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
              />
            ) : (
              <>
                <DetailRow
                  label={t("submissions:starts_at")}
                  value={start.toLocaleString()}
                />
                <DetailRow
                  label={t("submissions:ends_at")}
                  value={end.toLocaleString()}
                />
              </>
            );
          })()}
          <DetailRow
            label={t("submissions:booked_at")}
            value={new Date(booking.bookedAt).toLocaleString()}
          />
          {booking.data && Object.keys(booking.data).length > 0 && (
            <>
              <Separator className="my-1" />
              <div className="space-y-1.5">
                {Object.entries(booking.data).map(([key, value]) => (
                  <div key={key} className="flex flex-col gap-0.5">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                      {labelFor(key, locale)}
                    </span>
                    <span className="text-sm font-medium break-words">
                      {formatValue(value, locale)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-muted-foreground shrink-0 min-w-[120px]">
        {label}
      </span>
      <span className="font-medium break-words">{value}</span>
    </div>
  );
}

// ── main component ──────────────────────────────────────────────────────

export default function SubmissionsCalendarTab({ projectId }: Props) {
  const { t } = useTranslation(["submissions", "common"]);
  const queryClient = useQueryClient();

  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());

  // Day modal state
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // Create booking form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedReservationId, setSelectedReservationId] = useState<
    number | null
  >(null);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");
  const [comment, setComment] = useState("");

  // Fetch calendar data for the visible window (±7 days around the month).
  const windowStart = useMemo(() => {
    const d = new Date(Date.UTC(year, month, 1));
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString();
  }, [year, month]);

  const windowEnd = useMemo(() => {
    const d = new Date(Date.UTC(year, month + 1, 0));
    d.setUTCDate(d.getUTCDate() + 14);
    return d.toISOString();
  }, [year, month]);

  const { data: calendarData, isLoading } = useQuery({
    queryKey: ["submissions-calendar", projectId, year, month],
    queryFn: () => getSubmissionsCalendar(windowStart, windowEnd, projectId),
    enabled: true,
  });

  const reservations = calendarData?.reservations ?? [];

  const visibleBookings = useMemo(() => {
    const all = calendarData?.bookings ?? [];
    const startMs = new Date(windowStart).getTime();
    const endMs = new Date(windowEnd).getTime();
    return all.filter((b) => {
      const s = new Date(b.startsAt).getTime();
      return s >= startMs && s < endMs;
    });
  }, [calendarData, windowStart, windowEnd]);

  const bookingsByDay = useMemo(() => {
    const map: Record<string, CalendarBookingDTO[]> = {};
    for (const b of visibleBookings) {
      const day = ymd(new Date(b.startsAt));
      if (!map[day]) map[day] = [];
      map[day].push(b);
    }
    return map;
  }, [visibleBookings]);

  const selectedDayBookings = useMemo(() => {
    if (!selectedDate) return [];
    const dayStr = ymd(selectedDate);
    return bookingsByDay[dayStr] ?? [];
  }, [selectedDate, bookingsByDay]);

  const grid = useMemo(() => buildMonthGrid(year, month), [year, month]);

  // ── navigation ───────────────────────────────────────────────────────

  const prevMonth = useCallback(() => {
    setMonth((m) => {
      if (m === 0) {
        setYear((y) => y - 1);
        return 11;
      }
      return m - 1;
    });
  }, []);

  const nextMonth = useCallback(() => {
    setMonth((m) => {
      if (m === 11) {
        setYear((y) => y + 1);
        return 0;
      }
      return m + 1;
    });
  }, []);

  const goToToday = useCallback(() => {
    const now = new Date();
    setYear(now.getUTCFullYear());
    setMonth(now.getUTCMonth());
  }, []);

  // ── day click → open modal ───────────────────────────────────────────

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setShowCreateForm(false);
    setSelectedReservationId(null);
    setStartTime("09:00");
    setEndTime("10:00");
    setComment("");
    setDayModalOpen(true);
  };

  // ── create booking ───────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate || !selectedReservationId) return;
      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      const startDate = new Date(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate(),
        sh,
        sm,
      );
      const endDate = new Date(
        selectedDate.getFullYear(),
        selectedDate.getMonth(),
        selectedDate.getDate(),
        eh,
        em,
      );
      return createSubmissionBooking(
        selectedReservationId,
        startDate.toISOString(),
        endDate.toISOString(),
        comment,
      );
    },
    onSuccess: () => {
      showSuccess(t("submissions:calendar_booking_created"));
      queryClient.invalidateQueries({
        queryKey: ["submissions-calendar", projectId],
      });
      setShowCreateForm(false);
      setSelectedReservationId(null);
      setStartTime("09:00");
      setEndTime("10:00");
      setComment("");
    },
    onError: (err: Error) => {
      showError(
        t("submissions:calendar_booking_failed", { error: err.message }),
      );
    },
  });

  // ── render ────────────────────────────────────────────────────────────

  const locale = navigator.language || "en";
  const monthLabel = formatMonth(year, month, locale);
  const todayStr = ymd(new Date());
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, i + 1)).toLocaleDateString(locale, {
      weekday: "short",
    }),
  );

  return (
    <Card>
      <CardContent className="pt-6">
        {/* Month navigation */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={prevMonth}
              aria-label={t("submissions:calendar_month_prev")}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-lg font-semibold min-w-[140px] sm:min-w-[180px] text-center">
              {monthLabel}
            </h2>
            <Button
              variant="outline"
              size="icon"
              onClick={nextMonth}
              aria-label={t("submissions:calendar_month_next")}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <Button variant="ghost" size="sm" onClick={goToToday}>
            {t("submissions:calendar_today")}
          </Button>
        </div>

        {/* Day-of-week headers */}
        <div className="grid grid-cols-7 border-b">
          {dayNames.map((name) => (
            <div
              key={name}
              className="text-center text-xs font-medium text-muted-foreground py-2"
            >
              {name}
            </div>
          ))}
        </div>

        {/* Calendar grid */}
        {isLoading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            {t("common:loading")}
          </div>
        ) : (
          <div className="grid grid-cols-7">
            {grid.map((row, ri) =>
              row.map((date, ci) => {
                const dayStr = ymd(date);
                const isCurrentMonth = date.getUTCMonth() === month;
                const isToday = dayStr === todayStr;
                const dayBookings = bookingsByDay[dayStr] ?? [];

                return (
                  <button
                    key={`${ri}-${ci}`}
                    type="button"
                    onClick={() => handleDayClick(date)}
                    className={`
                      border-b border-r p-1.5 text-left align-top transition-colors
                      hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                      ${CELL_H}
                      ${!isCurrentMonth ? "bg-muted/30 text-muted-foreground" : ""}
                      ${isToday ? "ring-2 ring-primary ring-inset" : ""}
                    `}
                  >
                    <span
                      className={`
                        inline-flex items-center justify-center w-7 h-7 text-xs font-medium rounded-full
                        ${isToday ? "bg-primary text-primary-foreground" : ""}
                      `}
                    >
                      {date.getUTCDate()}
                    </span>
                    <div className="mt-0.5 space-y-0.5">
                      {dayBookings.slice(0, 3).map((b) => {
                        const start = new Date(b.startsAt);
                        const end = new Date(b.endsAt);
                        return (
                          <div
                            key={b.id}
                            className="text-[10px] leading-tight bg-primary/15 text-primary rounded px-1 py-0.5 truncate"
                            title={`${b.reservationName} ${start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
                          >
                            {start.toLocaleTimeString(locale, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}{" "}
                            –{" "}
                            {end.toLocaleTimeString(locale, {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        );
                      })}
                      {dayBookings.length > 3 && (
                        <div className="text-[10px] text-muted-foreground">
                          +{dayBookings.length - 3}
                        </div>
                      )}
                    </div>
                  </button>
                );
              }),
            )}
          </div>
        )}
      </CardContent>

      {/* ── Day detail modal ────────────────────────────────────────────── */}
      <Dialog
        open={dayModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDayModalOpen(false);
            setSelectedDate(null);
            setShowCreateForm(false);
          }
        }}
      >
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex flex-row items-center justify-between space-y-0 pr-6">
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              {selectedDate &&
                selectedDate.toLocaleDateString(locale, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                  year: "numeric",
                })}
            </DialogTitle>
            <Button
              size="sm"
              onClick={() => {
                setShowCreateForm(true);
                setStartTime("09:00");
                setEndTime("10:00");
              }}
              disabled={showCreateForm || reservations.length === 0}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("submissions:calendar_add_booking")}
            </Button>
          </DialogHeader>

          <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-3">
            {/* Inline create form */}
            {showCreateForm && (
              <div className="border rounded-md bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">
                  {t("submissions:calendar_create_booking_title")}
                </p>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    {t("submissions:calendar_select_reservation")}
                  </Label>
                  <select
                    value={selectedReservationId ?? ""}
                    onChange={(e) =>
                      setSelectedReservationId(
                        e.target.value ? Number(e.target.value) : null,
                      )
                    }
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    <option value="">
                      {t("submissions:calendar_select_reservation")}
                    </option>
                    {reservations.map((r: ActiveReservationDTO) => (
                      <option key={r.id} value={r.id}>
                        {r.projectName} / {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cal-start" className="text-xs">
                      {t("submissions:calendar_start_time")}
                    </Label>
                    <Input
                      id="cal-start"
                      type="time"
                      value={startTime}
                      onChange={(e) => setStartTime(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="cal-end" className="text-xs">
                      {t("submissions:calendar_end_time")}
                    </Label>
                    <Input
                      id="cal-end"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cal-comment" className="text-xs">
                    {t("submissions:comment")}
                  </Label>
                  <textarea
                    id="cal-comment"
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    placeholder={t("submissions:comment_placeholder")}
                    rows={2}
                    className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCreateForm(false)}
                    disabled={createMutation.isPending}
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => createMutation.mutate()}
                    disabled={
                      createMutation.isPending ||
                      !startTime ||
                      !endTime ||
                      !selectedReservationId
                    }
                  >
                    {createMutation.isPending ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        {t("common:saving")}
                      </>
                    ) : (
                      t("submissions:calendar_create_booking_confirm")
                    )}
                  </Button>
                </div>
              </div>
            )}

            {reservations.length === 0 && !showCreateForm && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("submissions:calendar_no_reservations")}
              </div>
            )}

            {/* Bookings list */}
            {selectedDayBookings.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("submissions:calendar_no_bookings")}
              </div>
            ) : (
              selectedDayBookings.map((b) => (
                <BookingRow
                  key={b.id}
                  booking={b}
                  locale={locale}
                  t={t}
                />
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
