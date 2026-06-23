import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { showError, showSuccess } from "@/utils/toast";
import type {
  PaymentCreateUpdateDTO,
  PaymentDTO,
} from "@/types/payment";
import { getPaymentById, updatePayment } from "@/lib/api";
import PaymentForm from "@/components/payments/PaymentForm";

const formatHuf = (amount: number | null): string => {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};

const statusBadgeVariant = (
  status: PaymentDTO["status"],
): "default" | "secondary" | "destructive" | "outline" => {
  switch (status) {
    case "paid":
      return "default";
    case "overdue":
      return "destructive";
    case "cancelled":
      return "outline";
    case "pending":
    default:
      return "secondary";
  }
};

const PaymentEditPage: React.FC = () => {
  const { t } = useTranslation(["payments", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id, paymentId } = useParams<{ id: string; paymentId: string }>();
  const projectId = id ? Number.parseInt(id) : null;
  const numericPaymentId = paymentId ? Number.parseInt(paymentId) : null;

  const { data: initialData, isLoading, error } = useQuery<PaymentDTO, Error>({
    queryKey: ["payments", numericPaymentId],
    queryFn: () => getPaymentById(numericPaymentId!),
    enabled: !!numericPaymentId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: Partial<PaymentCreateUpdateDTO>) =>
      updatePayment(numericPaymentId!, data),
    onSuccess: () => {
      showSuccess(t("payments:payment_updated"));
      queryClient.invalidateQueries({
        queryKey: ["payments", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["payments"] });
      queryClient.invalidateQueries({
        queryKey: ["payments", numericPaymentId],
      });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
      if (projectId !== null) {
        navigate(`/projects/view/${projectId}`);
      } else {
        navigate("/projects");
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }

  if (numericPaymentId === null || projectId === null) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">
        {t("payments:payment_not_found")}
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full">
      <div className="max-w-2xl mx-auto w-full">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xl">
              {t("payments:edit_payment")}
            </CardTitle>
            <Badge variant={statusBadgeVariant(initialData.status)}>
              {t(`payments:status_${initialData.status}`)}
            </Badge>
          </CardHeader>
          <CardContent className="pt-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">
                  {t("payments:amount")}
                </p>
                <p className="font-semibold">
                  {formatHuf(initialData.amount)}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">{t("payments:due_date")}</p>
                <p className="font-semibold">{initialData.dueDate}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <PaymentForm
        mode="edit"
        initialData={initialData}
        projectId={projectId}
        isSubmitting={updateMutation.isPending}
        onSubmit={(data) => {
          // BE rejects projectId on PUT (payments belong to one project forever).
          // The form always includes projectId (needed for create), so strip it
          // here for the edit case. The BE already knows the projectId from the URL.
          const { projectId, ...updatePayload } = data;
          void projectId;
          updateMutation.mutate(updatePayload);
        }}
      />
    </div>
  );
};

export default PaymentEditPage;