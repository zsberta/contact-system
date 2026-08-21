// ReservationServiceEditPage — edit an existing service.
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { showError, showSuccess } from "@/utils/toast";
import { ReservationServiceForm } from "@/components/reservations/ReservationServiceForm";
import {
  getReservationServiceById,
  updateReservationService,
  getReservationWorkers,
} from "@/lib/reservations";
import type { ReservationServiceUpdateDTO } from "@/types/reservation";
import { buildWorkspaceModulePath, buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { CalendarClock } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ReservationServiceEditPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { serviceId, projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    serviceId: string;
    projectId: string;
    moduleId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const svcId = parseInt(serviceId || "0", 10);

  const { data: service, isLoading } = useQuery({
    queryKey: ["reservation-service", reservationId, svcId],
    queryFn: () => getReservationServiceById(reservationId, svcId),
    enabled: reservationId > 0 && svcId > 0,
  });

  const { data: workers } = useQuery({
    queryKey: ["reservation-workers", reservationId],
    queryFn: () => getReservationWorkers(reservationId),
    enabled: reservationId > 0,
  });

  const updateMutation = useMutation({
    mutationFn: (data: ReservationServiceUpdateDTO) =>
      updateReservationService(reservationId, svcId, data),
    onSuccess: () => {
      showSuccess(t("reservations:service_updated"));
      if (projectIdParam && moduleIdParam) {
        navigate(buildWorkspaceModulePath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services"));
      }
    },
    onError: (err: Error) => showError(err.message),
  });

  if (isLoading) return <p className="text-muted-foreground">{t("common:loading")}</p>;
  if (!service) return <p>{t("reservations:service_not_found")}</p>;

  const schedulesPath = projectIdParam && moduleIdParam
    ? buildWorkspaceModuleChildPath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services", `${serviceId}/schedules`)
    : undefined;

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">{t("reservations:edit_service")}</h1>
        <Button variant="outline" size="sm" asChild>
          <Link to={schedulesPath}>
            <CalendarClock className="mr-2 h-4 w-4" />
            {t("reservations:schedules_tab")}
          </Link>
        </Button>
      </div>
      <ReservationServiceForm
        service={service}
        workers={workers || []}
        onSubmit={(data) => updateMutation.mutate(data as ReservationServiceUpdateDTO)}
        onCancel={() => {
          if (projectIdParam && moduleIdParam) {
            navigate(buildWorkspaceModulePath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services"));
          }
        }}
        isSubmitting={updateMutation.isPending}
        onImageChange={() => {
          queryClient.invalidateQueries({ queryKey: ["reservation-service", reservationId, svcId] });
        }}
      />
    </div>
  );
}
