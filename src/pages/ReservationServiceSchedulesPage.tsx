// ----------------------------------------------------------------------------
// ReservationServiceSchedulesPage — availability schedules tab scoped to a
// single service.  Reached from the service edit page via "Időbeosztás" link.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import {
  getReservationById,
  getReservationServiceById,
} from "@/lib/reservations";
import { AvailabilityScheduleTab } from "@/components/reservations/AvailabilityScheduleTab";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ReservationServiceSchedulesPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { serviceId: serviceIdParam, projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    serviceId: string;
    projectId: string;
    moduleId: string;
  }>();
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

  const serviceEditPath = projectIdParam && moduleIdParam
    ? buildWorkspaceModuleChildPath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services", `edit/${serviceId}`)
    : undefined;

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      {serviceEditPath && (
        <Button variant="ghost" size="sm" asChild>
          <Link to={serviceEditPath}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("common:back")}
          </Link>
        </Button>
      )}
      <AvailabilityScheduleTab
        reservationId={reservationId}
        serviceId={serviceId}
        header={
          <h2 className="text-lg font-semibold">
            {service?.name || t("reservations:schedules_tab")}
          </h2>
        }
      />
    </div>
  );
}
