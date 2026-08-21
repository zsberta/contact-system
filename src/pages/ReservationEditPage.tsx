// ----------------------------------------------------------------------------
// ReservationEditPage — wraps ReservationForm in edit mode. Mirrors
// FormEditPage structurally. Supports both legacy /reservations/edit/:id
// and workspace /workspace/.../reservation/:moduleId/edit routes.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { showError, showSuccess } from "@/utils/toast";
import type {
  ReservationDTO,
  ReservationUpdateDTO,
} from "@/types/reservation";
import { getReservationById, updateReservation } from "@/lib/reservations";
import { resolveModulePath } from "@/lib/workspace-navigation";
import ReservationForm from "@/components/reservations/ReservationForm";

const ReservationEditPage: React.FC = () => {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const { resourceId } = useModuleResolution();

  // Support both legacy (id param) and workspace (resourceId from module resolution)
  const reservationId = id ? Number.parseInt(id) : (resourceId as number | null);

  const { data: initialData, isLoading, error } = useQuery<ReservationDTO, Error>({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: ReservationUpdateDTO) =>
      updateReservation(reservationId!, data),
    onSuccess: async () => {
      showSuccess(
        t("common:update_success", { item: t("reservations:reservation") }),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["reservations", reservationId] });
      if (initialData?.projectId) {
        const path = await resolveModulePath(initialData.projectId, "reservation");
        if (path) navigate(path);
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">
        {t("reservations:reservation_not_found")}
      </div>
    );
  }

  return (
    <ReservationForm
      mode="edit"
      initialData={initialData}
      isSubmitting={updateMutation.isPending}
      onSubmit={(data: ReservationUpdateDTO) => updateMutation.mutate(data)}
    />
  );
};

export default ReservationEditPage;
