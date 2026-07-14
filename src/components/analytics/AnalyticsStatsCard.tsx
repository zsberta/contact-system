// ----------------------------------------------------------------------------
// AnalyticsStatsCard — shows the totals + top paths + recent events for
// an analytics config. Mirrors the style of the forms submissions list
// but uses a 3-column top-of-card layout (pageviews / events / visitors).
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BarChart3, Eye, MousePointerClick, Users } from "lucide-react";
import { getAnalyticsStats } from "@/lib/analytics";
import { showError } from "@/utils/toast";

interface AnalyticsStatsCardProps {
  configId: number;
}

const WINDOW_OPTIONS: Array<{ value: string; labelKey: string; days: number }> = [
  { value: "1", labelKey: "analytics:stats_days_1", days: 1 },
  { value: "7", labelKey: "analytics:stats_days_7", days: 7 },
  { value: "30", labelKey: "analytics:stats_days_30", days: 30 },
  { value: "90", labelKey: "analytics:stats_days_90", days: 90 },
];

export function AnalyticsStatsCard({ configId }: AnalyticsStatsCardProps) {
  const { t } = useTranslation(["analytics", "common"]);
  const [windowValue, setWindowValue] = useState<string>("30");
  const days = parseInt(windowValue, 10) || 30;

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["analytics-stats", configId, days],
    queryFn: () => getAnalyticsStats(configId, days),
    enabled: !!configId,
  });

  if (error) {
    // Surface the error inline (toast would be too transient for a stats card).
    showError(
      t("common:operation_failed", { error: (error as Error).message }),
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-xl">
            <BarChart3 className="h-5 w-5" />
            {t("analytics:stats_title")}
          </CardTitle>
          <CardDescription>
            {t("analytics:stats_description", { days })}
          </CardDescription>
        </div>
        <div className="w-40">
          <Select value={windowValue} onValueChange={setWindowValue}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WINDOW_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(opt.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            {t("common:operation_failed", { error: (error as Error).message })}
          </p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">—</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {t("analytics:stats_events_help")}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <StatTile
                icon={<Eye className="h-5 w-5" />}
                label={t("analytics:stats_pageviews")}
                helpKey="analytics:stats_pageviews_help"
                value={data.totals.pageviews}
                isFetching={isFetching}
                t={t}
              />
              <StatTile
                icon={<MousePointerClick className="h-5 w-5" />}
                label={t("analytics:stats_events")}
                helpKey="analytics:stats_events_help"
                value={data.totals.events}
                isFetching={isFetching}
                t={t}
              />
              <StatTile
                icon={<Users className="h-5 w-5" />}
                label={t("analytics:stats_unique_visitors")}
                helpKey="analytics:stats_unique_visitors_help"
                value={data.totals.uniqueVisitors}
                isFetching={isFetching}
                t={t}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t("analytics:stats_top_paths")}
                </h3>
                {data.topPaths.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("analytics:stats_no_data")}
                  </p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {data.topPaths.map((p) => (
                      <li
                        key={p.path}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="font-mono text-xs truncate flex-1">
                          {p.path}
                        </span>
                        <span className="text-muted-foreground tabular-nums">
                          {p.views}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">
                  {t("analytics:stats_recent_events")}
                </h3>
                {data.recent.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("analytics:stats_no_data")}
                  </p>
                ) : (
                  <ul className="space-y-1 text-xs">
                    {data.recent.map((e) => (
                      <li
                        key={e.id}
                        className="flex items-center gap-2 font-mono"
                      >
                        <span
                          className={
                            e.eventType === "pageview"
                              ? "text-blue-600 dark:text-blue-400 w-16 flex-shrink-0"
                              : "text-emerald-600 dark:text-emerald-400 w-16 flex-shrink-0"
                          }
                        >
                          {e.eventType}
                        </span>
                        <span className="text-muted-foreground tabular-nums w-32 flex-shrink-0">
                          {new Date(e.occurredAt).toLocaleString()}
                        </span>
                        <span className="truncate flex-1">
                          {e.path || "—"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  helpKey,
  value,
  isFetching,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  helpKey: string;
  value: number;
  isFetching: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="rounded-md border p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        <span>{label}</span>
        <span
          className="ml-auto text-xs text-muted-foreground/70 cursor-help border-b border-dotted border-muted-foreground/40"
          title={t(helpKey)}
        >
          ?
        </span>
      </div>
      <p
        className={
          "mt-2 text-2xl font-bold tabular-nums " +
          (isFetching ? "opacity-60" : "")
        }
      >
        {value.toLocaleString()}
      </p>
    </div>
  );
}
