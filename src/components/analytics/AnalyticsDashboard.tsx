// ----------------------------------------------------------------------------
// AnalyticsDashboard — full stats dashboard with time-series chart,
// top referrers, top locales, device pie, hourly heatmap, realtime
// pulse, and a recent-events feed. Replaces the lighter AnalyticsStatsCard
// for the analytics view page.
//
// Charts powered by recharts (already in package.json). The dashboard is
// self-contained: a single GET /api/analytics/:id/stats call drives all
// visualisations. Auto-refreshes every 30s so the realtime pulse updates.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMemo, useEffect, useState } from "react";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Activity,
  Eye,
  MousePointerClick,
  Users,
  BarChart3,
  Globe,
  Smartphone,
  Monitor,
  Tablet,
} from "lucide-react";
import { getAnalyticsStats } from "@/lib/analytics";
import { showError } from "@/utils/toast";
import type { AnalyticsStatsResponse } from "@/types/analytics";

interface AnalyticsDashboardProps {
  configId: number;
  // Set false when the host page already renders a title for the
  // dashboard (e.g. the enduser portal) — avoids the duplicate "Stats"
  // heading. Defaults to true so the admin's tabbed view still gets
  // its title.
  showHeader?: boolean;
}

const WINDOW_OPTIONS: Array<{ value: string; labelKey: string; days: number }> = [
  { value: "1", labelKey: "analytics:stats_days_1", days: 1 },
  { value: "7", labelKey: "analytics:stats_days_7", days: 7 },
  { value: "30", labelKey: "analytics:stats_days_30", days: 30 },
  { value: "90", labelKey: "analytics:stats_days_90", days: 90 },
];

// Brand-neutral chart palette. Each color has a dark-mode counterpart
// baked into the design system via Tailwind's CSS-variable theming, but
// recharts takes literal hex values — so we provide both light + dark
// via the same hex (which happens to look fine on both backgrounds in
// this palette).
const COLORS = {
  pageview: "#2563eb",   // blue-600
  event: "#10b981",      // emerald-500
  visitors: "#a855f7",   // purple-500
  mobile: "#f59e0b",     // amber-500
  tablet: "#06b6d4",     // cyan-500
  desktop: "#6366f1",    // indigo-500
  unknown: "#94a3b8",    // slate-400
  heatmapMin: "#1e293b", // slate-800
};

export function AnalyticsDashboard({
  configId,
  showHeader = true,
}: AnalyticsDashboardProps) {
  const { t, i18n } = useTranslation(["analytics", "common"]);
  const [windowValue, setWindowValue] = useState<string>("30");
  const [realtimeEnabled, setRealtimeEnabled] = useState<boolean>(true);
  const days = parseInt(windowValue, 10) || 30;

  const { data, isLoading, error, isFetching, dataUpdatedAt } = useQuery<
    AnalyticsStatsResponse,
    Error
  >({
    queryKey: ["analytics-dashboard", configId, days],
    queryFn: () => getAnalyticsStats(configId, days),
    enabled: !!configId,
    // Live updates: refetch every 30s while the tab is visible so the
    // realtime pulse and totals don't go stale. We could use
    // refetchInterval directly, but combining it with the document
    // visibility check (see effect below) keeps the BE quiet when the
    // user has the tab in the background.
    refetchInterval: realtimeEnabled ? 30_000 : false,
  });

  // Pause the refetch loop when the tab is hidden. Saves DB load and
  // matches the user's mental model: a hidden tab isn't being looked at.
  useEffect(() => {
    const onVisibility = () => {
      setRealtimeEnabled(document.visibilityState === "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  if (error) {
    showError(
      t("common:operation_failed", { error: (error as Error).message }),
    );
  }

  // ----- Derived data --------------------------------------------------------
  // Time-series: pad the buckets so the chart x-axis is contiguous. The
  // server already pads the realtime series; the timeSeries comes back
  // sparse (only non-empty buckets). We densify in the FE so the area
  // chart shows a continuous line.
  const paddedTimeSeries = useMemo(() => {
    if (!data) return [];
    if (data.timeSeries.length === 0) return [];
    const out = [];
    const start = new Date(data.timeSeries[0].bucket).getTime();
    const end = new Date(
      data.timeSeries[data.timeSeries.length - 1].bucket,
    ).getTime();
    const stepMs =
      data.bucket === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const map = new Map(
      data.timeSeries.map((r) => [new Date(r.bucket).getTime(), r]),
    );
    for (let t = start; t <= end; t += stepMs) {
      const hit = map.get(t);
      if (hit) {
        out.push({
          ...hit,
          label: formatBucketLabel(hit.bucket, data.bucket, i18n.language),
        });
      } else {
        out.push({
          bucket: new Date(t).toISOString(),
          pageviews: 0,
          events: 0,
          visitors: 0,
          label: formatBucketLabel(
            new Date(t).toISOString(),
            data.bucket,
            i18n.language,
          ),
        });
      }
    }
    return out;
  }, [data, i18n.language]);

  // Hourly heatmap: pivot the flat (dow, hour) → events array into a 7×24
  // grid. We use JS locale-aware weekday labels from the i18n keys
  // (stats_dow_short..6).
  const heatmapGrid = useMemo(() => {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    if (data) {
      for (const cell of data.hourlyHeatmap) {
        grid[cell.dow][cell.hour] = cell.events;
        if (cell.events > max) max = cell.events;
      }
    }
    return { grid, max };
  }, [data]);

  // Devices pie chart data.
  const deviceData = useMemo(() => {
    if (!data) return [];
    const d = data.devices;
    return [
      { name: t("analytics:stats_device_mobile"), value: d.mobile, key: "mobile" },
      { name: t("analytics:stats_device_tablet"), value: d.tablet, key: "tablet" },
      { name: t("analytics:stats_device_desktop"), value: d.desktop, key: "desktop" },
    ].filter((row) => row.value > 0);
  }, [data, t]);

  // Realtime series: rename bucket → label, fill empties with 0.
  const realtimeSeries = useMemo(() => {
    if (!data) return [];
    return data.realtime.series.map((r) => ({
      ...r,
      label: new Date(r.bucket).toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }),
    }));
  }, [data, i18n.language]);

  // ----- Render --------------------------------------------------------------
  return (
    <div className="space-y-4">
      {/* Header bar: title + window selector + live indicator.
          The title block is hidden when the host page already renders
          its own title (the portal wraps the dashboard with a
          "Statisztikák" h1), but the controls (live + window select)
          always render so the user can change the window. */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        {showHeader && (
          <div>
            <h2 className="text-2xl font-bold flex items-center gap-2">
              <BarChart3 className="h-6 w-6" />
              {t("analytics:stats_title")}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t("analytics:stats_description", { days })}
            </p>
          </div>
        )}
        <div className="flex items-center gap-3">
          <LiveIndicator
            enabled={realtimeEnabled}
            dataUpdatedAt={dataUpdatedAt}
            t={t}
          />
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
        </div>
      </div>

      {isLoading ? (
        <DashboardSkeleton t={t} />
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">
            {t("common:operation_failed", {
              error: (error as Error).message,
            })}
          </CardContent>
        </Card>
      ) : !data ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("analytics:stats_no_data")}
          </CardContent>
        </Card>
      ) : data.totals.pageviews === 0 &&
        data.totals.events === 0 ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            {t("analytics:stats_no_data")}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Top KPI tiles — 4 metrics in a responsive grid */}
          <div
            className={
              "grid grid-cols-2 lg:grid-cols-4 gap-3 transition-opacity " +
              (isFetching ? "opacity-70" : "")
            }
          >
            <KpiTile
              icon={<Eye className="h-5 w-5" />}
              label={t("analytics:stats_pageviews")}
              value={data.totals.pageviews}
              helpKey="analytics:stats_pageviews_help"
              t={t}
            />
            <KpiTile
              icon={<MousePointerClick className="h-5 w-5" />}
              label={t("analytics:stats_events")}
              value={data.totals.events}
              helpKey="analytics:stats_events_help"
              t={t}
            />
            <KpiTile
              icon={<Users className="h-5 w-5" />}
              label={t("analytics:stats_unique_visitors")}
              value={data.totals.uniqueVisitors}
              helpKey="analytics:stats_unique_visitors_help"
              t={t}
            />
            <KpiTile
              icon={<Activity className="h-5 w-5" />}
              label={t("analytics:stats_unique_sessions")}
              value={data.totals.uniqueSessions}
              helpKey="analytics:stats_unique_sessions_help"
              t={t}
            />
          </div>

          {/* Time-series area chart: full width */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {t("analytics:stats_pageviews")} &amp;{" "}
                {t("analytics:stats_events")}
              </CardTitle>
              <CardDescription>
                {/* Reflect the actual selected window, not the bucket
                    granularity — 30 days shouldn't read as "Last 90
                    days". */}
                {t("analytics:stats_description", { days })}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={paddedTimeSeries}
                    margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="pvFill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={COLORS.pageview}
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="100%"
                          stopColor={COLORS.pageview}
                          stopOpacity={0}
                        />
                      </linearGradient>
                      <linearGradient
                        id="evFill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          stopColor={COLORS.event}
                          stopOpacity={0.3}
                        />
                        <stop
                          offset="100%"
                          stopColor={COLORS.event}
                          stopOpacity={0}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      opacity={0.3}
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 11 }}
                      interval="preserveStartEnd"
                    />
                    <YAxis
                      tick={{ fontSize: 11 }}
                      allowDecimals={false}
                      width={32}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area
                      type="monotone"
                      dataKey="pageviews"
                      name={t("analytics:stats_pageviews")}
                      stroke={COLORS.pageview}
                      fill="url(#pvFill)"
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="events"
                      name={t("analytics:stats_events")}
                      stroke={COLORS.event}
                      fill="url(#evFill)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Two-column row: top paths + top referrers */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <RankListCard
              title={t("analytics:stats_top_paths")}
              rows={(data.topPaths || []).slice(0, 8).map((p) => ({
                key: p.path,
                label: p.path,
                value: p.views,
              }))}
              valueSuffix=""
              emptyMessage={t("analytics:stats_no_data")}
              maxValue={Math.max(
                1,
                ...(data.topPaths || []).map((p) => p.views),
              )}
              t={t}
            />
            <RankListCard
              title={t("analytics:stats_top_referrers")}
              rows={(data.topReferrers || []).slice(0, 8).map((r) => ({
                key: r.host,
                label: r.host,
                value: r.visits,
              }))}
              valueSuffix=""
              emptyMessage={t("analytics:stats_no_data")}
              maxValue={Math.max(
                1,
                ...(data.topReferrers || []).map((r) => r.visits),
              )}
              t={t}
            />
          </div>

          {/* Two-column row: devices pie + top locales */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <Smartphone className="h-4 w-4" />
                  {t("analytics:stats_devices")}
                </CardTitle>
                <CardDescription className="text-xs">
                  {t("analytics:stats_devices_help")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {deviceData.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("analytics:stats_no_data")}
                  </p>
                ) : (
                  <div className="h-56">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={deviceData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius={50}
                          outerRadius={80}
                          paddingAngle={2}
                          label={({ value, percent }) =>
                            `${value} (${(percent * 100).toFixed(0)}%)`
                          }
                          labelLine={false}
                        >
                          {deviceData.map((entry) => (
                            <Cell
                              key={entry.key}
                              fill={
                                entry.key === "mobile"
                                  ? COLORS.mobile
                                  : entry.key === "tablet"
                                    ? COLORS.tablet
                                    : COLORS.desktop
                              }
                            />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={{
                            background: "hsl(var(--popover))",
                            border: "1px solid hsl(var(--border))",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                        />
                        <Legend
                          wrapperStyle={{ fontSize: 12 }}
                          iconType="circle"
                        />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </CardContent>
            </Card>

            <RankListCard
              title={t("analytics:stats_top_locales")}
              rows={(data.topLocales || []).slice(0, 8).map((r) => ({
                key: r.locale,
                label: r.locale,
                value: r.visits,
              }))}
              valueSuffix=""
              emptyMessage={t("analytics:stats_no_data")}
              maxValue={Math.max(
                1,
                ...(data.topLocales || []).map((r) => r.visits),
              )}
              t={t}
            />
          </div>

          {/* Hourly heatmap — 7x24 grid */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t("analytics:stats_hourly_heatmap")}
              </CardTitle>
              <CardDescription className="text-xs">
                {t("analytics:stats_hourly_heatmap_help")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {heatmapGrid.max === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("analytics:stats_no_data")}
                </p>
              ) : (
                <HeatmapGrid grid={heatmapGrid.grid} max={heatmapGrid.max} t={t} />
              )}
            </CardContent>
          </Card>

          {/* Realtime pulse — auto-refreshing bar chart */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    {t("analytics:stats_realtime")}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {t("analytics:stats_realtime_help")}
                  </CardDescription>
                </div>
                <span className="text-sm font-semibold tabular-nums">
                  {t("analytics:stats_realtime_total", {
                    count:
                      data.realtime.total30m.pageviews +
                      data.realtime.total30m.events,
                  })}
                </span>
              </div>
            </CardHeader>
            <CardContent>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={realtimeSeries}
                    margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      opacity={0.3}
                    />
                    <XAxis
                      dataKey="label"
                      tick={{ fontSize: 10 }}
                      interval={4}
                    />
                    <YAxis
                      tick={{ fontSize: 10 }}
                      allowDecimals={false}
                      width={28}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--popover))",
                        border: "1px solid hsl(var(--border))",
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar
                      dataKey="pageviews"
                      name={t("analytics:stats_pageviews")}
                      stackId="r"
                      fill={COLORS.pageview}
                    />
                    <Bar
                      dataKey="events"
                      name={t("analytics:stats_events")}
                      stackId="r"
                      fill={COLORS.event}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>

          {/* Recent events feed */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">
                {t("analytics:stats_recent_events")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("analytics:stats_no_data")}
                </p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {data.recent.slice(0, 10).map((e) => (
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
                        {new Date(e.occurredAt).toLocaleString(
                          i18n.language,
                        )}
                      </span>
                      <span className="truncate flex-1">
                        {e.path || "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function KpiTile({
  icon,
  label,
  value,
  helpKey,
  t,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  helpKey: string;
  t: (k: string) => string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {icon}
          <span className="truncate">{label}</span>
          <span
            className="ml-auto cursor-help border-b border-dotted border-muted-foreground/40"
            title={t(helpKey)}
          >
            ?
          </span>
        </div>
        <p className="mt-2 text-2xl font-bold tabular-nums">
          {value.toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

function LiveIndicator({
  enabled,
  dataUpdatedAt,
  t,
}: {
  enabled: boolean;
  dataUpdatedAt: number;
  t: (k: string) => string;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ageSec = dataUpdatedAt
    ? Math.max(0, Math.floor((now - dataUpdatedAt) / 1000))
    : null;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        className={
          "h-2 w-2 rounded-full " +
          (enabled
            ? "bg-emerald-500 animate-pulse"
            : "bg-slate-400")
        }
      />
      <span>
        {enabled
          ? t("analytics:stats_realtime")
          : t("common:loading")}{" "}
        {ageSec !== null && enabled ? `· ${ageSec}s` : ""}
      </span>
    </div>
  );
}

function RankListCard({
  title,
  rows,
  valueSuffix,
  emptyMessage,
  maxValue,
  t,
}: {
  title: string;
  rows: Array<{ key: string; label: string; value: number }>;
  valueSuffix: string;
  emptyMessage: string;
  maxValue: number;
  t: (k: string) => string;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {rows.map((row) => {
              const pct = Math.round((row.value / maxValue) * 100);
              return (
                <li
                  key={row.key}
                  className="flex items-center gap-2 min-w-0"
                  title={`${row.label} — ${row.value}${valueSuffix}`}
                >
                  <span className="font-mono text-xs truncate flex-1 min-w-0">
                    {row.label || "—"}
                  </span>
                  <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden max-w-[120px]">
                    <div
                      className="h-full bg-blue-500/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-muted-foreground tabular-nums text-xs w-12 text-right flex-shrink-0">
                    {row.value.toLocaleString()}
                    {valueSuffix}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function HeatmapGrid({
  grid,
  max,
  t,
}: {
  grid: number[][];
  max: number;
  t: (k: string) => string;
}) {
  const dows = [
    "stats_dow_short",
    "stats_dow_short_1",
    "stats_dow_short_2",
    "stats_dow_short_3",
    "stats_dow_short_4",
    "stats_dow_short_5",
    "stats_dow_short_6",
  ];
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <div className="grid grid-cols-[auto_repeat(24,1fr)] gap-0.5 text-[10px] text-muted-foreground">
          {/* Hour labels along the top */}
          <div></div>
          {Array.from({ length: 24 }, (_, h) => (
            <div key={`h-${h}`} className="text-center">
              {h % 6 === 0 ? h : ""}
            </div>
          ))}
          {/* Rows: dow label + 24 cells */}
          {dows.map((dowKey, dow) => (
            <div key={`row-${dow}`} className="contents">
              <div className="pr-2 pt-1.5 text-right">
                {t(`analytics:${dowKey}`)}
              </div>
              {Array.from({ length: 24 }, (_, h) => {
                const v = grid[dow][h] || 0;
                const intensity = max > 0 ? v / max : 0;
                return (
                  <div
                    key={`cell-${dow}-${h}`}
                    className="aspect-square rounded-sm"
                    title={`${t(`analytics:${dowKey}`)} ${h}:00 — ${v}`}
                    style={{
                      background: heatmapColor(intensity),
                      border: intensity === 0
                        ? "1px solid hsl(var(--border))"
                        : "none",
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
        {/* Legend */}
        <div className="flex items-center gap-2 mt-3 text-[10px] text-muted-foreground">
          <span>0</span>
          <div
            className="h-2 w-32 rounded"
            style={{
              background:
                "linear-gradient(to right, hsl(var(--border)), " +
                COLORS.pageview +
                ")",
            }}
          />
          <span>{max.toLocaleString()}</span>
        </div>
      </div>
    </div>
  );
}

function heatmapColor(intensity: number): string {
  // Empty cell: very light. Hot cell: full brand color. We use the
  // pageview blue with alpha to keep the gradient on-brand.
  if (intensity <= 0) return "transparent";
  const alpha = 0.15 + intensity * 0.85;
  return `rgba(37, 99, 235, ${alpha.toFixed(2)})`;
}

function DashboardSkeleton({ t }: { t: (k: string) => string }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-16 mt-2" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-6">
          <Skeleton className="h-72 w-full" />
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground text-center">
        {t("common:loading")}
      </p>
    </div>
  );
}

// Format a bucket start into a locale-aware axis label. The server sends
// an ISO string; the FE decides how short to render it based on the
// bucket granularity.
function formatBucketLabel(
  iso: string,
  bucket: "hour" | "day",
  locale: string,
): string {
  const d = new Date(iso);
  if (bucket === "hour") {
    return d.toLocaleString(locale, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      hour12: false,
    });
  }
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
  });
}
