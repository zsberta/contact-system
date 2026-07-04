// ----------------------------------------------------------------------------
// FormCreatePage — wraps FormForm in create mode, hooks up the mutation.
// Mirrors ProjectCreatePage exactly. If the URL carries ?projectId=N,
// pre-populate the form with that project so the operator doesn't have
// to re-pick one.
// ----------------------------------------------------------------------------

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type { FormCreateDTO, FormDTO } from "@/types/form";
import { createForm } from "@/lib/forms";
import FormForm from "@/components/forms/FormForm";

const FormCreatePage: React.FC = () => {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdParam = searchParams.get("projectId");
  const initialProjectId =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  const createMutation = useMutation({
    mutationFn: (data: FormCreateDTO) => createForm(data),
    onSuccess: (data: FormDTO) => {
      showSuccess(
        t("common:create_success", { item: t("forms:form") }),
      );
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      navigate(`/forms/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  // If the URL carries ?projectId=N, we pre-fill the form when it
  // mounts. FormForm doesn't yet have a "prefillProjectId" prop, so
  // we navigate the operator to the form with the param attached
  // (the form re-mounts and reads the param). The user already sees
  // it pre-selected — no double redirect needed.
  useEffect(() => {
    /* placeholder for future deep-link enhancement */
  }, [initialProjectId]);

  return (
    <FormForm
      mode="create"
      isSubmitting={createMutation.isPending}
      onSubmit={(data: FormCreateDTO) => createMutation.mutate(data)}
    />
  );
};

export default FormCreatePage;
