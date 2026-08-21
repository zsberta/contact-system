// ----------------------------------------------------------------------------
// AiAssistantEditPage — loads the config by id and wraps the edit form.
// Mirrors AnalyticsEditPage exactly.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  AiAssistantConfigDTO,
  AiAssistantUpdateDTO,
} from "@/types/ai-assistant";
import {
  getAiAssistantConfigById,
  updateAiAssistantConfig,
} from "@/lib/ai-assistant";
import AiAssistantConfigForm from "@/components/ai-assistant/AiAssistantConfigForm";
import { resolveModulePath } from "@/lib/workspace-navigation";

const AiAssistantEditPage: React.FC = () => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const configId = id ? Number.parseInt(id) : null;

  const {
    data: initialData,
    isLoading,
    error,
  } = useQuery<AiAssistantConfigDTO, Error>({
    queryKey: ["ai-assistant", configId],
    queryFn: () => getAiAssistantConfigById(configId!),
    enabled: !!configId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: AiAssistantUpdateDTO) =>
      updateAiAssistantConfig(configId!, data),
    onSuccess: async () => {
      showSuccess(
        t("common:update_success", {
          item: t("ai-assistant:ai_assistant_config"),
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["ai-assistant"] });
      queryClient.invalidateQueries({ queryKey: ["ai-assistant", configId] });
      if (initialData?.projectId) {
        const path = await resolveModulePath(initialData.projectId, "ai-assistant");
        if (path) navigate(path);
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!configId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">
        {t("ai-assistant:ai_assistant_not_found")}
      </div>
    );
  }

  return (
    <AiAssistantConfigForm
      initialData={initialData}
      isSubmitting={updateMutation.isPending}
      onSubmit={(data: AiAssistantUpdateDTO) =>
        updateMutation.mutate(data)
      }
    />
  );
};

export default AiAssistantEditPage;
