import { apiFetch } from "@/lib/api";
import type { ProjectModuleDTO } from "@/types/project-module";

export async function getProjectModules(
  projectId: number,
): Promise<ProjectModuleDTO[]> {
  return apiFetch<ProjectModuleDTO[]>(
    `/project-modules?projectId=${projectId}`,
  );
}

export async function getProjectModuleById(
  moduleId: number,
): Promise<ProjectModuleDTO> {
  return apiFetch<ProjectModuleDTO>(`/project-modules/${moduleId}`);
}
