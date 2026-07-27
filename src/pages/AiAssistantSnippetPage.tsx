// AiAssistantSnippetPage — embed snippet tab of the admin AI assistant view.

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import { getAiAssistantConfigById } from "@/lib/ai-assistant";
import { AiAssistantViewNav } from "@/components/ai-assistant/AiAssistantViewNav";
import { AiAssistantSnippetPanel } from "@/components/ai-assistant/AiAssistantSnippetPanel";

const AiAssistantSnippetPage: React.FC = () => {
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
      <AiAssistantSnippetPanel
        configId={config.id}
        allowedOrigins={config.allowedOrigins}
      />
    </div>
  );
};

export default AiAssistantSnippetPage;
