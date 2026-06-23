import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import type {
  ProjectCreateUpdateDTO,
  ProjectDetails,
} from "@/types/project";
import { getProjectById, updateProject } from "@/lib/api";
import ProjectForm from "@/components/projects/ProjectForm";
import { ProjectAttachments } from "@/components/projects/ProjectAttachments";

const ProjectEditPage: React.FC = () => {
  const { t } = useTranslation(["projects", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const projectId = id ? Number.parseInt(id) : null;

  const { data: initialData, isLoading, error } = useQuery<ProjectDetails, Error>(
    {
      queryKey: ["projects", projectId],
      queryFn: () => getProjectById(projectId!),
      enabled: !!projectId,
    },
  );

  const updateMutation = useMutation({
    mutationFn: (data: ProjectCreateUpdateDTO) =>
      updateProject(projectId!, data),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("projects:project") }));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
      navigate(`/projects/view/${projectId}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }

  if (!projectId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (isLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!initialData) {
    return (
      <div className="text-center p-8">{t("projects:project_not_found")}</div>
    );
  }

  return (
    <div className="space-y-6 w-full">
      <ProjectForm
        mode="edit"
        initialData={initialData}
        isSubmitting={updateMutation.isPending}
        onSubmit={(data: ProjectCreateUpdateDTO) => updateMutation.mutate(data)}
      />
      <div className="max-w-2xl mx-auto w-full">
        <ProjectAttachments projectId={projectId} />
      </div>
    </div>
  );
};

export default ProjectEditPage;