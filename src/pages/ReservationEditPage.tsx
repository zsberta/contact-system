// ----------------------------------------------------------------------------
// ReservationEditPage — wraps ReservationForm in edit mode. Mirrors
// FormEditPage structurally.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  ReservationDTO,
  ReservationUpdateDTO,
} from "@/types/reservation";
import { getReservationById, updateReservation } from "@/lib/reservations";
import ReservationForm from "@/components/reservations/ReservationForm";

const ReservationEditPage: React.FC = () => {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const reservationId = id ? Number.parseInt(id) : null;

  const { data: initialData, isLoading, error } = useQuery<ReservationDTO, Error>({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: ReservationUpdateDTO) =>
      updateReservation(reservationId!, data),
    onSuccess: () => {
      showSuccess(
        t("common:update_success", { item: t("reservations:reservation") }),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["reservations", reservationId] });
      navigate(`/reservations/view/${reservationId}`);
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
