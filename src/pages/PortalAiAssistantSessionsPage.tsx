// PortalAiAssistantSessionsPage — chat sessions tab of the enduser portal.

import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { useProjectContext } from "@/context/ProjectContext";
import { getOrCreateAiAssistantConfigByProject } from "@/lib/ai-assistant";
import { showError } from "@/utils/toast";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import { AiChatSessionsPanel } from "@/components/ai-assistant/AiChatSessionsPanel";
import { PortalAiAssistantNav } from "@/components/ai-assistant/PortalAiAssistantNav";

export default function PortalAiAssistantSessionsPage() {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const { selectedId } = useProjectContext();

  const { data: config, error } = useQuery<AiAssistantConfigDTO, Error>({
    queryKey: ["portal", "ai-assistant-config", selectedId],
    queryFn: () => getOrCreateAiAssistantConfigByProject(selectedId!),
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
        {t("ai-assistant:config_section_no_project")}
      </div>
    );
  }

  if (!config) {
    return (
      <div className="text-center p-8 text-muted-foreground">
        {t("ai-assistant:config_section_ai_assistant_empty")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Bot className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">
          {t("ai-assistant:config_section_ai_assistant_title")}
        </h1>
      </div>

      <PortalAiAssistantNav />

      <Card>
        <CardContent className="pt-6">
          <AiChatSessionsPanel configId={config.id} />
        </CardContent>
      </Card>
    </div>
  );
}
