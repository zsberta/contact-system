// ProjectContext — shared state for the enduser's selected project.
// Used by the Layout header (project selector) and portal pages (projectId).
// Only rendered for endusers; admins don't need it.

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAllProjectsPaged } from "@/lib/api";
import type { ProjectDTO } from "@/types/project";

const STORAGE_KEY = "enduser_selected_project_id";

interface ProjectContextValue {
  projects: ProjectDTO[];
  selectedId: number | undefined;
  selectedProject: ProjectDTO | null;
  setSelectedId: (id: number) => void;
  isLoading: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery({
    queryKey: ["portal", "projects", "selector"],
    queryFn: () =>
      getAllProjectsPaged({
        page: 0,
        size: 500,
        sortField: "name",
        sortOrder: "asc",
      }),
  });

  const projects = data?.content ?? [];

  const [selectedId, setSelectedIdState] = useState<number | undefined>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = Number(stored);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  });

  // Once projects load, validate the selection or default to first.
  useEffect(() => {
    if (projects.length === 0) return;
    if (selectedId && projects.some((p) => p.id === selectedId)) return;
    setSelectedIdState(projects[0].id);
    localStorage.setItem(STORAGE_KEY, String(projects[0].id));
  }, [projects, selectedId]);

  const setSelectedId = useCallback((id: number) => {
    setSelectedIdState(id);
    localStorage.setItem(STORAGE_KEY, String(id));
  }, []);

  const selectedProject = projects.find((p) => p.id === selectedId) ?? null;

  return (
    <ProjectContext.Provider
      value={{ projects, selectedId, selectedProject, setSelectedId, isLoading }}
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
