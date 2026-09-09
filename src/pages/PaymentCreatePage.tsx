import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type { PaymentCreateUpdateDTO } from "@/types/payment";
import { createPayment } from "@/lib/api";
import PaymentForm from "@/components/payments/PaymentForm";

const PaymentCreatePage: React.FC = () => {
  const { t } = useTranslation(["payments", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const projectId = id ? Number.parseInt(id) : null;

  const createMutation = useMutation({
    // Create mode always emits a full DTO (the form builds amount + dueDate
    // unconditionally); the union type only exists for the edit path.
    mutationFn: (
      data: PaymentCreateUpdateDTO | Partial<PaymentCreateUpdateDTO>,
    ) => createPayment(data as PaymentCreateUpdateDTO),
    onSuccess: (payment) => {
      showSuccess(t("payments:payment_created"));
      queryClient.invalidateQueries({
        queryKey: ["payments", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
      // Land on the new invoice so attachments can be uploaded right away.
      navigate(`/projects/${projectId}/payments/${payment.id}/view`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (projectId === null || Number.isNaN(projectId)) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  return (
    <div className="space-y-6 w-full">
      <PaymentForm
        mode="create"
        projectId={projectId}
        isSubmitting={createMutation.isPending}
        onSubmit={(data) => createMutation.mutate(data)}
      />
    </div>
  );
};

export default PaymentCreatePage;
