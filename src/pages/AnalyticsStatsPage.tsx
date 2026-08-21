// AnalyticsStatsPage — stats dashboard for the analytics module.
// Separate page routed via /workspace/.../analytics/:moduleId/stats.

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { getAnalyticsConfigById } from "@/lib/analytics";
import { AnalyticsViewShell } from "@/components/analytics/AnalyticsViewShell";

export default function AnalyticsStatsPage() {
  const { t } = useTranslation(["analytics", "common"]);
  const { resourceId: configId } = useModuleResolution();

  const { data: config, isLoading } = useQuery({
    queryKey: ["analytics", configId],
    queryFn: () => getAnalyticsConfigById(configId!),
    enabled: !!configId,
  });

  if (!configId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }

  if (!config) {
    return (
      <div className="text-center p-8">{t("analytics:analytics_not_found")}</div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <AnalyticsViewShell config={config} />
    </div>
  );
}
