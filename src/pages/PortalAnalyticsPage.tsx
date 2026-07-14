// PortalAnalyticsPage — read-only analytics dashboard for the selected
// project. Resolves the config id via the lazy upsert (admin must have
// enabled analytics; otherwise the sidebar link isn't visible) and
// mounts the shared AnalyticsViewShell that backs the admin's stats tab.
// Same content as the admin sees, no edit / snippet / details chrome.

import { useTranslation } from "react-i18next";
import { BarChart3 } from "lucide-react";
import { AnalyticsViewShell } from "@/components/analytics/AnalyticsViewShell";
import { useProjectContext } from "@/context/ProjectContext";
import { useQuery } from "@tanstack/react-query";
import { getOrCreateAnalyticsConfigByProject } from "@/lib/analytics";
import { showError } from "@/utils/toast";
import type { AnalyticsConfigDTO } from "@/types/analytics";

export default function PortalAnalyticsPage() {
  const { t } = useTranslation(["analytics", "common"]);
  const { selectedId } = useProjectContext();

  const {
    data: config,
    error,
  } = useQuery<AnalyticsConfigDTO, Error>({
    queryKey: ["portal", "analytics-config", selectedId],
    queryFn: () => getOrCreateAnalyticsConfigByProject(selectedId!),
    enabled: !!selectedId,
    retry: false,
  });

  if (error) {
    showError(
      t("common:operation_failed", { error: (error as Error).message }),
    );
  }

  if (!selectedId) {
    return (
      <div className="text-center p-8 text-muted-foreground">
        {t("analytics:config_section_no_project")}
      </div>
    );
  }

  // Single source of truth: the shell handles loading + not-found + the
  // dashboard render. We pass `config` when we have it (avoids a
  // duplicate fetch via React Query cache), otherwise the shell will
  // fetch by id itself. showHeader=false hides the dashboard's own
  // "Statisztikák" h2 since this page renders its own title above.
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t("analytics:stats_title")}</h1>
      </div>
      <AnalyticsViewShell config={config} configId={selectedId} showHeader={false} />
    </div>
  );
}