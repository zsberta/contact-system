// WorkspaceIndex — project landing page.
// If there is exactly one authorized project and no projectId in the URL,
// navigates to it. If there is exactly one module, navigates to its details.
// Otherwise renders the module selector (handled by Sidebar).

import { useEffect } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useProjectContext } from "@/context/ProjectContext";
import { useAuth } from "@/context/AuthContext";
import { buildWorkspaceProjectPath, buildWorkspaceModulePath, getDefaultPage } from "@/lib/workspace-navigation";

export default function WorkspaceIndex() {
  const { t } = useTranslation("common");
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isWorkspaceRoute = location.pathname.startsWith("/workspace");
  const { user } = useAuth();
  const {
    projects,
    modules,
    isProjectsLoading,
    isModulesLoading,
  } = useProjectContext();

  useEffect(() => {
    if (!isWorkspaceRoute || isProjectsLoading) return;

    // No projectId in URL — pick the first authorized project.
    if (!projectId && projects.length > 0) {
      navigate(buildWorkspaceProjectPath(projects[0].id), { replace: true });
      return;
    }

    // projectId in URL, modules loaded — if exactly one module, navigate to it.
    if (projectId && !isModulesLoading && modules.length === 1) {
      const mod = modules[0];
      navigate(
        buildWorkspaceModulePath(mod.projectId, mod.kind, mod.id, getDefaultPage(mod.kind, user?.role as "admin" | "enduser" ?? "admin")),
        { replace: true },
      );
      return;
    }
  }, [isWorkspaceRoute, projectId, projects, modules, isProjectsLoading, isModulesLoading, navigate]);

  if (isProjectsLoading || isModulesLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-pulse text-muted-foreground">{t("loading")}</div>
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        {t("no_projects_assigned", { defaultValue: "No projects assigned." })}
      </div>
    );
  }

  if (modules.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        {t("no_modules_configured", { defaultValue: "No modules configured for this project." })}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center p-8 text-muted-foreground">
      {t("select_module_from_sidebar", { defaultValue: "Select a module from the sidebar." })}
    </div>
  );
}
