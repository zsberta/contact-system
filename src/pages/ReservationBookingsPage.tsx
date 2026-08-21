// ----------------------------------------------------------------------------
// ReservationBookingsPage — bookings list tab, rendered as a standalone page
// with the same tab nav bar as ReservationViewPage.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { getReservationById } from "@/lib/reservations";
import { ReservationBookingsList } from "@/components/reservations/ReservationBookingsList";

export default function ReservationBookingsPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();

  const { data: reservation, isLoading } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      ) : (
        <ReservationBookingsList reservationId={reservationId} />
      )}
    </div>
  );
}
