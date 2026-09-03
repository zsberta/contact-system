// ----------------------------------------------------------------------------
// ReservationCalendarPage — monthly calendar showing every bookable service
// session for the reservation, with lazy day-detail modal and manual booking
// creation surfaced from the selected service session.
// ----------------------------------------------------------------------------

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { ReservationCustomerPicker } from "@/components/reservations/ReservationCustomerPicker";
import { ModifyBookingDialog } from "@/components/reservations/ModifyBookingDialog";
import {
  createReservationCustomer,
  createEnrichedReservationBooking,
  getAdminServiceAvailability,
  getReservationById,
  getReservationCalendarDay,
  getReservationCalendarMonth,
  getReservationServices,
  getReservationWorkers,
  updateReservationBookingStatus,
} from "@/lib/reservations";
import type {
  CalendarBookingSummary,
  CalendarSessionSummary,
  CalendarServiceDetails,
  CalendarSlotSummary,
  ReservationCustomerDTO,
  ReservationCustomerCreateDTO,
  ReservationBookingStatus,
} from "@/types/reservation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  CalendarDays,
  Loader2,
  Plus,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";

// ── helpers ──────────────────────────────────────────────────────────────────

const DAYS_IN_WEEK = 7;
const CELL_H = "min-h-[72px] sm:min-h-[100px] md:min-h-[120px]";

function buildMonthGrid(year: number, month: number): Date[][] {
  const firstOfMonth = new Date(Date.UTC(year, month, 1));
  const startDow = firstOfMonth.getUTCDay(); // 0=Sun..6=Sat
  // Shift to Monday-start: Mon=0, Tue=1, ..., Sun=6
  const mondayOffset = (startDow + 6) % 7;
  const gridStart = new Date(firstOfMonth);
  gridStart.setUTCDate(gridStart.getUTCDate() - mondayOffset);

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

/** Get Monday of the week containing the given date (UTC). */
function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diff = (day + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/** Build 7-day array starting from a Monday. */
function buildWeekDays(monday: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(d.getUTCDate() + i);
    return d;
  });
}

/** Time-based grid constants */
const TIME_GRID_START = 7; // 07:00
const TIME_GRID_END = 21;  // 21:00

function slotKey(slot: CalendarSlotSummary) {
  return `${slot.date}:${slot.serviceId}:${slot.startTime}`;
}

function fmtTime(locale: string, iso: string) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function fmtPrice(price: number | null | undefined, currency: string | null | undefined, locale: string) {
  if (price == null || !Number.isFinite(price) || price < 0) return "—";
  try {
    return new Intl.NumberFormat(locale === "hu" ? "hu-HU" : "en-GB", {
      style: "currency",
      currency: currency || "HUF",
      maximumFractionDigits: 0,
    }).format(price);
  } catch {
    return `${price} ${currency || "HUF"}`;
  }
}

// ── Budapest time helpers ────────────────────────────────────────────────────
const BUDAPEST_TZ = "Europe/Budapest";

/** Check if a UTC ISO timestamp is in the past (Budapest timezone). */
function isPastInBudapest(isoUtc: string): boolean {
  const budapestNow = new Date(new Date().toLocaleString("en-US", { timeZone: BUDAPEST_TZ }));
  const budapestSlot = new Date(new Date(isoUtc).toLocaleString("en-US", { timeZone: BUDAPEST_TZ }));
  return budapestSlot.getTime() <= budapestNow.getTime();
}

// ── calendar slot chip ───────────────────────────────────────────────────────

function CalendarSlotChip({
  slot,
  locale,
}: {
  slot: CalendarSlotSummary;
  locale: string;
}) {
  const title = `${slot.serviceName}\n${slot.seatsTaken}/${slot.capacity}\n${slot.startTime} – ${slot.endTime}`;

  return (
    <div
      className="text-[10px] leading-tight bg-primary/15 text-primary rounded px-1 py-0.5 truncate"
      title={title}
    >
      {slot.seatsTaken}/{slot.capacity}{" "}
      {slot.startTime}–{slot.endTime}
    </div>
  );
}

function DaySession({
  session,
  locale,
  t,
  onCancelBooking,
  onCompleteBooking,
  onNoShowBooking,
  onModifyBooking,
  serviceName,
  service,
}: {
  session: CalendarSessionSummary;
  locale: string;
  t: (key: string) => string;
  onCancelBooking?: (bookingId: number) => void;
  onCompleteBooking?: (bookingId: number) => void;
  onNoShowBooking?: (bookingId: number) => void;
  onModifyBooking?: (bookingId: number, startsAt: string, booking: CalendarBookingSummary, session: CalendarSessionSummary, service: CalendarServiceDetails) => void;
  serviceName?: string;
  service?: CalendarServiceDetails;
}) {
  const workerName = [session.workerFirstName, session.workerLastName]
    .filter(Boolean)
    .join(" ");
  const sessionIsPast = isPastInBudapest(session.startsAt);

  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {serviceName && <p className="text-xs font-semibold text-muted-foreground mb-0.5">{serviceName}</p>}
          <p className="text-sm font-medium leading-tight">
            {session.startTime} – {session.endTime}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {session.seatsTaken}/{session.capacity} {t("reservations:capacity").toLowerCase()}
            {workerName ? ` · ${workerName}` : ""}
          </p>
        </div>
      </div>

      {session.bookings.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("reservations:calendar_no_bookings_this_month")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {session.bookings.map((booking) => {
            const name = [booking.customer.lastName, booking.customer.firstName]
              .filter(Boolean)
              .join(" ");
            const isCancelled = booking.status === "cancelled";
            return (
              <div key={booking.id}>
                <div className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{name || "—"}</p>
                    {(booking.customer.email || booking.customer.phone) && (
                      <p className="text-xs text-muted-foreground truncate">
                        {[booking.customer.email, booking.customer.phone]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 mt-0.5 shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          disabled={isCancelled}
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                            isCancelled
                              ? "border-destructive/30 bg-destructive/10 text-destructive cursor-not-allowed opacity-60"
                              : "cursor-pointer hover:opacity-80 border-transparent"
                          } ${
                            booking.status === "confirmed"
                              ? "bg-primary/15 text-primary"
                              : booking.status === "attended"
                                ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                                : booking.status === "completed"
                                  ? "bg-secondary text-secondary-foreground"
                                  : booking.status === "no_show"
                                    ? "border-border bg-background text-muted-foreground"
                                    : ""
                          }`}
                          title={isCancelled ? t("reservations:booking_action_disabled") : undefined}
                        >
                          {t(`reservations:booking_status_${booking.status}`)}
                        </button>
                      </DropdownMenuTrigger>
                      {!isCancelled && (
                        <DropdownMenuContent align="end">
                          {sessionIsPast ? (
                            <>
                              <DropdownMenuItem onClick={() => onCompleteBooking?.(booking.id)}>
                                {t("reservations:booking_action_attended")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => onNoShowBooking?.(booking.id)}>
                                {t("reservations:booking_action_no_show")}
                              </DropdownMenuItem>
                            </>
                          ) : (
                            <>
                              <DropdownMenuItem onClick={() => onCancelBooking?.(booking.id)}>
                                {t("reservations:booking_action_cancel")}
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => service && onModifyBooking?.(booking.id, session.startsAt, booking, session, service)}>
                                {t("reservations:booking_action_modify")}
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      )}
                    </DropdownMenu>
                  </div>
                </div>
                {isCancelled && booking.cancellationReason && (
                  <p className="text-[11px] text-muted-foreground mt-0.5">{booking.cancellationReason}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── day detail components ────────────────────────────────────────────────────

function DayServiceAccordion({
  service,
  locale,
  expanded,
  onToggle,
  t,
  onCancelBooking,
  onCompleteBooking,
  onNoShowBooking,
  onModifyBooking,
}: {
  service: CalendarServiceDetails;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
  onCancelBooking?: (bookingId: number) => void;
  onCompleteBooking?: (bookingId: number) => void;
  onNoShowBooking?: (bookingId: number) => void;
  onModifyBooking?: (bookingId: number, startsAt: string, booking: CalendarBookingSummary, session: CalendarSessionSummary, service: CalendarServiceDetails) => void;
}) {
  const totalBookings = service.sessions.reduce(
    (sum, session) => sum + session.bookings.length,
    0,
  );
  const seatsTaken = service.sessions.reduce(
    (sum, session) => sum + session.seatsTaken,
    0,
  );
  const capacity = service.sessions.reduce(
    (sum, session) => sum + session.capacity,
    0,
  );

  return (
    <div className="rounded-md border overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
      >
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate">{service.serviceName}</p>
          <p className="text-xs text-muted-foreground">
            {fmtPrice(service.price, null, locale)} · {totalBookings}{" "}
            {t("reservations:customer").toLowerCase()} · {seatsTaken}/{capacity}{" "}
            {t("reservations:capacity").toLowerCase()}
          </p>
        </div>
        <div className="shrink-0 ml-3 text-muted-foreground">
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t bg-muted/20 p-3 space-y-3">
          {service.sessions.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("reservations:calendar_no_bookings_this_month")}
            </p>
          ) : (
            service.sessions.map((session, index) => (
              <DaySession
                key={`${session.startsAt}-${index}`}
                session={session}
                locale={locale}
                t={t}
                onCancelBooking={onCancelBooking}
                onCompleteBooking={onCompleteBooking}
                onNoShowBooking={onNoShowBooking}
                onModifyBooking={onModifyBooking}
                service={service}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── main component ──────────────────────────────────────────────────────────

export default function ReservationCalendarPage() {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();

  // ── localStorage helpers ─────────────────────────────────────────────────
  // Use moduleIdParam (from URL, available on first render) not reservationId (async).
  const calendarStorageKey = moduleIdParam ? `calendar-settings-${moduleIdParam}` : null;
  const readCalendarSettings = () => {
    if (!calendarStorageKey) return null;
    try {
      const raw = localStorage.getItem(calendarStorageKey);
      return raw ? JSON.parse(raw) as { hideEmpty?: boolean; workerFilterId?: number | null; viewMode?: "month" | "week" | "day" } : null;
    } catch {
      return null;
    }
  };

  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());
  const [viewMode, setViewMode] = useState<"month" | "week" | "day">(() => readCalendarSettings()?.viewMode ?? "month");
  const [weekStartDate, setWeekStartDate] = useState(() => getWeekStart(today));
  const [dayDate, setDayDate] = useState(() => new Date(today));

  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);
  const [expandedServiceId, setExpandedServiceId] = useState<number | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createServiceId, setCreateServiceId] = useState<number | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<ReservationCustomerDTO | null>(null);

  // Calendar filters
  const [hideEmpty, setHideEmpty] = useState(() => readCalendarSettings()?.hideEmpty ?? false);
  const [workerFilterId, setWorkerFilterId] = useState<number | null>(() => readCalendarSettings()?.workerFilterId ?? null);

  // Persist calendar settings to localStorage
  useEffect(() => {
    if (!calendarStorageKey) return;
    try {
      localStorage.setItem(calendarStorageKey, JSON.stringify({ hideEmpty, workerFilterId, viewMode }));
    } catch {
      // storage full or unavailable — silent
    }
  }, [calendarStorageKey, hideEmpty, workerFilterId, viewMode]);

  const monthQueryKey = `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}`;
  const monthQuery = useQuery({
    queryKey: ["reservation-calendar-month", reservationId, monthQueryKey, hideEmpty, workerFilterId],
    queryFn: () => getReservationCalendarMonth(reservationId!, monthQueryKey, { hideEmpty, workerId: workerFilterId }),
    enabled: !!reservationId,
  });

  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const servicesQuery = useQuery({
    queryKey: ["reservation-services", reservationId],
    queryFn: () => getReservationServices(reservationId!),
    enabled: !!reservationId,
  });

  const { data: workers } = useQuery({
    queryKey: ["reservation-workers", reservationId],
    queryFn: () => getReservationWorkers(reservationId!),
    enabled: !!reservationId,
  });

  const dayQuery = useQuery({
    queryKey: ["reservation-calendar-day", reservationId, selectedDateStr],
    queryFn: () => getReservationCalendarDay(reservationId!, selectedDateStr!),
    enabled: !!reservationId && dayModalOpen && !!selectedDateStr,
  });

  // Available slots for the selected service and date
  const slotsQuery = useQuery({
    queryKey: ["reservation-service-slots", reservationId, createServiceId, selectedDateStr],
    queryFn: () => getAdminServiceAvailability(reservationId!, createServiceId!, selectedDateStr!, selectedDateStr!),
    enabled: !!reservationId && !!createServiceId && !!selectedDateStr && showCreateForm,
  });

  useEffect(() => {
    setSelectedDateStr(null);
    setExpandedServiceId(null);
    setShowCreateForm(false);
    setCreateServiceId(null);
    setSelectedSlot(null);
    setSelectedCustomer(null);
  }, [monthQueryKey]);

  const slotsByDay = useMemo(() => {
    const map: Record<string, CalendarSlotSummary[]> = {};
    for (const slot of monthQuery.data?.slots ?? []) {
      if (!map[slot.date]) map[slot.date] = [];
      map[slot.date].push(slot);
    }
    return map;
  }, [monthQuery.data]);

  const grid = useMemo(() => buildMonthGrid(year, month), [year, month]);

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

  const prevYear = useCallback(() => setYear((y) => y - 1), []);
  const nextYear = useCallback(() => setYear((y) => y + 1), []);

  const goToToday = useCallback(() => {
    const now = new Date();
    setYear(now.getUTCFullYear());
    setMonth(now.getUTCMonth());
    setWeekStartDate(getWeekStart(now));
    setDayDate(new Date(now));
  }, []);

  // ── week navigation ──────────────────────────────────────────────────────
  const prevWeek = useCallback(() => {
    setWeekStartDate((prev) => {
      const d = new Date(prev);
      d.setUTCDate(d.getUTCDate() - 7);
      return d;
    });
  }, []);

  const nextWeek = useCallback(() => {
    setWeekStartDate((prev) => {
      const d = new Date(prev);
      d.setUTCDate(d.getUTCDate() + 7);
      return d;
    });
  }, []);

  // ── day navigation ──────────────────────────────────────────────────────
  const prevDay = useCallback(() => {
    setDayDate((prev) => {
      const d = new Date(prev);
      d.setUTCDate(d.getUTCDate() - 1);
      return d;
    });
  }, []);

  const nextDay = useCallback(() => {
    setDayDate((prev) => {
      const d = new Date(prev);
      d.setUTCDate(d.getUTCDate() + 1);
      return d;
    });
  }, []);

  // ── week view data (reuse month API, filter to 7 days) ──────────────────
  const weekDays = useMemo(() => buildWeekDays(weekStartDate), [weekStartDate]);

  // Detect if the week spans two months — if so, fetch both.
  const weekMonthKey1 = useMemo(() => {
    const d = weekDays[0];
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }, [weekDays]);
  const weekMonthKey2 = useMemo(() => {
    const d = weekDays[6];
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }, [weekDays]);
  const weekSpansTwoMonths = weekMonthKey1 !== weekMonthKey2;

  const weekMonthQuery1 = useQuery({
    queryKey: ["reservation-calendar-month", reservationId, weekMonthKey1, hideEmpty, workerFilterId],
    queryFn: () => getReservationCalendarMonth(reservationId!, weekMonthKey1, { hideEmpty, workerId: workerFilterId }),
    enabled: !!reservationId && viewMode === "week",
  });
  const weekMonthQuery2 = useQuery({
    queryKey: ["reservation-calendar-month", reservationId, weekMonthKey2, hideEmpty, workerFilterId],
    queryFn: () => getReservationCalendarMonth(reservationId!, weekMonthKey2, { hideEmpty, workerId: workerFilterId }),
    enabled: !!reservationId && viewMode === "week" && weekSpansTwoMonths,
  });

  const weekMonthQueryLoading = weekMonthQuery1.isLoading || (weekSpansTwoMonths && weekMonthQuery2.isLoading);

  const weekSlotsByDay = useMemo(() => {
    const map: Record<string, CalendarSlotSummary[]> = {};
    const weekDateStrs = new Set(weekDays.map(ymd));
    const allSlots = [
      ...(weekMonthQuery1.data?.slots ?? []),
      ...(weekSpansTwoMonths ? (weekMonthQuery2.data?.slots ?? []) : []),
    ];
    for (const slot of allSlots) {
      if (weekDateStrs.has(slot.date)) {
        if (!map[slot.date]) map[slot.date] = [];
        map[slot.date].push(slot);
      }
    }
    return map;
  }, [weekMonthQuery1.data, weekSpansTwoMonths, weekMonthQuery2.data, weekDays]);

  // ── day view data (reuse day API) ──────────────────────────────────────
  const dayDateStr = ymd(dayDate);
  const dayViewQuery = useQuery({
    queryKey: ["reservation-calendar-day", reservationId, dayDateStr],
    queryFn: () => getReservationCalendarDay(reservationId!, dayDateStr),
    enabled: !!reservationId && viewMode === "day",
  });

  // Filter day view by worker
  const dayViewServices = useMemo(() => {
    const all = dayViewQuery.data?.services ?? [];
    if (workerFilterId == null) return all;
    return all
      .map((svc) => ({
        ...svc,
        sessions: svc.sessions.filter((s) => s.workerUserId === workerFilterId),
      }))
      .filter((svc) => svc.sessions.length > 0);
  }, [dayViewQuery.data, workerFilterId]);

  const openDay = useCallback(
    (date: Date) => {
      const isoDate = ymd(date);
      setSelectedDateStr(isoDate);
      setExpandedServiceId(null);
      setShowCreateForm(false);
      setCreateServiceId(null);
      setSelectedSlot(null);
      setSelectedCustomer(null);
      setDayModalOpen(true);
    },
    [],
  );

  const handleServiceToggle = useCallback((serviceId: number) => {
    setExpandedServiceId((current) => (current === serviceId ? null : serviceId));
  }, []);

  const handleStartCreate = useCallback(
    (prefillServiceId?: number | null) => {
      if (prefillServiceId != null) {
        setCreateServiceId(prefillServiceId);
        setSelectedSlot(null);
      }
      setShowCreateForm(true);
    },
    [],
  );

  const createCustomerMutation = useMutation({
    mutationFn: (data: ReservationCustomerCreateDTO) =>
      createReservationCustomer(data),
    onSuccess: (newCustomer: ReservationCustomerDTO) => {
      setSelectedCustomer(newCustomer);
      queryClient.invalidateQueries({ queryKey: ["reservation-customers"] });
    },
    onError: (err: Error) => showError(err.message),
  });

  // ── modify dialog state ───────────────────────────────────────────────────
  const [modifyDialogOpen, setModifyDialogOpen] = useState(false);
  const [modifyData, setModifyData] = useState<{
    booking: CalendarBookingSummary;
    session: CalendarSessionSummary;
    service: CalendarServiceDetails;
  } | null>(null);

  // Helper: invalidate all calendar queries
  const invalidateCalendar = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["reservation-calendar-month", reservationId, monthQueryKey],
    });
    queryClient.invalidateQueries({
      queryKey: ["reservation-calendar-day", reservationId, selectedDateStr],
    });
    queryClient.invalidateQueries({
      queryKey: ["reservation-bookings", reservationId],
    });
  }, [queryClient, reservationId, monthQueryKey, selectedDateStr]);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDateStr || !reservationId || !selectedCustomer || !createServiceId || !selectedSlot) {
        throw new Error("Missing booking data");
      }
      const service = servicesQuery.data?.find((s) => s.id === createServiceId);
      if (!service) {
        throw new Error("Selected service not found");
      }

      return createEnrichedReservationBooking(reservationId, {
        serviceId: service.id,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        customerId: selectedCustomer.id,
        firstName: selectedCustomer.firstName,
        lastName: selectedCustomer.lastName,
        email: selectedCustomer.email,
        phone: selectedCustomer.phone,
      });
    },
    onSuccess: () => {
      showSuccess(t("reservations:calendar_booking_created"));
      invalidateCalendar();
      setShowCreateForm(false);
      setCreateServiceId(null);
      setSelectedSlot(null);
      setSelectedCustomer(null);
    },
    onError: (err: Error) => {
      showError(t("reservations:calendar_booking_failed", { error: err.message }));
    },
  });

  // ── cancel (Lemondás) ────────────────────────────────────────────────────
  const [cancelTargetId, setCancelTargetId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const cancelMutation = useMutation({
    mutationFn: ({ bookingId, reason }: { bookingId: number; reason: string }) =>
      updateReservationBookingStatus(reservationId!, bookingId, {
        status: "cancelled",
        cancellationReason: reason || undefined,
      }),
    onSuccess: () => {
      showSuccess(t("reservations:booking_action_cancel_success"));
      invalidateCalendar();
      setCancelTargetId(null);
      setCancelReason("");
    },
    onError: (err: Error) => {
      showError(err.message || t("reservations:booking_delete_failed"));
    },
  });

  // ── complete (Részt vett) ────────────────────────────────────────────────
  const completeMutation = useMutation({
    mutationFn: (bookingId: number) =>
      updateReservationBookingStatus(reservationId!, bookingId, {
        status: "attended",
      }),
    onSuccess: () => {
      showSuccess(t("reservations:booking_action_attended_success"));
      invalidateCalendar();
    },
    onError: (err: Error) => showError(err.message),
  });

  // ── no-show (Nem jött el) ───────────────────────────────────────────────
  const noShowMutation = useMutation({
    mutationFn: (bookingId: number) =>
      updateReservationBookingStatus(reservationId!, bookingId, {
        status: "no_show",
      }),
    onSuccess: () => {
      showSuccess(t("reservations:booking_action_no_show_success"));
      invalidateCalendar();
    },
    onError: (err: Error) => showError(err.message),
  });

  // ── handlers ──────────────────────────────────────────────────────────────
  const handleCancelBooking = useCallback((bookingId: number) => {
    setCancelTargetId(bookingId);
    setCancelReason("");
  }, []);

  const handleCompleteBooking = useCallback((bookingId: number) => {
    completeMutation.mutate(bookingId);
  }, [completeMutation]);

  const handleNoShowBooking = useCallback((bookingId: number) => {
    noShowMutation.mutate(bookingId);
  }, [noShowMutation]);

  const handleModifyBooking = useCallback((bookingId: number, _sessionStartsAt: string, bookingData: CalendarBookingSummary, sessionData: CalendarSessionSummary, serviceData: CalendarServiceDetails) => {
    setModifyData({ booking: bookingData, session: sessionData, service: serviceData });
    setModifyDialogOpen(true);
  }, []);

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";
  const todayStr = ymd(new Date());
  // Monday-first weekday names: Jan 8 2024 = Monday
  const dayNames = Array.from({ length: DAYS_IN_WEEK }, (_, i) =>
    new Date(Date.UTC(2024, 0, i + 8)).toLocaleDateString(locale, { weekday: "short" }),
  );
  const monthNames =
    locale === "hu"
      ? ["Január", "Február", "Március", "Április", "Május", "Június", "Július", "Augusztus", "Szeptember", "Október", "November", "December"]
      : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  const selectedDayDate = selectedDateStr ? new Date(`${selectedDateStr}T12:00:00Z`) : null;
  const allDayServices = dayQuery.data?.services ?? [];
  const dayServices = workerFilterId != null
    ? allDayServices
        .map((svc) => ({
          ...svc,
          sessions: svc.sessions.filter((s) => s.workerUserId === workerFilterId),
        }))
        .filter((svc) => svc.sessions.length > 0)
    : allDayServices;
  const selectedServiceOptions = (servicesQuery.data ?? []).filter(
    (service) => service.status === "active",
  );
  const selectedCreateService = selectedServiceOptions.find(
    (service) => service.id === createServiceId,
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      <Card className="border-0 lg:border">
        <CardContent className="p-0 lg:p-6 lg:pt-6">
          <div className="flex flex-col gap-2 mb-4">
            {/* Row 1: title + view toggle */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <CalendarDays className="h-5 w-5 text-muted-foreground" />
                <h2 className="text-lg font-bold">{t("reservations:calendar_title")}</h2>
              </div>
              <div className="flex items-center border rounded-md overflow-hidden">
                {(["month", "week", "day"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                      viewMode === mode
                        ? "bg-primary text-primary-foreground"
                        : "bg-background hover:bg-accent text-muted-foreground"
                    }`}
                  >
                    {t(`reservations:calendar_view_${mode}`)}
                  </button>
                ))}
              </div>
            </div>
            {/* Row 2: navigation arrows + date + today */}
            <div className="flex items-center justify-center gap-1">
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={viewMode === "month" ? prevMonth : viewMode === "week" ? prevWeek : prevDay}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {viewMode === "month" && (
                <>
                  <Button variant="outline" size="sm" className="h-8 px-3 font-semibold hidden sm:inline-flex" onClick={prevYear}>
                    {year - 1}
                  </Button>
                  <span className="text-sm font-semibold px-2">
                    {year}. {monthNames[month]}
                  </span>
                  <Button variant="outline" size="sm" className="h-8 px-3 font-semibold hidden sm:inline-flex" onClick={nextYear}>
                    {year + 1}
                  </Button>
                </>
              )}
              {viewMode === "week" && (
                <span className="text-sm font-semibold px-2">
                  {weekStartDate.toLocaleDateString(locale, { month: "short", day: "numeric" })} – {weekDays[6].toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
              {viewMode === "day" && (
                <span className="text-sm font-semibold px-2">
                  {dayDate.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={viewMode === "month" ? nextMonth : viewMode === "week" ? nextWeek : nextDay}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={goToToday}>
                {t("reservations:calendar_today")}
              </Button>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-4 mb-4 text-sm">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideEmpty}
                onChange={(e) => setHideEmpty(e.target.checked)}
                className="rounded border-input"
              />
              {t("reservations:calendar_hide_empty", "Üres időpontok elrejtése")}
            </label>

            <select
              value={workerFilterId ?? ""}
              onChange={(e) => setWorkerFilterId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value="">{t("reservations:calendar_all_workers", "Minden felelős")}</option>
              {workers?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.lastName} {w.firstName}
                </option>
              ))}
            </select>
          </div>

          {/* ═══════════════════ MONTH VIEW ═══════════════════ */}
          {viewMode === "month" && (
            <>
              <div className="grid grid-cols-7 border-b">
                {dayNames.map((name) => (
                  <div key={name} className="text-center text-[10px] sm:text-xs font-medium text-muted-foreground py-1.5 sm:py-2">
                    {name}
                  </div>
                ))}
              </div>

              {monthQuery.isLoading ? (
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
                      const daySlots = slotsByDay[dayStr] ?? [];

                      return (
                        <button
                          key={`${ri}-${ci}`}
                          type="button"
                          onClick={() => openDay(date)}
                          className={`
                            border-b border-r p-0.5 sm:p-1.5 text-left align-top transition-colors
                            hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring
                            ${CELL_H}
                            ${!isCurrentMonth ? "bg-muted/30 text-muted-foreground" : ""}
                            ${isToday ? "ring-2 ring-primary ring-inset" : ""}
                          `}
                        >
                          <span
                            className={`
                              inline-flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 text-[10px] sm:text-xs font-medium rounded-full
                              ${isToday ? "bg-primary text-primary-foreground" : ""}
                            `}
                          >
                            {date.getUTCDate()}
                          </span>

                          <div className="mt-0.5 space-y-0.5">
                            {daySlots.slice(0, 2).map((slot) => (
                              <CalendarSlotChip key={slotKey(slot)} slot={slot} locale={locale} />
                            ))}
                            {daySlots.length > 2 && (
                              <div className="text-[9px] sm:text-[10px] text-muted-foreground">
                                +{daySlots.length - 2}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    }),
                  )}
                </div>
              )}
            </>
          )}

          {/* ═══════════════════ WEEK VIEW ═══════════════════ */}
          {viewMode === "week" && (
            <>
              {/* Day headers */}
              <div className="grid grid-cols-[38px_repeat(7,minmax(0,1fr))] border-b">
                <div /> {/* empty corner for time gutter */}
                {weekDays.map((date) => {
                  const dayStr = ymd(date);
                  const isToday = dayStr === todayStr;
                  return (
                    <div key={dayStr} className="text-center px-0.5 py-1.5 min-w-0">
                      <div className="text-[10px] sm:text-xs text-muted-foreground truncate">
                        {date.toLocaleDateString(locale, { weekday: "short" })}
                      </div>
                      <div className={`inline-flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 text-xs font-medium rounded-full ${isToday ? "bg-primary text-primary-foreground" : ""}`}>
                        {date.getUTCDate()}
                      </div>
                    </div>
                  );
                })}
              </div>

              {weekMonthQueryLoading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t("common:loading")}
                </div>
              ) : (
                <div className="grid grid-cols-[38px_repeat(7,minmax(0,1fr))]">
                  {Array.from({ length: TIME_GRID_END - TIME_GRID_START }, (_, i) => TIME_GRID_START + i).map((hour) => (
                    <Fragment key={hour}>
                      {/* Time label */}
                      <div className="text-[10px] text-muted-foreground text-right pr-1.5 pt-0.5 border-r">
                        {String(hour).padStart(2, "0")}:00
                      </div>
                      {/* Day cells */}
                      {weekDays.map((date) => {
                        const dayStr = ymd(date);
                        const slots = (weekSlotsByDay[dayStr] ?? []).filter((s) => {
                          const h = parseInt(s.startTime.split(":")[0], 10);
                          return h === hour;
                        });
                        return (
                          <div
                            key={`${hour}-${dayStr}`}
                            className="border-b border-r min-h-[2.5rem] p-0.5 min-w-0 overflow-hidden"
                          >
                            {slots.map((slot) => (
                              <button
                                key={slotKey(slot)}
                                type="button"
                                onClick={() => openDay(date)}
                                className="w-full text-left rounded bg-primary/10 text-primary hover:bg-primary/20 px-1 py-0.5 mb-0.5 transition-colors"
                                title={`${slot.serviceName}\n${slot.startTime}–${slot.endTime}\n${slot.seatsTaken}/${slot.capacity}`}
                              >
                                <div className="text-[10px] font-medium leading-tight break-words">
                                  {slot.serviceName}
                                </div>
                                <div className="text-[9px] opacity-70 leading-tight whitespace-nowrap">
                                  {slot.startTime}–{slot.endTime} {slot.seatsTaken}/{slot.capacity}
                                </div>
                              </button>
                            ))}
                          </div>
                        );
                      })}
                    </Fragment>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ═══════════════════ DAY VIEW ═══════════════════ */}
          {viewMode === "day" && (
            <>
              {dayViewQuery.isLoading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  {t("common:loading")}
                </div>
              ) : dayViewServices.length === 0 ? (
                <div className="py-12 text-center text-sm text-muted-foreground">
                  {t("reservations:calendar_no_bookings_this_month")}
                </div>
              ) : (
                <div className="space-y-2 py-2">
                  {dayViewServices.flatMap((service) =>
                    service.sessions.map((session, idx) => (
                      <DaySession
                        key={`${service.serviceId}-${session.startsAt}-${idx}`}
                        session={session}
                        locale={locale}
                        t={t}
                        onCancelBooking={handleCancelBooking}
                        onCompleteBooking={handleCompleteBooking}
                        onNoShowBooking={handleNoShowBooking}
                        onModifyBooking={handleModifyBooking}
                        serviceName={service.serviceName}
                        service={service}
                      />
                    )),
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={dayModalOpen}
        onOpenChange={(open) => {
          if (!open) {
            setDayModalOpen(false);
            setSelectedDateStr(null);
            setShowCreateForm(false);
            setCreateServiceId(null);
            setSelectedCustomer(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 space-y-0 pr-0 sm:pr-6">
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5" />
              {selectedDayDate
                ? selectedDayDate.toLocaleDateString(locale, {
                    weekday: "long",
                    month: "long",
                    day: "numeric",
                    year: "numeric",
                  })
                : null}
            </DialogTitle>
            <Button
              size="sm"
              className="self-start sm:self-auto"
              onClick={() => handleStartCreate(expandedServiceId ?? dayServices[0]?.serviceId ?? null)}
              disabled={showCreateForm}
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("reservations:calendar_add_booking")}
            </Button>
          </DialogHeader>

          <div className="flex items-center gap-2 px-1 pb-1 text-sm">
            <select
              value={workerFilterId ?? ""}
              onChange={(e) => setWorkerFilterId(e.target.value ? Number(e.target.value) : null)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              <option value="">{t("reservations:calendar_all_workers", "Minden felelős")}</option>
              {workers?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.lastName} {w.firstName}
                </option>
              ))}
            </select>
          </div>

          <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-3">
            {showCreateForm && (
              <div className="border rounded-md bg-muted/30 p-4 space-y-3">
                <p className="text-sm font-medium">
                  {t("reservations:calendar_create_booking_title")}
                </p>

                <div className="space-y-1.5">
                  <Label className="text-xs">{t("reservations:service")}</Label>
                  <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={createServiceId ? String(createServiceId) : ""}
                    onChange={(event) => {
                      const value = event.target.value ? Number(event.target.value) : null;
                      setCreateServiceId(value);
                      setSelectedSlot(null);
                    }}
                  >
                    <option value="">{t("reservations:select_service")}</option>
                    {selectedServiceOptions.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name || t("reservations:untitled_service")}
                      </option>
                    ))}
                  </select>
                </div>

                {selectedCreateService && (
                  <p className="text-xs text-muted-foreground">
                    {fmtPrice(selectedCreateService.priceAmount, selectedCreateService.currency, locale)} · {selectedCreateService.durationMinutes} min · {selectedCreateService.capacity} {t("reservations:capacity").toLowerCase()}
                  </p>
                )}

                {reservation && (
                  <ReservationCustomerPicker
                    projectId={reservation.projectId}
                    value={selectedCustomer}
                    onChange={setSelectedCustomer}
                    onCreateNew={(data) =>
                      createCustomerMutation.mutate({
                        ...data,
                        projectId: reservation.projectId,
                      })
                    }
                    disabled={createMutation.isPending}
                  />
                )}

                {/* Slot picker */}
                {slotsQuery.isLoading && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("common:loading")}
                  </div>
                )}
                {slotsQuery.data && (
                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("reservations:calendar_select_slot", "Időpont kiválasztása")}</Label>
                    {slotsQuery.data.slots.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {t("reservations:calendar_no_slots", "Nincs elérhető időpont ezen a napon.")}
                      </p>
                    ) : (
                      <div className="grid grid-cols-3 gap-1.5 max-h-32 overflow-y-auto">
                        {slotsQuery.data.slots.map((slot) => {
                          const isSelected = selectedSlot?.startsAt === slot.startsAt;
                          const isFull = slot.remainingSeats <= 0;
                          return (
                            <button
                              key={slot.startsAt}
                              type="button"
                              disabled={isFull}
                              className={`text-xs px-2 py-1.5 rounded border transition-colors text-center ${
                                isSelected
                                  ? "bg-primary text-primary-foreground border-primary"
                                  : isFull
                                    ? "bg-muted text-muted-foreground border-border opacity-50 cursor-not-allowed"
                                    : "bg-background hover:bg-accent border-border"
                              }`}
                              onClick={() => setSelectedSlot({ startsAt: slot.startsAt, endsAt: slot.endsAt })}
                            >
                              {slot.startTime}–{slot.endTime}
                              <p className={`text-xs mt-1 ${isSelected ? "text-white/80" : "text-muted-foreground"}`}>
                                {slot.remainingSeats} {t("reservations:seats_remaining", "hely")}
                              </p>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex gap-2 justify-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setShowCreateForm(false);
                      setCreateServiceId(null);
                      setSelectedCustomer(null);
                    }}
                    disabled={createMutation.isPending}
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => createMutation.mutate()}
                    disabled={
                      createMutation.isPending ||
                      !selectedSlot ||
                      !selectedCustomer ||
                      !createServiceId
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

            {dayQuery.isLoading && (
              <div className="py-10 flex items-center justify-center text-muted-foreground gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common:loading")}
              </div>
            )}

            {dayQuery.isError && !dayQuery.isLoading && (
              <div className="py-8 text-center text-sm text-destructive space-y-2">
                <p>{(dayQuery.error as Error)?.message || t("common:error")}</p>
                <Button variant="outline" size="sm" onClick={() => dayQuery.refetch()}>
                  {t("common:retry")}
                </Button>
              </div>
            )}

            {!dayQuery.isLoading && !dayQuery.isError && dayServices.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t("reservations:calendar_no_bookings_this_month")}
              </div>
            )}

            {!dayQuery.isLoading && !dayQuery.isError && dayServices.length > 0 && (
              <div className="space-y-2">
                {dayServices.map((service) =>
                  service.sessions.map((session, idx) => (
                    <DaySession
                      key={`${service.serviceId}-${session.startsAt}-${idx}`}
                      session={session}
                      locale={locale}
                      t={t}
                      onCancelBooking={handleCancelBooking}
                      onCompleteBooking={handleCompleteBooking}
                      onNoShowBooking={handleNoShowBooking}
                      onModifyBooking={handleModifyBooking}
                      serviceName={service.serviceName}
                      service={service}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={cancelTargetId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCancelTargetId(null);
            setCancelReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:booking_action_cancel_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reservations:booking_action_cancel_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="py-2">
            <Label htmlFor="cancel-reason">{t("reservations:booking_action_cancel_reason")}</Label>
            <textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t("reservations:booking_action_cancel_reason_placeholder")}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[60px]"
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (cancelTargetId !== null) {
                  cancelMutation.mutate({ bookingId: cancelTargetId, reason: cancelReason });
                }
              }}
              disabled={cancelMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {cancelMutation.isPending
                ? t("reservations:booking_deleting")
                : t("reservations:booking_action_cancel")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {modifyData && (
        <ModifyBookingDialog
          open={modifyDialogOpen}
          onOpenChange={setModifyDialogOpen}
          reservationId={reservationId!}
          booking={modifyData.booking}
          session={modifyData.session}
          service={modifyData.service}
          onModified={() => {
            setModifyDialogOpen(false);
            setModifyData(null);
            invalidateCalendar();
          }}
        />
      )}
    </div>
  );
}
