import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
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
import { Plus, ReceiptText, Wallet } from "lucide-react";
import { getAllPaymentsPaged } from "@/lib/api";
import type { PaymentDTO, PaymentStatus } from "@/types/payment";
import PaymentActions from "@/components/payments/PaymentActions";
import { cn } from "@/lib/utils";

const formatHuf = (amount: number | null): string => {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};

const formatDate = (ymd: string): string => {
  const d = new Date(ymd + "T00:00:00");
  if (Number.isNaN(d.getTime())) return ymd;
  // Forced Hungarian display — never follows the browser locale.
  return d.toLocaleDateString("hu-HU", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
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
}

export function ProjectPayments({ projectId }: ProjectPaymentsProps) {
  const { t } = useTranslation(["payments", "common"]);
  const navigate = useNavigate();

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

  const createHref = `/projects/${projectId}/payments/create`;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <Wallet className="h-5 w-5" />
          {t("payments:payments_section")}
          {payments.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {payments.length}
            </Badge>
          )}
        </CardTitle>
        <Button onClick={() => navigate(createHref)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          {t("payments:create_payment_button")}
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
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <ReceiptText className="h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {t("payments:payments_empty")}
            </p>
            <Button
              onClick={() => navigate(createHref)}
              size="sm"
              variant="outline"
            >
              <Plus className="mr-2 h-4 w-4" />
              {t("payments:create_payment_button")}
            </Button>
          </div>
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
                    <TableCell className="whitespace-nowrap">
                      <span
                        className={cn(
                          "font-medium",
                          p.status === "overdue" && "text-destructive",
                        )}
                      >
                        {formatDate(p.dueDate)}
                      </span>
                      {p.note && (
                        <span className="block text-xs text-muted-foreground truncate max-w-48">
                          {p.note}
                        </span>
                      )}
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
                        ? new Date(p.paidAt).toLocaleDateString("hu-HU", {
                            year: "numeric",
                            month: "2-digit",
                            day: "2-digit",
                          })
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
