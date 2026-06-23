import { useTranslation } from "react-i18next";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { TrendingUp } from "lucide-react";

const chartConfig: ChartConfig = {
  amount: {
    label: "Revenue",
    color: "hsl(var(--chart-1))",
  },
};

interface RevenueChartProps {
  data: Array<{ month: string; amount: number }>;
}

const formatMonth = (month: string): string => {
  // month format: "YYYY-MM"
  const date = new Date(`${month}-01`);
  if (Number.isNaN(date.getTime())) return month;
  return date.toLocaleDateString("hu-HU", { month: "short" });
};

const compactFormat = new Intl.NumberFormat("hu-HU", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const fullFormat = new Intl.NumberFormat("hu-HU", {
  style: "currency",
  currency: "HUF",
  maximumFractionDigits: 0,
});

export function RevenueChart({ data }: RevenueChartProps) {
  const { t } = useTranslation(["dashboard", "common"]);

  const chartData = data.map((d) => ({
    month: d.month,
    label: formatMonth(d.month),
    amount: d.amount,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <TrendingUp className="h-5 w-5" />
          {t("dashboard:revenue_chart")}
        </CardTitle>
        <CardDescription>
          {t("dashboard:revenue_chart_sub")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("dashboard:revenue_chart_no_data")}
          </p>
        ) : (
          <ChartContainer
            config={chartConfig}
            className="min-h-[280px] w-full"
          >
            <LineChart
              data={chartData}
              margin={{ top: 8, right: 12, left: 12, bottom: 8 }}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={12}
                tickLine={false}
                axisLine={false}
                tickFormatter={(value) =>
                  `${compactFormat.format(Number(value))} Ft`
                }
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => fullFormat.format(Number(value))}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="amount"
                stroke="var(--color-amount)"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

export default RevenueChart;