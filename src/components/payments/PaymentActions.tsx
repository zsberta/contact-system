import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  MoreVertical,
  Edit,
  Trash2,
  CheckCircle2,
  Ban,
  Eye,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import type { PaymentDTO } from "@/types/payment";
import { deletePayment, updatePayment } from "@/lib/api";
import { showError, showSuccess } from "@/utils/toast";

interface PaymentActionsProps {
  payment: PaymentDTO;
  projectId: number;
}

const PaymentActions = ({ payment, projectId }: PaymentActionsProps) => {
  const { t } = useTranslation(["payments", "common"]);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const isPaid = payment.status === "paid";
  const isCancelled = payment.status === "cancelled";

  const invalidatePayments = () => {
    queryClient.invalidateQueries({
      queryKey: ["payments", "project", projectId],
    });
    queryClient.invalidateQueries({ queryKey: ["payments"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
  };

  const deleteMutation = useMutation({
    mutationFn: () => deletePayment(payment.id),
    onSuccess: () => {
      showSuccess(t("payments:payment_deleted"));
      invalidatePayments();
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const markPaidMutation = useMutation({
    mutationFn: () => updatePayment(payment.id, { status: "paid" }),
    onSuccess: () => {
      showSuccess(t("payments:payment_marked_paid"));
      invalidatePayments();
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const cancelMutation = useMutation({
    mutationFn: () => updatePayment(payment.id, { status: "cancelled" }),
    onSuccess: () => {
      showSuccess(t("payments:payment_cancelled"));
      invalidatePayments();
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleConfirmDelete = async () => {
    await deleteMutation.mutateAsync();
    setIsDeleteDialogOpen(false);
  };

  const handleMarkPaid = () => {
    markPaidMutation.mutate();
  };

  const handleCancel = () => {
    cancelMutation.mutate();
  };

  const deleteButton = (
    <DropdownMenuItem
      onSelect={(e) => {
        if (isPaid) {
          e.preventDefault();
          return;
        }
        setIsDeleteDialogOpen(true);
      }}
      disabled={isPaid}
      className="text-red-600 focus:text-red-600 data-[disabled]:opacity-50"
    >
      <Trash2 className="mr-2 h-4 w-4" />
      {t("payments:delete_payment")}
    </DropdownMenuItem>
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={
              deleteMutation.isPending ||
              markPaidMutation.isPending ||
              cancelMutation.isPending
            }
          >
            <span className="sr-only">{t("common:actions")}</span>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
          {!isPaid && (
            <DropdownMenuItem
              onSelect={handleMarkPaid}
              disabled={markPaidMutation.isPending}
            >
              <CheckCircle2 className="mr-2 h-4 w-4" />
              {t("payments:mark_paid")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onSelect={() =>
              navigate(
                `/projects/${projectId}/payments/${payment.id}/view`,
              )
            }
          >
            <Eye className="mr-2 h-4 w-4" />
            {t("payments:view_payment")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              navigate(
                `/projects/${projectId}/payments/${payment.id}/edit`,
              )
            }
          >
            <Edit className="mr-2 h-4 w-4" />
            {t("payments:edit_payment_action")}
          </DropdownMenuItem>
          {!isPaid && !isCancelled && (
            <DropdownMenuItem
              onSelect={handleCancel}
              disabled={cancelMutation.isPending}
            >
              <Ban className="mr-2 h-4 w-4" />
              {t("payments:cancel_payment")}
            </DropdownMenuItem>
          )}
          {isPaid ? (
            <Tooltip>
              <TooltipTrigger asChild>{deleteButton}</TooltipTrigger>
              <TooltipContent>{t("payments:paid_tooltip")}</TooltipContent>
            </Tooltip>
          ) : (
            deleteButton
          )}
        </DropdownMenuContent>
      </DropdownMenu>

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
              onClick={handleConfirmDelete}
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
    </>
  );
};

export default PaymentActions;