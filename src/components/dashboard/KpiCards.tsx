import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Wallet,
  TrendingUp,
  CalendarRange,
  AlertCircle,
} from "lucide-react";
import type { DashboardStatsDTO } from "@/types/payment";

const formatHuf = (amount: number): string => {
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(amount);
};

interface KpiCardsProps {
  stats: DashboardStatsDTO;
}

export function KpiCards({ stats }: KpiCardsProps) {
  const { t } = useTranslation(["dashboard", "common"]);

  const cards = [
    {
      key: "revenue30d",
      titleKey: "dashboard:revenue_30d",
      subKey: "dashboard:revenue_30d_sub",
      value: stats.revenue30d,
      icon: TrendingUp,
    },
    {
      key: "revenue90d",
      titleKey: "dashboard:revenue_90d",
      subKey: "dashboard:revenue_90d_sub",
      value: stats.revenue90d,
      icon: CalendarRange,
    },
    {
      key: "revenue365d",
      titleKey: "dashboard:revenue_365d",
      subKey: "dashboard:revenue_365d_sub",
      value: stats.revenue365d,
      icon: Wallet,
    },
    {
      key: "outstanding",
      titleKey: "dashboard:outstanding",
      subKey: "dashboard:outstanding_sub",
      value: stats.outstanding,
      icon: AlertCircle,
    },
  ];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.key}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {t(card.titleKey)}
              </CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatHuf(card.value)}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {t(card.subKey)}
              </p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export default KpiCards;