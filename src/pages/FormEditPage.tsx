// ----------------------------------------------------------------------------
// FormEditPage — wraps FormForm in edit mode, loads by id.
// Mirrors ProjectEditPage exactly.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type { FormDTO, FormUpdateDTO } from "@/types/form";
import { getFormById, updateForm } from "@/lib/forms";
import FormForm from "@/components/forms/FormForm";
import { resolveModulePath } from "@/lib/workspace-navigation";
import { useModuleResolution } from "@/hooks/useModuleResolution";

const FormEditPage: React.FC = () => {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Workspace :moduleId is a project_modules row — the form id comes from
  // its resourceId (same hook the details page uses). Legacy :id is direct.
  const { resourceId: formId, isLoading: isResolving } = useModuleResolution();

  const { data: initialData, isLoading, error } = useQuery<FormDTO, Error>({
    queryKey: ["forms", formId],
    queryFn: () => getFormById(formId!),
    enabled: !!formId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: FormUpdateDTO) => updateForm(formId!, data),
    onSuccess: async () => {
      showSuccess(
        t("common:update_success", { item: t("forms:form") }),
      );
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["forms", formId] });
      if (initialData?.projectId) {
        const path = await resolveModulePath(initialData.projectId, "form");
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

  if (!formId && !isResolving) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading || isResolving) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">{t("forms:form_not_found")}</div>
    );
  }

  return (
    <FormForm
      mode="edit"
      initialData={initialData}
      isSubmitting={updateMutation.isPending}
      onSubmit={(data: FormUpdateDTO) => updateMutation.mutate(data)}
    />
  );
};

export default FormEditPage;
