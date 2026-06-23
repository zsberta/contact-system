import { useAuth } from "@/context/AuthContext";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getDashboardStats } from "@/lib/api";
import { KpiCards } from "@/components/dashboard/KpiCards";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { StatusBreakdown } from "@/components/dashboard/StatusBreakdown";
import { UpcomingPayments } from "@/components/dashboard/UpcomingPayments";

const EMPTY_STATS = {
  revenue30d: 0,
  revenue90d: 0,
  revenue365d: 0,
  outstanding: 0,
  counts: { pending: 0, overdue: 0, paid: 0, cancelled: 0 },
  monthlyRevenue: [] as Array<{ month: string; amount: number }>,
  upcomingPayments: [] as Array<{
    paymentId: number;
    projectId: number;
    projectName: string;
    amount: number;
    dueDate: string;
    status: "pending" | "overdue";
    customerName: string | null;
  }>,
};

const DashboardPage = () => {
  const { user } = useAuth();
  const { t } = useTranslation(["dashboard", "common"]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "stats"],
    queryFn: getDashboardStats,
    retry: false,
  });

  // Never crash the dashboard because the stats endpoint hiccups.
  // We render the layout either way so users always see the welcome card.
  const stats = data ?? EMPTY_STATS;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("dashboard:welcome")}</CardTitle>
          <CardDescription>
            {user ? `${user.firstName} ${user.lastName} (${user.email})` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">{t("dashboard:placeholder_text")}</p>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common:loading")}</div>
      ) : error ? (
        <div className="text-sm text-muted-foreground">{t("dashboard:placeholder_text")}</div>
      ) : (
        <>
          <KpiCards stats={stats} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2">
              <RevenueChart data={stats.monthlyRevenue} />
            </div>
            <div className="space-y-4">
              <StatusBreakdown counts={stats.counts} />
              <UpcomingPayments payments={stats.upcomingPayments} />
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default DashboardPage;
