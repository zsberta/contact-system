import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Ban, CheckCircle2, Pencil, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { PaymentDTO } from "@/types/payment";
import { deletePayment, getPaymentById, updatePayment } from "@/lib/api";
import { PaymentAttachments } from "@/components/payments/PaymentAttachments";
import { MarkPaidDialog } from "@/components/payments/MarkPaidDialog";

const formatHuf = (amount: number | null): string => {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};
// Forced Hungarian display — never follows the browser locale.
// "YYYY-MM-DD" (wire format) renders as "ÉÉÉÉ.HH.NN".
const formatYmdHu = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : ymd;
};

const formatDateHu = (d: Date): string =>
  d.toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

const formatDateTimeHu = (d: Date): string =>
  d.toLocaleString("hu-HU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

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
  const queryClient = useQueryClient();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isMarkPaidOpen, setIsMarkPaidOpen] = useState(false);

  const isPaid = payment?.status === "paid";
  const isCancelled = payment?.status === "cancelled";

  const invalidatePayment = () => {
    queryClient.invalidateQueries({ queryKey: ["payments", numericPaymentId] });
    queryClient.invalidateQueries({
      queryKey: ["payments", "project", projectId],
    });
    queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
  };

  const markPaidMutation = useMutation({
    mutationFn: (paidAtIso: string) =>
      updatePayment(numericPaymentId!, { status: "paid", paidAt: paidAtIso }),
    onSuccess: () => {
      showSuccess(t("payments:payment_marked_paid"));
      setIsMarkPaidOpen(false);
      invalidatePayment();
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => updatePayment(numericPaymentId!, { status: "cancelled" }),
    onSuccess: () => {
      showSuccess(t("payments:payment_cancelled"));
      invalidatePayment();
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deletePayment(numericPaymentId!),
    onSuccess: () => {
      showSuccess(t("payments:payment_deleted"));
      invalidatePayment();
      navigate(`/projects/view/${projectId}`);
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
  if (!payment) {
    return (
      <div className="text-center p-8">{t("payments:payment_not_found")}</div>
    );
  }

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: payment.id },
    { label: t("payments:amount"), value: formatHuf(payment.amount) },
    { label: t("payments:due_date"), value: formatYmdHu(payment.dueDate) },
    {
      label: t("payments:status"),
      value: (
        <Badge variant={statusBadgeVariant(payment.status)}>
          {t(`payments:status_${payment.status}`)}
        </Badge>
      ),
    },
    {
      label: t("payments:paid_at_column"),
      value: payment.paidAt ? formatDateHu(new Date(payment.paidAt)) : "—",
    },
    {
      label: t("payments:note_column"),
      value: payment.note || "—",
    },
    {
      label: t("common:created_at"),
      value: formatDateTimeHu(new Date(payment.createdAt)),
    },
    {
      label: t("common:updated_at"),
      value: formatDateTimeHu(new Date(payment.updatedAt)),
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
          <div className="flex flex-col sm:flex-row sm:flex-wrap gap-2 w-full sm:w-auto">
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
            {!isPaid && (
              <Button
                onClick={() => setIsMarkPaidOpen(true)}
                disabled={markPaidMutation.isPending}
                variant="secondary"
                className="w-full sm:w-auto"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                {t("payments:mark_paid")}
              </Button>
            )}
            {!isPaid && !isCancelled && (
              <Button
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                variant="outline"
                className="w-full sm:w-auto"
              >
                <Ban className="mr-2 h-4 w-4" />
                {t("payments:cancel_payment")}
              </Button>
            )}
            {!isPaid && (
              <Button
                onClick={() => setIsDeleteDialogOpen(true)}
                disabled={deleteMutation.isPending}
                variant="destructive"
                className="w-full sm:w-auto"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t("payments:delete_payment")}
              </Button>
            )}
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
      <MarkPaidDialog
        open={isMarkPaidOpen}
        onOpenChange={setIsMarkPaidOpen}
        isPending={markPaidMutation.isPending}
        onConfirm={(paidAtIso) => markPaidMutation.mutate(paidAtIso)}
      />
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("payments:confirm_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("payments:confirm_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("common:deleting")
                : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default PaymentViewPage;