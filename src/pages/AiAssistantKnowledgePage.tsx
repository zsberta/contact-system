// AiAssistantKnowledgePage — knowledge base tab of the admin AI assistant view.

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import { getAiAssistantConfigById } from "@/lib/ai-assistant";
import { AiAssistantViewNav } from "@/components/ai-assistant/AiAssistantViewNav";
import { AiKnowledgeBasePanel } from "@/components/ai-assistant/AiKnowledgeBasePanel";

const AiAssistantKnowledgePage: React.FC = () => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const { id } = useParams<{ id: string }>();
  const configId = id ? Number.parseInt(id) : null;

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
      <AiAssistantViewNav configId={config.id} />
      <Card>
        <CardContent className="pt-6">
          <AiKnowledgeBasePanel configId={config.id} />
        </CardContent>
      </Card>
    </div>
  );
};

export default AiAssistantKnowledgePage;
