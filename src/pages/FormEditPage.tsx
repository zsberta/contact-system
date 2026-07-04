// ----------------------------------------------------------------------------
// FormEditPage — wraps FormForm in edit mode, loads by id.
// Mirrors ProjectEditPage exactly.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type { FormDTO, FormUpdateDTO } from "@/types/form";
import { getFormById, updateForm } from "@/lib/forms";
import FormForm from "@/components/forms/FormForm";

const FormEditPage: React.FC = () => {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const formId = id ? Number.parseInt(id) : null;

  const { data: initialData, isLoading, error } = useQuery<FormDTO, Error>({
    queryKey: ["forms", formId],
    queryFn: () => getFormById(formId!),
    enabled: !!formId,
  });

  const updateMutation = useMutation({
    mutationFn: (data: FormUpdateDTO) => updateForm(formId!, data),
    onSuccess: () => {
      showSuccess(
        t("common:update_success", { item: t("forms:form") }),
      );
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["forms", formId] });
      navigate(`/forms/view/${formId}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }

  if (!formId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
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
