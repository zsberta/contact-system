import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Pencil } from "lucide-react";
import { showError } from "@/utils/toast";
import type { PaymentDTO } from "@/types/payment";
import { getPaymentById } from "@/lib/api";
import { PaymentAttachments } from "@/components/payments/PaymentAttachments";

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

const PaymentViewPage: React.FC = () => {
  const { t } = useTranslation(["payments", "common"]);
  const navigate = useNavigate();
  const { id, paymentId } = useParams<{ id: string; paymentId: string }>();
  const projectId = id ? Number.parseInt(id) : null;
  const numericPaymentId = paymentId ? Number.parseInt(paymentId) : null;

  const { data: payment, isLoading, error } = useQuery<PaymentDTO, Error>({
    queryKey: ["payments", numericPaymentId],
    queryFn: () => getPaymentById(numericPaymentId!),
    enabled: !!numericPaymentId,
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
  if (!payment) {
    return (
      <div className="text-center p-8">{t("payments:payment_not_found")}</div>
    );
  }

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: payment.id },
    { label: t("payments:amount"), value: formatHuf(payment.amount) },
    { label: t("payments:due_date"), value: payment.dueDate },
    {
      label: t("payments:status"),
      value: (
        <Badge variant={statusBadgeVariant(payment.status)}>
          {t(`payments:status_${payment.status}`)}
        </Badge>
      ),
    },
    {
      label: t("payments:period"),
      value: payment.period
        ? t(`payments:period_${payment.period}`)
        : "—",
    },
    {
      label: t("payments:created_by_column"),
      value: t(`payments:created_by_${payment.createdBy}`),
    },
    {
      label: t("payments:paid_at_column"),
      value: payment.paidAt
        ? new Date(payment.paidAt).toLocaleDateString()
        : "—",
    },
    {
      label: t("payments:note_column"),
      value: payment.note || "—",
    },
    {
      label: t("common:created_at"),
      value: new Date(payment.createdAt).toLocaleString(),
    },
    {
      label: t("common:updated_at"),
      value: new Date(payment.updatedAt).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-2xl mx-auto space-y-6 w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <CardTitle className="text-2xl font-bold break-words">
              {t("payments:payment_details")}
            </CardTitle>
            <Badge variant={statusBadgeVariant(payment.status)}>
              {t(`payments:status_${payment.status}`)}
            </Badge>
          </div>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate(`/projects/view/${projectId}`)}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("payments:back_to_project")}
            </Button>
            <Button
              onClick={() =>
                navigate(`/projects/${projectId}/payments/${payment.id}/edit`)
              }
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("payments:edit_payment")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {details.map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {item.label}
                </p>
                <div className="text-base font-semibold break-words">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <PaymentAttachments paymentId={numericPaymentId} />
    </div>
  );
};

export default PaymentViewPage;