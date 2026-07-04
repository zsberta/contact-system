// ----------------------------------------------------------------------------
// ReservationBookingDetailsSheet — read-only sheet showing one booking's
// audit metadata (start/end/locale/IP/user-agent/referrer/data). Mirrors
// FormSubmissionDetailsSheet structurally.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Clock } from "lucide-react";
import { getReservationBookingById } from "@/lib/reservations";
import type { ReservationBookingDTO } from "@/types/reservation";

interface Props {
  reservationId: number;
  bookingId: number | null;
  open: boolean;
  onClose: () => void;
}

const maskIpv4 = (ip: string | null): string => {
  if (!ip) return "—";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  return ip;
};

export function ReservationBookingDetailsSheet({
  reservationId,
  bookingId,
  open,
  onClose,
}: Props) {
  const { t } = useTranslation(["reservations", "common"]);

  const { data, isLoading, error } = useQuery<ReservationBookingDTO, Error>({
    queryKey: ["reservation-booking", reservationId, bookingId],
    queryFn: () => getReservationBookingById(reservationId, bookingId!),
    enabled: !!bookingId && open,
  });

  const details: Array<{ label: string; value: React.ReactNode }> = data
    ? [
      { label: t("common:id"), value: data.id },
      {
        label: t("reservations:booking_starts_at"),
        value: new Date(data.startsAt).toLocaleString(),
      },
      {
        label: t("reservations:booking_ends_at"),
        value: new Date(data.endsAt).toLocaleString(),
      },
      {
        label: t("reservations:booking_booked_at"),
        value: new Date(data.bookedAt).toLocaleString(),
      },
      {
        label: t("reservations:submission_ip"),
        value: maskIpv4(data.ipAddress),
      },
      {
        label: t("reservations:submission_user_agent"),
        value: data.userAgent ?? "—",
      },
      {
        label: t("reservations:submission_referer"),
        value: data.referer ?? "—",
      },
      { label: t("reservations:submission_locale"), value: data.locale ?? "—" },
    ]
    : [];

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            {t("reservations:booking_details")}
          </SheetTitle>
          <SheetDescription>
            {t("reservations:booking_details_help")}
          </SheetDescription>
        </SheetHeader>
        <Separator className="my-4" />
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            {t("common:operation_failed", {
              error: (error as Error).message,
            })}
          </p>
        ) : data ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              {details.map((item) => (
                <div key={item.label} className="space-y-1">
                  <p className="text-sm font-medium text-muted-foreground">
                    {item.label}
                  </p>
                  <div className="text-base font-semibold break-words">
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
            <Separator />
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                {t("reservations:booking_data")}
              </p>
              {data.data && Object.keys(data.data).length > 0 ? (
                <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs font-mono">
                  <code>{JSON.stringify(data.data, null, 2)}</code>
                </pre>
              ) : (
                <Badge variant="secondary">
                  {t("reservations:booking_data_empty")}
                </Badge>
              )}
            </div>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
