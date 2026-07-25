// AiAssistantViewShell — loading/error shell for the view page.
// Mirrors AnalyticsViewShell: fetch config if not provided, show loading,
// error, or render children with config.

import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { getAiAssistantConfigById } from "@/lib/ai-assistant";
import { showError } from "@/utils/toast";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";

interface AiAssistantViewShellProps {
  config?: AiAssistantConfigDTO;
  configId?: number;
  children: (config: AiAssistantConfigDTO) => React.ReactNode;
}

export function AiAssistantViewShell({
  config,
  configId,
  children,
}: AiAssistantViewShellProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const id = config?.id ?? configId;
  const needsFetch = !config && !!id;
  const {
    data: fetchedConfig,
    isLoading,
    error,
  } = useQuery<AiAssistantConfigDTO, Error>({
    queryKey: ["ai-assistant", id],
    queryFn: () => getAiAssistantConfigById(id!),
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
        {t("ai-assistant:ai_assistant_not_found")}
      </div>
    );
  }

  return <>{children(resolved)}</>;
}
