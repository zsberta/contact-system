import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PieChart } from "lucide-react";
import type { DashboardStatsDTO } from "@/types/payment";

interface StatusBreakdownProps {
  counts: DashboardStatsDTO["counts"];
}

const STATUS_CONFIG = [
  {
    key: "pending",
    variant: "secondary" as const,
  },
  {
    key: "overdue",
    variant: "destructive" as const,
  },
  {
    key: "paid",
    variant: "default" as const,
  },
  {
    key: "cancelled",
    variant: "outline" as const,
  },
];

export function StatusBreakdown({ counts }: StatusBreakdownProps) {
  const { t } = useTranslation(["dashboard", "common"]);

  const total = counts.pending + counts.overdue + counts.paid + counts.cancelled;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <PieChart className="h-5 w-5" />
          {t("dashboard:status_breakdown")}
        </CardTitle>
        <CardDescription>
          {t("dashboard:status_breakdown_sub")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-3">
          {STATUS_CONFIG.map((s) => (
            <Badge
              key={s.key}
              variant={s.variant}
              className="px-3 py-1.5 text-sm"
            >
              {t(`dashboard:status_count_${s.key}`)}: {counts[s.key]}
            </Badge>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          {t("common:total")}: {total}
        </p>
      </CardContent>
    </Card>
  );
}

export default StatusBreakdown;