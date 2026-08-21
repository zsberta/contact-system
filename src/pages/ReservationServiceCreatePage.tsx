// ReservationServiceCreatePage — create a new service for a reservation.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { useMutation, useQuery } from "@tanstack/react-query";
import { showError, showSuccess } from "@/utils/toast";
import { ReservationServiceForm } from "@/components/reservations/ReservationServiceForm";
import { createReservationService, getReservationWorkers } from "@/lib/reservations";
import type { ReservationServiceCreateDTO } from "@/types/reservation";
import { buildWorkspaceModulePath } from "@/lib/workspace-navigation";

export default function ReservationServiceCreatePage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();
  const navigate = useNavigate();

  const { data: workers } = useQuery({
    queryKey: ["reservation-workers", reservationId],
    queryFn: () => getReservationWorkers(reservationId),
    enabled: reservationId > 0,
  });

  const createMutation = useMutation({
    mutationFn: (data: ReservationServiceCreateDTO) =>
      createReservationService(reservationId, data),
    onSuccess: () => {
      showSuccess(t("reservations:service_created"));
      if (projectIdParam && moduleIdParam) {
        navigate(buildWorkspaceModulePath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services"));
      }
    },
    onError: (err: Error) => showError(err.message),
  });

  return (
    <div className="max-w-2xl">
      <h1 className="text-xl font-semibold mb-4">{t("reservations:create_service")}</h1>
      <ReservationServiceForm
        workers={workers || []}
        onSubmit={(data) => createMutation.mutate(data as ReservationServiceCreateDTO)}
        onCancel={() => {
          if (projectIdParam && moduleIdParam) {
            navigate(buildWorkspaceModulePath(Number(projectIdParam), "reservation", Number(moduleIdParam), "services"));
          }
        }}
        isSubmitting={createMutation.isPending}
      />
    </div>
  );
}
