import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarClock, User } from "lucide-react";
import type { UpcomingPaymentDTO } from "@/types/payment";

const formatHuf = (amount: number): string => {
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};

interface UpcomingPaymentsProps {
  payments: UpcomingPaymentDTO[];
}

export function UpcomingPayments({ payments }: UpcomingPaymentsProps) {
  const { t } = useTranslation(["dashboard", "common"]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <CalendarClock className="h-5 w-5" />
          {t("dashboard:upcoming_payments")}
        </CardTitle>
        <CardDescription>
          {t("dashboard:upcoming_payments_sub")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("dashboard:upcoming_payments_empty")}
          </p>
        ) : (
          <ul className="space-y-3">
            {payments.map((p) => {
              const variant =
                p.status === "overdue" ? "destructive" : "secondary";
              return (
                <li
                  key={p.paymentId}
                  className="flex items-center justify-between gap-3 p-3 border rounded-md"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/projects/view/${p.projectId}`}
                      className="font-medium hover:underline block truncate"
                    >
                      {p.projectName}
                    </Link>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
                      {p.customerName && (
                        <>
                          <User className="h-3 w-3 flex-shrink-0" />
                          <span className="truncate">{p.customerName}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-1 flex-shrink-0">
                    <span className="font-semibold whitespace-nowrap">
                      {formatHuf(p.amount)}
                    </span>
                    <Badge variant={variant} className="text-xs">
                      {p.status === "overdue"
                        ? t("dashboard:upcoming_payment_overdue", {
                            date: p.dueDate,
                          })
                        : t("dashboard:upcoming_payment_due", {
                            date: p.dueDate,
                          })}
                    </Badge>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default UpcomingPayments;