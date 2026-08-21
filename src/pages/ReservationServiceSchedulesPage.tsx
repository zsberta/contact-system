// ----------------------------------------------------------------------------
// ReservationServiceSchedulesPage — availability schedules tab scoped to a
// single service.  Reached from the service edit page via "Időbeosztás" link.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import {
  getReservationById,
  getReservationServiceById,
} from "@/lib/reservations";
import { AvailabilityScheduleTab } from "@/components/reservations/AvailabilityScheduleTab";

export default function ReservationServiceSchedulesPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { serviceId: serviceIdParam } = useParams<{ serviceId: string }>();
  const serviceId = parseInt(serviceIdParam || "0", 10);

  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const { data: service } = useQuery({
    queryKey: ["reservation-service", reservationId, serviceId],
    queryFn: () => getReservationServiceById(reservationId!, serviceId),
    enabled: !!reservationId && serviceId > 0,
  });

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  if (!serviceId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">
          {service?.name || t("reservations:schedules_tab")}
        </h2>
        {reservation && (
          <p className="text-sm text-muted-foreground">
            {reservation.name}
          </p>
        )}
      </div>
      <AvailabilityScheduleTab reservationId={reservationId} serviceId={serviceId} />
    </div>
  );
}
