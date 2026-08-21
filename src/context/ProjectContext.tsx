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

  const selectedProject =
    projects.find((p) => p.id === parsedProjectId) ?? null;

  const { data: modules = [], isLoading: isModulesLoading } = useQuery({
    queryKey: ["workspace", "modules", selectedProject?.id],
    queryFn: () => getProjectModules(selectedProject!.id),
    enabled: !!selectedProject?.id,
  });

  const selectedModule =
    modules.find((m) => Number(m.id) === parsedModuleId) ?? null;

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
