import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Wallet, Zap } from "lucide-react";
import { generateProjectPayment, getAllPaymentsPaged } from "@/lib/api";
import type { PaymentDTO, PaymentStatus } from "@/types/payment";
import { showError, showSuccess } from "@/utils/toast";
import PaymentActions from "@/components/payments/PaymentActions";

const formatHuf = (amount: number | null): string => {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};

const statusBadgeVariant = (
  status: PaymentStatus,
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

interface ProjectPaymentsProps {
  projectId: number;
  projectPrice: number | null;
}

export function ProjectPayments({
  projectId,
}: ProjectPaymentsProps) {
  const { t } = useTranslation(["payments", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["payments", "project", projectId],
    queryFn: () =>
      getAllPaymentsPaged({
        projectId,
        page: 0,
        size: 100,
        sortField: "dueDate",
        sortOrder: "desc",
      }),
  });

  const payments: PaymentDTO[] = (data?.content ?? []).slice().sort(
    (a, b) => (a.dueDate < b.dueDate ? 1 : a.dueDate > b.dueDate ? -1 : 0),
  );

  // BE returns 201 (new) or 200 (existing) — both share the same response shape.
  // We can't easily tell from the response alone which happened, so use a timing
  // heuristic: if the returned payment's createdAt is within the last 2 seconds
  // it was just created; otherwise it was pre-existing.
  const generateMutation = useMutation({
    mutationFn: () => generateProjectPayment(projectId),
    onSuccess: (payment) => {
      const justCreated =
        Date.now() - new Date(payment.createdAt).getTime() < 2000;
      if (justCreated) {
        showSuccess(t("payments:generate_success"));
      } else {
        showSuccess(t("payments:generate_already_exists"));
      }
      queryClient.invalidateQueries({
        queryKey: ["payments", "project", projectId],
      });
      queryClient.invalidateQueries({ queryKey: ["dashboard", "stats"] });
    },
    onError: (err: Error) => {
      showError(t("payments:generate_failed", { error: err.message }));
    },
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <Wallet className="h-5 w-5" />
          {t("payments:payments_section")}
        </CardTitle>
        <Button
          onClick={() => generateMutation.mutate()}
          disabled={generateMutation.isPending}
          size="sm"
        >
          {generateMutation.isPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("payments:generating")}
            </>
          ) : (
            <>
              <Zap className="mr-2 h-4 w-4" />
              {t("payments:generate_payment")}
            </>
          )}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : payments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("payments:payments_empty")}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              {t("payments:double_click_hint")}
            </p>
            <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("payments:due_date_column")}</TableHead>
                <TableHead className="text-right">
                  {t("payments:amount_column")}
                </TableHead>
                <TableHead>{t("payments:status_column")}</TableHead>
                <TableHead>{t("payments:paid_at_column")}</TableHead>
                <TableHead className="text-right">
                  {t("payments:actions_column")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  onDoubleClick={() =>
                    navigate(`/projects/${projectId}/payments/${p.id}/view`)
                  }
                >
                  <TableCell className="font-medium whitespace-nowrap">
                    {p.dueDate}
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">
                    {formatHuf(p.amount)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusBadgeVariant(p.status)}>
                      {t(`payments:status_${p.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {p.paidAt
                      ? new Date(p.paidAt).toLocaleDateString()
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <PaymentActions payment={p} projectId={projectId} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectPayments;
