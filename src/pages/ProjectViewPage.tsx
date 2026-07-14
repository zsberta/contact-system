import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
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
import { ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { ProjectDetails } from "@/types/project";
import { deleteProject, getProjectById } from "@/lib/api";
import { ProjectAttachments } from "@/components/projects/ProjectAttachments";
import { ProjectPayments } from "@/components/projects/ProjectPayments";
import { ProjectForms } from "@/components/forms/ProjectForms";
import { ProjectReservations } from "@/components/reservations/ProjectReservations";
import { ProjectAnalytics } from "@/components/analytics/ProjectAnalytics";

const formatPrice = (price: number | null): string => {
  if (price === null || price === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(price);
};

const ProjectViewPage: React.FC = () => {
  const { t } = useTranslation(["projects", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const projectId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const { data: project, isLoading, error } = useQuery<ProjectDetails, Error>({
    queryKey: ["projects", projectId],
    queryFn: () => getProjectById(projectId!),
    enabled: !!projectId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(project!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", { item: t("projects:project") }),
      );
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      navigate("/projects");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!projectId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return (
      <div className="text-center p-8">{t("common:loading")}</div>
    );
  if (!project)
    return (
      <div className="text-center p-8">{t("projects:project_not_found")}</div>
    );

  const statusVariant =
    project.status === "cancelled"
      ? "destructive"
      : project.status === "under_construction"
        ? "secondary"
        : "default";

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: project.id },
    { label: t("projects:name"), value: project.name },
    { label: t("projects:customer_name"), value: project.customerName || "—" },
    {
      label: t("projects:domain_address"),
      value: project.domainAddress || "—",
    },
    { label: t("projects:price"), value: formatPrice(project.price) },
    {
      label: t("projects:billing_period"),
      value: project.billingPeriod
        ? t(`projects:billing_period_${project.billingPeriod}`)
        : "—",
    },
    { label: t("projects:fordulonap"), value: project.fordulonap || "—" },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusVariant}>
          {t(`projects:status_${project.status}`)}
        </Badge>
      ),
    },
    {
      label: t("projects:customer_phone"),
      value: project.customerPhone || "—",
    },
    {
      label: t("projects:customer_email"),
      value: project.customerEmail || "—",
    },
    {
      label: t("projects:comment"),
      value: project.comment || "—",
    },
    {
      label: t("common:created_at"),
      value: new Date(project.createdAt).toLocaleString(),
    },
    {
      label: t("common:updated_at"),
      value: new Date(project.updatedAt).toLocaleString(),
    },
    {
      label: t("projects:last_status_change"),
      value: new Date(project.lastStatusChangeAt).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("projects:project_details")}: {project.name}
          </CardTitle>
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate("/projects")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("projects:back_to_projects")}
            </Button>
            <Button
              onClick={() => navigate(`/projects/edit/${project.id}`)}
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setIsDeleteDialogOpen(true)}
              disabled={deleteMutation.isPending}
              className="w-full sm:w-auto"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common:delete")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {details.map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {item.label}
                </p>
                <div className="text-base font-semibold break-words">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <ProjectAttachments projectId={project.id} />

      <ProjectForms projectId={project.id} />

      <ProjectReservations projectId={project.id} />

      <ProjectAnalytics projectId={project.id} />

      <ProjectPayments projectId={project.id} projectPrice={project.price} />

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
              onClick={() => deleteMutation.mutate()}
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
    </div>
  );
};

export default ProjectViewPage;