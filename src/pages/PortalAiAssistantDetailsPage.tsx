// PortalAiAssistantDetailsPage — details/configuration tab of the enduser portal.
// Shows branding, messaging, and language settings that endusers can edit.
// Hides admin-only fields (AI model, base URL, base prompt, rate limits, security).

import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { useProjectContext } from "@/context/ProjectContext";
import {
  getOrCreateAiAssistantConfigByProject,
  updateAiAssistantConfig,
} from "@/lib/ai-assistant";
import { showError, showSuccess } from "@/utils/toast";
import type {
  AiAssistantConfigDTO,
  AiAssistantUpdateDTO,
} from "@/types/ai-assistant";
import AiAssistantPortalDetailsForm from "@/components/ai-assistant/AiAssistantPortalDetailsForm";
import { PortalAiAssistantNav } from "@/components/ai-assistant/PortalAiAssistantNav";

export default function PortalAiAssistantDetailsPage() {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const queryClient = useQueryClient();
  const { selectedId } = useProjectContext();

  const { data: config, error, isLoading } = useQuery<AiAssistantConfigDTO, Error>({
    queryKey: ["portal", "ai-assistant-config", selectedId],
    queryFn: () => getOrCreateAiAssistantConfigByProject(selectedId!),
    enabled: !!selectedId,
    retry: false,
  });

  const updateMutation = useMutation({
    mutationFn: (data: AiAssistantUpdateDTO) =>
      updateAiAssistantConfig(config!.id, data),
    onSuccess: () => {
      showSuccess(
        t("common:update_success", {
          item: t("ai-assistant:ai_assistant_config"),
        }),
      );
      queryClient.invalidateQueries({
        queryKey: ["portal", "ai-assistant-config", selectedId],
      });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
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

  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
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
          <AiAssistantPortalDetailsForm
            initialData={config}
            onSubmit={(data) => updateMutation.mutate(data)}
            isPending={updateMutation.isPending}
          />
        </CardContent>
      </Card>
    </div>
  );
}
