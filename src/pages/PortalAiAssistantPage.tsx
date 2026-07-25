// PortalAiAssistantPage — enduser portal page for the AI assistant.
// Mirrors PortalAnalyticsPage: fetches config via lazy upsert, shows
// read-only view with Knowledge Base and Chat Sessions tabs.

import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProjectContext } from "@/context/ProjectContext";
import { getOrCreateAiAssistantConfigByProject } from "@/lib/ai-assistant";
import { showError } from "@/utils/toast";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import { AiKnowledgeBasePanel } from "@/components/ai-assistant/AiKnowledgeBasePanel";
import { AiChatSessionsPanel } from "@/components/ai-assistant/AiChatSessionsPanel";

export default function PortalAiAssistantPage() {
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

      <Tabs defaultValue="knowledge">
        <TabsList>
          <TabsTrigger value="knowledge">
            {t("ai-assistant:knowledge_tab")}
          </TabsTrigger>
          <TabsTrigger value="sessions">
            {t("ai-assistant:chat_sessions")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="knowledge">
          <Card>
            <CardContent className="pt-6">
              <AiKnowledgeBasePanel configId={config.id} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sessions">
          <Card>
            <CardContent className="pt-6">
              <AiChatSessionsPanel configId={config.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
