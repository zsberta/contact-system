// ProjectAssignmentsCard — admin-only, shown on the enduser view page.
//
// Renders the set of projects the enduser is currently assigned to, a
// multi-select dropdown to add new assignments, and per-row "remove"
// buttons. All operations are optimistic where possible (so the admin
// sees their changes instantly) and roll back on BE failure.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Briefcase, X, Plus } from "lucide-react";
import {
  addUserProject,
  removeUserProject,
  setUserProjects,
} from "@/lib/api";
import { showError, showSuccess } from "@/utils/toast";
import type { ProjectDTO } from "@/types/project";

interface ProjectAssignmentsCardProps {
  userId: number;
  assignedProjectIds: number[];
  allProjects: ProjectDTO[];
}

export function ProjectAssignmentsCard({
  userId,
  assignedProjectIds,
  allProjects,
}: ProjectAssignmentsCardProps) {
  const { t } = useTranslation(["users", "projects", "common"]);
  const queryClient = useQueryClient();
  // Local optimistic state so adding/removing feels instant.
  const [local, setLocal] = useState<number[]>(assignedProjectIds);
  const [pickValue, setPickValue] = useState<string>("");

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["user", userId] });
    queryClient.invalidateQueries({ queryKey: ["users"] });
  };

  const addMutation = useMutation({
    mutationFn: (projectId: number) => addUserProject(userId, projectId),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("users:user") }));
      invalidate();
    },
    onError: (err: Error) => {
      // Roll back local on error.
      setLocal(assignedProjectIds);
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const removeMutation = useMutation({
    mutationFn: (projectId: number) => removeUserProject(userId, projectId),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("users:user") }));
      invalidate();
    },
    onError: (err: Error) => {
      setLocal(assignedProjectIds);
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  // The "Save assignments" button does a PUT (replace-all) — this is
  // the bulk operation we use on initial setup, before the user has
  // any per-row toggle pattern in mind. The per-row add/remove is the
  // path of least surprise for adjustments.
  const replaceMutation = useMutation({
    mutationFn: (projectIds: number[]) => setUserProjects(userId, projectIds),
    onSuccess: () => {
      showSuccess(t("common:update_success", { item: t("users:user") }));
      invalidate();
    },
    onError: (err: Error) => {
      setLocal(assignedProjectIds);
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleAdd = () => {
    const pid = parseInt(pickValue, 10);
    if (!Number.isFinite(pid) || local.includes(pid)) return;
    const next = [...local, pid];
    setLocal(next);
    setPickValue("");
    addMutation.mutate(pid);
  };

  const handleRemove = (projectId: number) => {
    const next = local.filter((id) => id !== projectId);
    setLocal(next);
    removeMutation.mutate(projectId);
  };

  const assignedSet = new Set(local);
  const available = allProjects.filter((p) => !assignedSet.has(p.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl flex items-center gap-2">
          <Briefcase className="h-5 w-5" />
          {t("users:project_assignments")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("users:project_assignments_help")}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add a single project */}
        <div className="flex items-center gap-2">
          <Select value={pickValue} onValueChange={setPickValue}>
            <SelectTrigger className="flex-1">
              <SelectValue placeholder={t("users:assign_project")} />
            </SelectTrigger>
            <SelectContent>
              {available.length === 0 ? (
                <SelectItem value="__empty__" disabled>
                  {t("users:no_project_assignments")}
                </SelectItem>
              ) : (
                available.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>
                    {p.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
          <Button
            type="button"
            onClick={handleAdd}
            disabled={!pickValue || pickValue === "__empty__" || addMutation.isPending}
          >
            <Plus className="mr-2 h-4 w-4" />
            {t("users:assign_project")}
          </Button>
        </div>

        {/* Currently assigned */}
        {local.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            {t("users:no_project_assignments")}
          </p>
        ) : (
          <ul className="space-y-2">
            {local.map((projectId) => {
              const project = allProjects.find((p) => p.id === projectId);
              return (
                <li
                  key={projectId}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">
                      {project?.name || `Project #${projectId}`}
                    </p>
                    {project?.customerName && (
                      <p className="text-xs text-muted-foreground truncate">
                        {project.customerName}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {project && (
                      <Badge variant="secondary">
                        {t(`projects:status_${project.status}`)}
                      </Badge>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(projectId)}
                      disabled={removeMutation.isPending}
                      aria-label={t("users:unassign_project")}
                    >
                      <X className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {/* Bulk replace — only useful if the operator is replacing the
            whole set in one go. We keep it as a "Save" button so the
            intention is explicit. The other paths (add/remove) update
            the BE directly, so this is mostly a fallback. */}
        {local.length > 0 && (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => replaceMutation.mutate(local)}
              disabled={replaceMutation.isPending}
            >
              {t("common:save")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
