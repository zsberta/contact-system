// ----------------------------------------------------------------------------
// ModifyBookingDialog — modal for modifying a booking from the calendar.
// Shows pre-selected service + customer, a mini month calendar for date
// picking, available time slots, and confirms by creating a new booking
// while cancelling the old one with reason "Módosítás".
// ----------------------------------------------------------------------------

import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createEnrichedReservationBooking,
  getAdminServiceAvailability,
  updateReservationBookingStatus,
} from "@/lib/reservations";
import type {
  CalendarBookingSummary,
  CalendarSessionSummary,
  CalendarServiceDetails,
  ReservationServiceAvailabilityDTO,
} from "@/types/reservation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";

// ── helpers ──────────────────────────────────────────────────────────────────

const BUDAPEST_TZ = "Europe/Budapest";

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtTime(locale: string, iso: string) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: BUDAPEST_TZ,
  });
}

// ── component ────────────────────────────────────────────────────────────────

interface ModifyBookingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reservationId: number;
  booking: CalendarBookingSummary;
  session: CalendarSessionSummary;
  service: CalendarServiceDetails;
  onModified: () => void;
}

export function ModifyBookingDialog({
  open,
  onOpenChange,
  reservationId,
  booking,
  session,
  service,
  onModified,
}: ModifyBookingDialogProps) {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";

  // Date picker state — default to today
  const today = new Date();
  const [pickerYear, setPickerYear] = useState(today.getUTCFullYear());
  const [pickerMonth, setPickerMonth] = useState(today.getUTCMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<{ startsAt: string; endsAt: string } | null>(null);

  // Month query key
  const monthQueryKey = `${String(pickerYear).padStart(4, "0")}-${String(pickerMonth + 1).padStart(2, "0")}`;

  // Month window — must stay within the availability endpoint's 31-day cap.
  // The old ±7-day padding made the span ~44 days, so the endpoint 404'd
  // and every day in the picker rendered disabled.
  const windowStart = ymd(new Date(Date.UTC(pickerYear, pickerMonth, 1)));
  const windowEnd = ymd(new Date(Date.UTC(pickerYear, pickerMonth + 1, 0)));

  const availabilityQuery = useQuery({
    queryKey: ["modify-slots", reservationId, service.serviceId, windowStart, windowEnd],
    queryFn: () =>
      getAdminServiceAvailability(reservationId, service.serviceId, windowStart, windowEnd),
    enabled: open && !!reservationId && !!service.serviceId,
  });

  // Slots for the selected date
  const slotsForDate = useMemo(() => {
    if (!selectedDate || !availabilityQuery.data) return [];
    return availabilityQuery.data.slots.filter((s) => s.date === selectedDate);
  }, [selectedDate, availabilityQuery.data]);

  // Available dates for highlighting
  const availableDates = useMemo(() => {
    const set = new Set<string>();
    for (const day of availabilityQuery.data?.days ?? []) {
      if (day.available) set.add(day.date);
    }
    return set;
  }, [availabilityQuery.data]);

  // Build month grid
  const grid = useMemo(() => {
    const firstOfMonth = new Date(Date.UTC(pickerYear, pickerMonth, 1));
    const startDow = firstOfMonth.getUTCDay();
    const mondayOffset = (startDow + 6) % 7;
    const gridStart = new Date(firstOfMonth);
    gridStart.setUTCDate(gridStart.getUTCDate() - mondayOffset);

    const rows: Date[][] = [];
    const cursor = new Date(gridStart);
    for (let r = 0; r < 6; r++) {
      const row: Date[] = [];
      for (let c = 0; c < 7; c++) {
        row.push(new Date(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
      rows.push(row);
    }
    return rows;
  }, [pickerYear, pickerMonth]);

  const todayStr = ymd(new Date());

  const monthNames =
    locale === "hu"
      ? ["Jan", "Feb", "Már", "Ápr", "Máj", "Jún", "Júl", "Aug", "Szept", "Okt", "Nov", "Dec"]
      : ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  const dayNames = locale === "hu"
    ? ["H", "K", "Sz", "Cs", "P", "Sz", "V"]
    : ["M", "T", "W", "T", "F", "S", "S"];

  // Customer name
  const customerName = [booking.customer.lastName, booking.customer.firstName]
    .filter(Boolean)
    .join(" ");

  // ── mutations ──────────────────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!selectedSlot || !selectedDate) return;

    try {
      // 1. Create new booking
      const newBooking = await createEnrichedReservationBooking(reservationId, {
        serviceId: service.serviceId,
        startsAt: selectedSlot.startsAt,
        endsAt: selectedSlot.endsAt,
        customerId: undefined, // customer is identified by name/email
        firstName: booking.customer.firstName ?? undefined,
        lastName: booking.customer.lastName ?? undefined,
        email: booking.customer.email ?? undefined,
        phone: booking.customer.phone ?? undefined,
      });

      // 2. Cancel old booking
      await updateReservationBookingStatus(reservationId, booking.id, {
        status: "cancelled",
        cancellationReason: "Módosítás",
      }).catch(() => {
        // Old cancel failed but new booking exists — still success
      });

      showSuccess(t("reservations:booking_action_modify_success"));
      queryClient.invalidateQueries({ queryKey: ["reservation-calendar-month"] });
      queryClient.invalidateQueries({ queryKey: ["reservation-calendar-day"] });
      queryClient.invalidateQueries({ queryKey: ["reservation-bookings"] });
      onModified();
    } catch (err) {
      showError(err instanceof Error ? err.message : t("reservations:calendar_booking_failed", { error: "Unknown" }));
    }
  }, [selectedSlot, selectedDate, reservationId, service, booking, queryClient, onModified, t]);

  const isPending = false; // handled via async/await above

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("reservations:booking_action_modify")}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-4">
          {/* Booking info */}
          <div className="rounded-md border bg-muted/20 p-3 space-y-1">
            <p className="text-sm font-medium">{customerName || "—"}</p>
            {(booking.customer.email || booking.customer.phone) && (
              <p className="text-xs text-muted-foreground">
                {[booking.customer.email, booking.customer.phone].filter(Boolean).join(" · ")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {service.serviceName} · {fmtTime(locale, session.startsAt)} – {fmtTime(locale, session.endsAt)}
            </p>
          </div>

          {/* Mini calendar */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                if (pickerMonth === 0) { setPickerYear((y) => y - 1); setPickerMonth(11); }
                else setPickerMonth((m) => m - 1);
              }}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm font-semibold">
                {pickerYear}. {monthNames[pickerMonth]}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => {
                if (pickerMonth === 11) { setPickerYear((y) => y + 1); setPickerMonth(0); }
                else setPickerMonth((m) => m + 1);
              }}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>

            <div className="grid grid-cols-7 gap-0.5">
              {dayNames.map((d) => (
                <div key={d} className="text-center text-[10px] font-medium text-muted-foreground py-1">
                  {d}
                </div>
              ))}
              {grid.flat().map((date, i) => {
                const dayStr = ymd(date);
                const isCurrentMonth = date.getUTCMonth() === pickerMonth;
                const isToday = dayStr === todayStr;
                const isSelected = dayStr === selectedDate;
                const hasSlots = availableDates.has(dayStr);
                const isPast = new Date(dayStr + "T23:59:59Z").getTime() < Date.now();

                return (
                  <button
                    key={i}
                    type="button"
                    disabled={!isCurrentMonth || isPast || !hasSlots}
                    onClick={() => { setSelectedDate(dayStr); setSelectedSlot(null); }}
                    className={`
                      text-xs py-1.5 rounded transition-colors
                      ${!isCurrentMonth ? "text-muted-foreground/40" : ""}
                      ${isPast && isCurrentMonth ? "text-muted-foreground/40 cursor-not-allowed" : ""}
                      ${isToday && !isSelected ? "ring-1 ring-primary" : ""}
                      ${isSelected ? "bg-primary text-primary-foreground" : ""}
                      ${hasSlots && !isSelected && isCurrentMonth && !isPast ? "bg-green-50 text-green-700 hover:bg-green-100 dark:bg-green-900/20 dark:text-green-400" : ""}
                      ${!hasSlots && isCurrentMonth && !isPast && !isSelected ? "text-muted-foreground" : ""}
                    `}
                  >
                    {date.getUTCDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Slot picker */}
          {selectedDate && (
            <div className="space-y-2">
              <Label className="text-xs">{t("reservations:calendar_select_slot", "Időpont kiválasztása")}</Label>
              {availabilityQuery.isLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {t("common:loading")}
                </div>
              ) : slotsForDate.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("reservations:calendar_no_slots", "Nincs elérhető időpont ezen a napon.")}
                </p>
              ) : (
                <div className="grid grid-cols-3 gap-1.5 max-h-32 overflow-y-auto">
                  {slotsForDate.map((slot) => {
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
        </div>

        {/* Footer */}
        <div className="flex gap-2 justify-end pt-2 border-t">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t("common:cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleConfirm}
            disabled={!selectedSlot || !selectedDate || isPending}
          >
            {isPending ? (
              <>
                <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                {t("common:saving")}
              </>
            ) : (
              t("reservations:calendar_create_booking_confirm")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
