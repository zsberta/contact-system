// AnalyticsViewShell — shared "resolve config by id + mount the stats
// dashboard" shell. Used by both AnalyticsViewPage (admin: wraps with
// 3-tab UI including Details/Snippet) and PortalAnalyticsPage (enduser:
// wraps with just a header). The shell handles the loading / error /
// not-found states and renders the dashboard.
//
// This is the single source of truth for "fetch analytics config and
// show stats" — there is intentionally no parallel implementation in
// the portal page. Pass `config` from the parent if you've already
// loaded it (avoids a duplicate fetch); otherwise pass `configId`.

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { AnalyticsDashboard } from "@/components/analytics/AnalyticsDashboard";
import { getAnalyticsConfigById } from "@/lib/analytics";
import { showError } from "@/utils/toast";
import type { AnalyticsConfigDTO } from "@/types/analytics";

interface AnalyticsViewShellProps {
  // Either an already-loaded config (preferred — no extra fetch) or a
  // configId (the shell will fetch it).
  config?: AnalyticsConfigDTO;
  configId?: number;
  // Forwarded to AnalyticsDashboard. Set false from host pages that
  // render their own title above the dashboard.
  showHeader?: boolean;
}

export function AnalyticsViewShell({
  config,
  configId,
  showHeader,
}: AnalyticsViewShellProps) {
  const { t } = useTranslation(["analytics", "common"]);

  // Only fetch when config wasn't passed in.
  const id = config?.id ?? configId;
  const needsFetch = !config && !!id;
  const { data: fetchedConfig, isLoading, error } = useQuery<AnalyticsConfigDTO, Error>({
    queryKey: ["analytics", id],
    queryFn: () => getAnalyticsConfigById(id!),
    enabled: needsFetch,
  });

  const resolved = config ?? fetchedConfig;

  if (error) {
    showError(
      t("common:operation_failed", { error: (error as Error).message }),
    );
  }

  if (!resolved && isLoading) {
    return (
      <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!resolved) {
    return (
      <div className="text-center p-8 text-muted-foreground">
        {t("analytics:analytics_not_found")}
      </div>
    );
  }

  return <AnalyticsDashboard configId={resolved.id} showHeader={showHeader} />;
}