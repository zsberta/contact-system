// ----------------------------------------------------------------------------
// ProjectAnalytics — a card on the project view page that surfaces the
// analytics config (lazy-created on first access) and offers a quick path
// to the snippet + stats. Mirrors ProjectForms structurally.
// ----------------------------------------------------------------------------

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
import { BarChart3, PlusCircle } from "lucide-react";
import {
  getAllAnalyticsConfigsPaged,
  getAnalyticsStats,
  getOrCreateAnalyticsConfigByProject,
} from "@/lib/analytics";
import { showError, showSuccess } from "@/utils/toast";
import type { AnalyticsStatus } from "@/types/analytics";

interface ProjectAnalyticsProps {
  projectId: number;
}

const statusBadgeVariant = (status: AnalyticsStatus) =>
  status === "disabled" ? ("destructive" as const) : ("default" as const);

export function ProjectAnalytics({ projectId }: ProjectAnalyticsProps) {
  const { t } = useTranslation(["analytics", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // useMutation for the lazy-create so we can show a clear "Enabling…"
  // state and a success toast. The query below reuses the cached result
  // from the mutation onSuccess, so navigating to /analytics/view/:id
  // works without a second round-trip.
  const enableMutation = useMutation({
    mutationFn: () => getOrCreateAnalyticsConfigByProject(projectId),
    onSuccess: (data) => {
      showSuccess(
        t("common:create_success", {
          item: t("analytics:analytics_config"),
        }),
      );
      queryClient.setQueryData(["analytics", data.id], data);
      queryClient.invalidateQueries({ queryKey: ["analytics", "project", projectId] });
      navigate(`/analytics/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  // Read existing config (no create). If no row exists for the project,
  // the list endpoint returns 200 with empty content, so the empty state
  // below shows the "Enable analytics" CTA. We don't call the lazy
  // upsert here — that mutation is reserved for the explicit user click
  // so we don't accidentally materialise a row on every project view.
  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics", "project", projectId],
    queryFn: async () => {
      const page = await getAllAnalyticsConfigsPaged({
        projectId,
        page: 0,
        size: 1,
      });
      return page.content[0] ?? null;
    },
    enabled: !!projectId,
    retry: false,
  });

  // If the query errors, treat it as "no config yet" — the empty state
  // is the user-facing signal. Errors other than 404 (network, 5xx) are
  // very unlikely here because the list endpoint returns 200 + empty
  // content rather than 404, so a real error is a genuine bug worth
  // surfacing in the console.
  const hasConfig = !!data;
  if (error) {
    console.error("[project-analytics] query error:", error);
  }

  // Best-effort: peek at stats if we have a config. We keep this on a
  // separate query so a slow stats endpoint doesn't block the card.
  const { data: stats } = useQuery({
    queryKey: ["analytics", "project", projectId, "stats"],
    queryFn: () => getAnalyticsStats(data!.id, 30),
    enabled: !!data,
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <BarChart3 className="h-5 w-5" />
          {t("analytics:config_section_analytics_title")}
        </CardTitle>
        {hasConfig && (
          <Badge variant={statusBadgeVariant(data!.status)}>
            {t(`analytics:status_${data!.status}`)}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !hasConfig ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground py-2 text-center">
              {t("analytics:config_section_analytics_empty")}
            </p>
            <div className="flex justify-center">
              <Button
                onClick={() => enableMutation.mutate()}
                disabled={enableMutation.isPending}
              >
                <PlusCircle className="mr-2 h-4 w-4" />
                {enableMutation.isPending
                  ? t("common:creating")
                  : t("analytics:config_section_create_analytics")}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            <li
              className="flex items-center justify-between p-3 border rounded-md cursor-pointer hover:bg-muted/50"
              onClick={() => navigate(`/analytics/view/${data!.id}`)}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <BarChart3 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{data!.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {stats
                      ? t("analytics:stats_description", { days: stats.days }) +
                        " · " +
                        `${stats.totals.pageviews} ${t("analytics:stats_pageviews").toLowerCase()}`
                      : t("common:loading")}
                  </p>
                </div>
              </div>
            </li>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectAnalytics;
