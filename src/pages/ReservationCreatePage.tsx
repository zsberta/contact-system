// ----------------------------------------------------------------------------
// ReservationCreatePage — wraps ReservationForm in create mode, hooks up
// the mutation. Mirrors FormCreatePage.
// ----------------------------------------------------------------------------

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  ReservationCreateDTO,
  ReservationDTO,
} from "@/types/reservation";
import { createReservation } from "@/lib/reservations";
import { resolveModulePath } from "@/lib/workspace-navigation";
import ReservationForm from "@/components/reservations/ReservationForm";

const ReservationCreatePage: React.FC = () => {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdParam = searchParams.get("projectId");
  const initialProjectId =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  const createMutation = useMutation({
    mutationFn: (data: ReservationCreateDTO) => createReservation(data),
    onSuccess: async (data: ReservationDTO) => {
      showSuccess(
        t("common:create_success", { item: t("reservations:reservation") }),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      if (initialProjectId) {
        const path = await resolveModulePath(initialProjectId, "reservation");
        if (path) navigate(path);
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  useEffect(() => {
    /* placeholder for future deep-link enhancement */
  }, [initialProjectId]);

  return (
    <ReservationForm
      mode="create"
      isSubmitting={createMutation.isPending}
      onSubmit={(data: ReservationCreateDTO) => createMutation.mutate(data)}
    />
  );
};

export default ReservationCreatePage;
