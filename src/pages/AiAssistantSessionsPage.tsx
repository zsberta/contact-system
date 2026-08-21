// AiAssistantSessionsPage — chat sessions tab of the admin AI assistant view.

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { Card, CardContent } from "@/components/ui/card";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import { getAiAssistantConfigById } from "@/lib/ai-assistant";
import { AiChatSessionsPanel } from "@/components/ai-assistant/AiChatSessionsPanel";

const AiAssistantSessionsPage: React.FC = () => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const { resourceId: configId } = useModuleResolution();

  const { data: config, isLoading } = useQuery<AiAssistantConfigDTO, Error>({
    queryKey: ["ai-assistant", configId],
    queryFn: () => getAiAssistantConfigById(configId!),
    enabled: !!configId,
  });

  if (!configId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return <div className="text-center p-8">{t("common:loading")}</div>;
  if (!config)
    return (
      <div className="text-center p-8">
        {t("ai-assistant:ai_assistant_not_found")}
      </div>
    );

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="pt-6">
          <AiChatSessionsPanel configId={config.id} />
        </CardContent>
      </Card>
    </div>
  );
};

export default AiAssistantSessionsPage;
