import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  ProjectCreateUpdateDTO,
  ProjectDetails,
} from "@/types/project";
import { createProject } from "@/lib/api";
import ProjectForm from "@/components/projects/ProjectForm";

const ProjectCreatePage: React.FC = () => {
  const { t } = useTranslation(["projects", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (data: ProjectCreateUpdateDTO) => createProject(data),
    onSuccess: (data: ProjectDetails) => {
      showSuccess(t("common:create_success", { item: t("projects:project") }));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate(`/projects/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  return (
    <ProjectForm
      mode="create"
      isSubmitting={createMutation.isPending}
      onSubmit={(data: ProjectCreateUpdateDTO) => createMutation.mutate(data)}
    />
  );
};

export default ProjectCreatePage;