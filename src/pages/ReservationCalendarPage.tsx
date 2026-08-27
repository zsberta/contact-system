// ----------------------------------------------------------------------------
// ReservationCalendarPage — monthly calendar showing every bookable service
// session for the reservation, with lazy day-detail modal and manual booking
// creation surfaced from the selected service session.
// ----------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { ReservationCustomerPicker } from "@/components/reservations/ReservationCustomerPicker";
import {
  createReservationCustomer,
  getAdminServiceAvailability,
  getReservationById,
  getReservationCalendarDay,
  getReservationCalendarMonth,
  getReservationServices,
  getReservationWorkers,
} from "@/lib/reservations";
import type {
  CalendarDayDetailsResponse,
  CalendarSessionSummary,
  CalendarServiceDetails,
  CalendarSlotSummary,
  ReservationCustomerDTO,
  ReservationCustomerCreateDTO,
  ReservationServiceDTO,
} from "@/types/reservation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  Clock,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { createEnrichedReservationBooking, deleteReservationBooking } from "@/lib/reservations";

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

function fmtPrice(price: number, currency: string | null | undefined, locale: string) {
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

// ── calendar slot chip ───────────────────────────────────────────────────────

function CalendarSlotChip({
  slot,
  locale,
}: {
  slot: CalendarSlotSummary;
  locale: string;
}) {
  const title = `${slot.serviceName}\n${slot.workerInitial ? `${slot.workerInitial} · ` : ""}${slot.seatsTaken}/${slot.capacity}\n${slot.startTime} – ${slot.endTime}`;

  return (
    <div
      className="text-[10px] leading-tight bg-primary/15 text-primary rounded px-1 py-0.5 truncate"
      title={title}
    >
      {slot.workerInitial ? (
        <span className="font-semibold">{slot.workerInitial}</span>
      ) : null}{" "}
      {slot.seatsTaken}/{slot.capacity}{" "}
      {slot.startTime}–{slot.endTime}
    </div>
  );
}

// ── day detail components ────────────────────────────────────────────────────

function DaySession({
  session,
  locale,
  t,
  onDeleteBooking,
  serviceName,
}: {
  session: CalendarSessionSummary;
  locale: string;
  t: (key: string) => string;
  onDeleteBooking?: (bookingId: number) => void;
  serviceName?: string;
}) {
  const workerName = [session.workerFirstName, session.workerLastName]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {serviceName && <p className="text-xs font-semibold text-muted-foreground mb-0.5">{serviceName}</p>}
          <p className="text-sm font-medium leading-tight">
            {fmtTime(locale, session.startsAt)} – {fmtTime(locale, session.endsAt)}
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
                    <Badge
                      variant={
                        booking.status === "confirmed"
                          ? "default"
                          : booking.status === "cancelled"
                            ? "destructive"
                            : booking.status === "no_show"
                              ? "outline"
                              : "secondary"
                      }
                      className="text-[10px]"
                    >
                      {t(`reservations:booking_status_${booking.status}`)}
                    </Badge>
                    {onDeleteBooking && booking.status !== "cancelled" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-5 w-5 p-0"
                        onClick={() => onDeleteBooking(booking.id)}
                        aria-label={t("reservations:booking_delete")}
                        title={t("reservations:booking_delete")}
                      >
                        <Trash2 className="h-3 w-3 text-destructive" />
                      </Button>
                    )}
                  </div>
                </div>
                {booking.status === "cancelled" && booking.cancellationReason && (
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

function DayServiceAccordion({
  service,
  locale,
  expanded,
  onToggle,
  t,
  onDeleteBooking,
}: {
  service: CalendarServiceDetails;
  locale: string;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
  onDeleteBooking?: (bookingId: number) => void;
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
                onDeleteBooking={onDeleteBooking}
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

  const today = new Date();
  const [year, setYear] = useState(today.getUTCFullYear());
  const [month, setMonth] = useState(today.getUTCMonth());

  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDateStr, setSelectedDateStr] = useState<string | null>(null);
  const [expandedServiceId, setExpandedServiceId] = useState<number | null>(null);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createServiceId, setCreateServiceId] = useState<number | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<ReservationCustomerDTO | null>(null);

  // Calendar filters
  const [hideEmpty, setHideEmpty] = useState(false);
  const [workerFilterId, setWorkerFilterId] = useState<number | null>(null);

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
  }, []);

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

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDateStr || !reservationId || !selectedCustomer || !createServiceId || !selectedSlot) return;
      const service = servicesQuery.data?.find((s) => s.id === createServiceId);
      if (!service) return;

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
      queryClient.invalidateQueries({
        queryKey: ["reservation-calendar-month", reservationId, monthQueryKey],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-calendar-day", reservationId, selectedDateStr],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      setShowCreateForm(false);
      setCreateServiceId(null);
      setSelectedSlot(null);
      setSelectedCustomer(null);
    },
    onError: (err: Error) => {
      showError(t("reservations:calendar_booking_failed", { error: err.message }));
    },
  });

  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  const deleteBookingMutation = useMutation({
    mutationFn: (bookingId: number) =>
      deleteReservationBooking(reservationId!, bookingId),
    onSuccess: () => {
      showSuccess(t("reservations:booking_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-calendar-month", reservationId, monthQueryKey],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-calendar-day", reservationId, selectedDateStr],
      });
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      setDeleteTargetId(null);
    },
    onError: (err: Error) => {
      showError(err.message || t("reservations:booking_delete_failed"));
    },
  });

  const handleDeleteBooking = useCallback((bookingId: number) => {
    setDeleteTargetId(bookingId);
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
  const dayServices = dayQuery.data?.services ?? [];
  const selectedServiceOptions = (servicesQuery.data ?? []).filter(
    (service) => service.status === "active",
  );
  const selectedCreateService = selectedServiceOptions.find(
    (service) => service.id === createServiceId,
  );

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-5 w-5 text-muted-foreground" />
              <h2 className="text-lg font-bold">{t("reservations:calendar_title")}</h2>
            </div>

            <div className="flex items-center gap-1 flex-wrap justify-center sm:justify-end">
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={prevMonth}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" className="h-8 px-3 font-semibold hidden sm:inline-flex" onClick={prevYear}>
                {year - 1}
              </Button>
              <span className="text-sm font-semibold px-2">
                {year}. {monthNames[month]}
              </span>
              <Button variant="outline" size="sm" className="h-8 px-3 font-semibold hidden sm:inline-flex" onClick={nextYear}>
                {year + 1}
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" onClick={nextMonth}>
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
                      onDeleteBooking={handleDeleteBooking}
                      serviceName={service.serviceName}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:booking_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reservations:booking_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBookingMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTargetId !== null) {
                  deleteBookingMutation.mutate(deleteTargetId);
                }
              }}
              disabled={deleteBookingMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteBookingMutation.isPending
                ? t("reservations:booking_deleting")
                : t("reservations:booking_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
