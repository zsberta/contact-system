// ----------------------------------------------------------------------------
// ReservationBookingDetailModal — centered Dialog showing one booking's
// user-facing data: service, customer, schedule, status, and worker.
// No audit metadata (IP, user-agent, referrer).
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { getReservationBookingById } from "@/lib/reservations";
import type { ReservationBookingDTO } from "@/types/reservation";

interface Props {
  reservationId: number;
  bookingId: number | null;
  open: boolean;
  onClose: () => void;
}

export function ReservationBookingDetailModal({
  reservationId,
  bookingId,
  open,
  onClose,
}: Props) {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";

  const isSameDay = (a: string, b: string) => {
    const da = new Date(a);
    const db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  };

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "numeric", day: "numeric" });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });

  const { data, isLoading, error } = useQuery<ReservationBookingDTO, Error>({
    queryKey: ["reservation-booking", reservationId, bookingId],
    queryFn: () => getReservationBookingById(reservationId, bookingId!),
    enabled: !!bookingId && open,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("reservations:booking_details")}</DialogTitle>
          <DialogDescription>
            {t("reservations:booking_details_help")}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-4">
          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {t("common:operation_failed", { error: error.message })}
            </div>
          )}

          {data && !isLoading && !error && (
            <>
              {/* Service + Worker */}
              {(data.serviceName || data.serviceNameSnapshot) && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("reservations:booking_service")}
                  </p>
                  <p className="text-base font-semibold break-words">
                    {data.serviceName || data.serviceNameSnapshot}
                  </p>
                  {data.workerFirstName || data.workerLastName ? (
                    <p className="text-sm text-muted-foreground">
                      {[data.workerFirstName, data.workerLastName].filter(Boolean).join(" ")}
                    </p>
                  ) : null}
                </div>
              )}

              {/* Customer */}
              {(data.customerName || data.firstName || data.lastName || data.email || data.phone) && (
                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                  <p className="text-sm font-medium text-muted-foreground">
                    {t("reservations:booking_customer")}
                  </p>
                  {(data.customerName || data.firstName || data.lastName) && (
                    <p className="text-base font-semibold break-words">
                      {data.customerName || [data.lastName, data.firstName].filter(Boolean).join(" ")}
                    </p>
                  )}
                  {data.email && (
                    <p className="text-sm text-muted-foreground">{data.email}</p>
                  )}
                  {data.phone && (
                    <p className="text-sm text-muted-foreground">{data.phone}</p>
                  )}
                </div>
              )}

              {/* Reservation schedule */}
              <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("reservations:booking_reservation")}
                </p>
                <div className="text-sm">
                  {isSameDay(data.startsAt, data.endsAt) ? (
                    <>{fmtDate(data.startsAt)} <span className="font-semibold text-foreground">{fmtTime(data.startsAt)} – {fmtTime(data.endsAt)}</span></>
                  ) : (
                    <>{fmtDate(data.startsAt)} <span className="font-semibold text-foreground">{fmtTime(data.startsAt)}</span> – {fmtDate(data.endsAt)} <span className="font-semibold text-foreground">{fmtTime(data.endsAt)}</span></>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    {t("reservations:booking_status")}
                  </span>
                  <Badge
                    variant={
                      data.status === "confirmed" || data.status === "attended" ? "default"
                        : data.status === "cancelled" ? "destructive"
                          : data.status === "no_show" ? "outline"
                            : "secondary"
                    }
                  >
                    {t(`reservations:booking_status_${data.status}`)}
                  </Badge>
                </div>
              </div>

              {/* Cancellation reason */}
              {data.status === "cancelled" && data.cancellationReason && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 space-y-1">
                  <p className="text-sm font-medium text-destructive">
                    {t("reservations:cancellation_reason", "Lemondás oka")}
                  </p>
                  <p className="text-sm">{data.cancellationReason}</p>
                </div>
              )}

            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
