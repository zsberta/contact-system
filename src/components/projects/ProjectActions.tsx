import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreVertical, Eye, Edit, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { ProjectDTO } from "@/types/project";
import { deleteProject } from "@/lib/api";
import { showError, showSuccess } from "@/utils/toast";

interface ProjectActionsProps {
  project: ProjectDTO;
}

const ProjectActions = ({ project }: ProjectActionsProps) => {
  const { t } = useTranslation(["projects", "common"]);
  const queryClient = useQueryClient();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(project.id),
    onSuccess: () => {
      showSuccess(t("common:delete_success", { item: t("projects:project") }));
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleConfirmDelete = async () => {
    await deleteMutation.mutateAsync();
    setIsDeleteDialogOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={deleteMutation.isPending}
          >
            <span className="sr-only">{t("common:actions")}</span>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to={`/projects/view/${project.id}`}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/projects/edit/${project.id}`}>
              <Edit className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setIsDeleteDialogOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("projects:confirm_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("projects:confirm_delete_description", {
                name: project.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("common:deleting")
                : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ProjectActions;