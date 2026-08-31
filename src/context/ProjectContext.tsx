// ProjectContext — shared state for the workspace's selected project and module.
// Used by the Sidebar (project/module selectors) and module pages (moduleId).
// Both admin and enduser roles use this context; assignment filtering happens
// server-side via getScopedProjectIds.

import React, { createContext, useContext, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { getAllProjectsPaged } from "@/lib/api";
import { getProjectModules } from "@/lib/project-modules";
import {
  buildWorkspaceProjectPath,
  buildWorkspaceModulePath,
  getDefaultPage,
} from "@/lib/workspace-navigation";
import { useAuth } from "@/context/AuthContext";
import type { ProjectDTO } from "@/types/project";
import type { ProjectModuleDTO } from "@/types/project-module";

interface ProjectContextValue {
  projects: ProjectDTO[];
  selectedProject: ProjectDTO | null;
  modules: ProjectModuleDTO[];
  selectedModule: ProjectModuleDTO | null;
  isProjectsLoading: boolean;
  isModulesLoading: boolean;
  /** Navigate to a project's default landing. */
  setSelectedId: (id: number) => void;
  /** Navigate to a module's details page. */
  setSelectedModule: (moduleId: number) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { projectId, moduleId } = useParams<{
    projectId: string;
    moduleId: string;
  }>();

  const parsedProjectId = projectId ? Number(projectId) : undefined;
  const parsedModuleId = moduleId ? Number(moduleId) : undefined;

  const { data: projectsData, isLoading: isProjectsLoading } = useQuery({
    queryKey: ["workspace", "projects"],
    queryFn: () =>
      getAllProjectsPaged({
        page: 0,
        size: 500,
        sortField: "name",
        sortOrder: "asc",
      }),
  });

  const projects = projectsData?.content ?? [];

  // URL wins; with exactly one authorized project, default to it so the
  // sidebar shows project context on routes that carry no projectId param
  // (dashboard, /projects, global list pages). Multi-project users must
  // still pick explicitly via the selector.
  const selectedProject =
    projects.find((p) => p.id === parsedProjectId) ??
    (projects.length === 1 ? projects[0] : null);

  const { data: modules = [], isLoading: isModulesLoading } = useQuery({
    queryKey: ["workspace", "modules", selectedProject?.id],
    queryFn: () => getProjectModules(selectedProject!.id),
    enabled: !!selectedProject?.id,
  });
  // Same rule as the project above: URL wins; a project with exactly one
  // module gets it selected by default, so the sidebar exposes the module
  // links on routes that carry no moduleId param.
  const selectedModule =
    modules.find((m) => Number(m.id) === parsedModuleId) ??
    (modules.length === 1 ? modules[0] : null);

  const setSelectedId = useCallback(
    (id: number) => {
      navigate(buildWorkspaceProjectPath(id));
    },
    [navigate],
  );

  const setSelectedModule = useCallback(
    (id: number) => {
      if (!selectedProject) return;
      const mod = modules.find((m) => Number(m.id) === id);
      if (mod) {
        navigate(
          buildWorkspaceModulePath(selectedProject.id, mod.kind, Number(mod.id), getDefaultPage(mod.kind, user?.role as "admin" | "enduser" ?? "admin")),
        );
      }
    },
    [navigate, selectedProject, modules],
  );

  return (
    <ProjectContext.Provider
      value={{
        projects,
        selectedProject,
        modules,
        selectedModule,
        isProjectsLoading,
        isModulesLoading,
        setSelectedId,
        setSelectedModule,
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
}

export function useProjectContext(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) {
    throw new Error("useProjectContext must be used within a ProjectProvider");
  }
  return ctx;
}
