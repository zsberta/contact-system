// ----------------------------------------------------------------------------
// ReservationCalendarPage — monthly calendar view showing all bookings for a
// reservation, with manual booking creation by clicking on a day cell.
//
// Day modal: shows all bookings for the clicked day as expandable rows with
// full audit details. A "Create booking" button at the top-right opens an
// inline form for manual booking creation.
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  Globe,
  Monitor,
  User,
  FileText,
  FileUp,
  List,
  Ban,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  getReservationById,
  getReservationBookings,
  createReservationBooking,
} from "@/lib/reservations";
import type { ReservationBookingDTO } from "@/types/reservation";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-accent-foreground";

// ── helpers ──────────────────────────────────────────────────────────────────

const DAYS_IN_WEEK = 7;
const CELL_H = "min-h-[100px] md:min-h-[120px]";

/** Build a grid of Date objects for the month view (6 rows × 7 cols). */
function buildMonthGrid(year: number, month: number): Date[][] {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startDow = firstOfMonth.getUTCDay(); // 0=Sun
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

function maskIpv4(ip: string | null): string {
  if (!ip) return "—";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  return ip;
}

// ── sub-component: single booking row in the day modal ──────────────────────

function BookingRow({
  booking,
  locale,
  t,
}: {
  booking: ReservationBookingDTO;
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
          <DetailRow
            label={t("reservations:booking_starts_at")}
            value={start.toLocaleString()}
          />
          <DetailRow
            label={t("reservations:booking_ends_at")}
            value={end.toLocaleString()}
          />
          <DetailRow
            label={t("reservations:booking_booked_at")}
            value={new Date(booking.bookedAt).toLocaleString()}
          />
          <DetailRow
            label={t("reservations:submission_ip")}
            value={maskIpv4(booking.ipAddress)}
          />
          <DetailRow
            label={t("reservations:submission_user_agent")}
            value={booking.userAgent ?? "—"}
          />
          <DetailRow
            label={t("reservations:submission_referer")}
            value={booking.referer ?? "—"}
          />
          <DetailRow
            label={t("reservations:submission_locale")}
            value={booking.locale ?? "—"}
          />
          {booking.data && Object.keys(booking.data).length > 0 && (
            <>
              <Separator className="my-1" />
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("reservations:booking_data")}
                </p>
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono">
                  <code>{JSON.stringify(booking.data, null, 2)}</code>
                </pre>
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

// ── main component ──────────────────────────────────────────────────────────

export default function ReservationCalendarPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const reservationId = id ? Number.parseInt(id) : null;
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());

  // Day modal state
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);

  // Create booking form state (shown inside day modal)
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("10:00");

  // Fetch reservation metadata.
  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  // Fetch all bookings for the visible window.
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

  const { data: bookingsPage, isLoading: bookingsLoading } = useQuery({
    queryKey: ["reservation-bookings-calendar", reservationId, year, month],
    queryFn: () =>
      getReservationBookings(reservationId!, {
        size: 1000,
        sortField: "startsAt",
        sortOrder: "asc",
      }),
    enabled: !!reservationId,
  });

  const visibleBookings = useMemo(() => {
    const all = bookingsPage?.content ?? [];
    const startMs = new Date(windowStart).getTime();
    const endMs = new Date(windowEnd).getTime();
    return all.filter((b) => {
      const s = new Date(b.startsAt).getTime();
      return s >= startMs && s < endMs;
    });
  }, [bookingsPage, windowStart, windowEnd]);

  const bookingsByDay = useMemo(() => {
    const map: Record<string, ReservationBookingDTO[]> = {};
    for (const b of visibleBookings) {
      const day = ymd(new Date(b.startsAt));
      if (!map[day]) map[day] = [];
      map[day].push(b);
    }
    return map;
  }, [visibleBookings]);

  // Bookings for the currently selected day in the modal.
  const selectedDayBookings = useMemo(() => {
    if (!selectedDate) return [];
    const dayStr = ymd(selectedDate);
    return bookingsByDay[dayStr] ?? [];
  }, [selectedDate, bookingsByDay]);

  const grid = useMemo(() => buildMonthGrid(year, month), [year, month]);

  // ── navigation ───────────────────────────────────────────────────────────

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

  // ── day click → open modal ───────────────────────────────────────────────

  const handleDayClick = (date: Date) => {
    setSelectedDate(date);
    setShowCreateForm(false);
    setStartTime("09:00");
    setEndTime("10:00");
    setDayModalOpen(true);
  };

  // ── create booking ───────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDate || !reservationId) return;
      // Build Date objects in LOCAL time so toISOString() converts to UTC correctly.
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
      return createReservationBooking(
        reservationId,
        startDate.toISOString(),
        endDate.toISOString(),
      );
    },
    onSuccess: () => {
      showSuccess(t("reservations:calendar_booking_created"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings-calendar", reservationId],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      setShowCreateForm(false);
      setStartTime("09:00");
      setEndTime("10:00");
    },
    onError: (err: Error) => {
      showError(
        t("reservations:calendar_booking_failed", { error: err.message }),
      );
    },
  });

  // ── render ────────────────────────────────────────────────────────────────

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  const locale = navigator.language || "en";
  const monthLabel = formatMonth(year, month, locale);
  const todayStr = ymd(new Date());
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    new Date(Date.UTC(2024, 0, i + 1)).toLocaleDateString(locale, {
      weekday: "short",
    }),
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      {/* Tab navigation */}
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

      {/* Header card */}
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-2xl font-bold">
              {t("reservations:calendar_title")}
              {reservation && (
                <span className="text-base font-normal text-muted-foreground ml-2">
                  — {reservation.name}
                </span>
              )}
            </CardTitle>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate(`/reservations/view/${reservationId}`)}
          >
            {t("reservations:back_to_reservations")}
          </Button>
        </CardHeader>
      </Card>

      {/* Calendar card */}
      <Card>
        <CardContent className="pt-6">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                onClick={prevMonth}
                aria-label={t("reservations:calendar_month_prev")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <h2 className="text-lg font-semibold min-w-[180px] text-center">
                {monthLabel}
              </h2>
              <Button
                variant="outline"
                size="icon"
                onClick={nextMonth}
                aria-label={t("reservations:calendar_month_next")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
            <Button variant="ghost" size="sm" onClick={goToToday}>
              {t("reservations:calendar_today")}
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
          {bookingsLoading ? (
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
                              title={`${start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} – ${end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`}
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
      </Card>

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
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
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
            {isAdmin && (
              <Button
                size="sm"
                onClick={() => {
                  setShowCreateForm(true);
                  setStartTime("09:00");
                  setEndTime("10:00");
                }}
                disabled={showCreateForm}
              >
                <Plus className="h-4 w-4 mr-1" />
                {t("reservations:calendar_add_booking")}
              </Button>
            )}
          </DialogHeader>

          <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-3">
            {/* Inline create form */}
            {showCreateForm && (
              <div className="border rounded-md bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">
                  {t("reservations:calendar_create_booking_title")}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cal-start" className="text-xs">
                      {t("reservations:calendar_start_time")}
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
                      {t("reservations:calendar_end_time")}
                    </Label>
                    <Input
                      id="cal-end"
                      type="time"
                      value={endTime}
                      onChange={(e) => setEndTime(e.target.value)}
                    />
                  </div>
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
                      createMutation.isPending || !startTime || !endTime
                    }
                  >
                    {createMutation.isPending ? (
                      <>
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                        {t("common:saving")}
                      </>
                    ) : (
                      t("reservations:calendar_create_booking_confirm")
                    )}
                  </Button>
                </div>
              </div>
            )}

            {/* Bookings list */}
            {selectedDayBookings.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("reservations:calendar_no_bookings_this_month")}
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
    </div>
  );
}
