// ----------------------------------------------------------------------------
// AnalyticsEditPage — loads the config by id and wraps the edit form.
// Mirrors FormEditPage exactly. If the config doesn't exist yet, the
// lazy create happens at /api/analytics/by-project/:id instead — there
// is no dedicated create page because every config is project-scoped.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  AnalyticsConfigDTO,
  AnalyticsConfigUpdateDTO,
} from "@/types/analytics";
import {
  getAnalyticsConfigById,
  updateAnalyticsConfig,
} from "@/lib/analytics";
import AnalyticsConfigForm from "@/components/analytics/AnalyticsConfigForm";

const AnalyticsEditPage: React.FC = () => {
  const { t } = useTranslation(["analytics", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const configId = id ? Number.parseInt(id) : null;

  const { data: initialData, isLoading, error } = useQuery<
    AnalyticsConfigDTO,
    Error
  >({
    queryKey: ["analytics", configId],
    queryFn: () => getAnalyticsConfigById(configId!),
    enabled: !!configId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: AnalyticsConfigUpdateDTO) =>
      updateAnalyticsConfig(configId!, data),
    onSuccess: () => {
      showSuccess(
        t("common:update_success", {
          item: t("analytics:analytics_config"),
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["analytics", configId] });
      navigate(`/analytics/view/${configId}`);
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
        {t("analytics:analytics_not_found")}
      </div>
    );
  }

  return (
    <AnalyticsConfigForm
      initialData={initialData}
      isSubmitting={updateMutation.isPending}
      onSubmit={(data: AnalyticsConfigUpdateDTO) =>
        updateMutation.mutate(data)
      }
    />
  );
};

export default AnalyticsEditPage;
