import type { ProjectModuleKind } from "@/types/project-module";
import { getProjectModules } from "@/lib/project-modules";

/**
 * Default subpage per module kind for endusers.
 * Maps to the first page in the sidebar that is NOT adminOnly.
 * Admins always get "details" (handled by getDefaultPage).
 */
const ENDUSER_DEFAULT_PAGE: Record<ProjectModuleKind, string> = {
  reservation: "services",
  form: "details",
  analytics: "details",
  "ai-assistant": "details",
  blog: "posts",
  faq: "items",
  service: "items",
};

/**
 * Returns the default subpage for a module kind based on user role.
 * Admins always land on "details"; endusers land on the first
 * non-adminOnly page (mirrors Sidebar filtering).
 */
export function getDefaultPage(
  moduleKind: ProjectModuleKind,
  role: "admin" | "enduser" = "admin",
): string {
  return role === "admin" ? "details" : ENDUSER_DEFAULT_PAGE[moduleKind] ?? "details";
}

export function buildWorkspaceProjectPath(projectId: number): string {
  return `/workspace/projects/${projectId}`;
}

export function buildWorkspaceModulePath(
  projectId: number,
  moduleKind: ProjectModuleKind,
  moduleId: number,
  page = "details",
): string {
  return `/workspace/projects/${projectId}/modules/${moduleKind}/${moduleId}/${page}`;
}

export function buildWorkspaceModuleChildPath(
  projectId: number,
  moduleKind: ProjectModuleKind,
  moduleId: number,
  page: string,
  childPath: string,
): string {
  return `/workspace/projects/${projectId}/modules/${moduleKind}/${moduleId}/${page}/${childPath}`;
}

/**
 * Resolve a module's workspace path from projectId + kind.
 * Fetches the project's module list, finds the matching kind, and returns
 * the workspace path.  Returns null if the module doesn't exist.
 *
 * Intended for navigation from pages that only have projectId (e.g. admin
 * list pages, project-view cards).
 */
export async function resolveModulePath(
  projectId: number,
  kind: ProjectModuleKind,
  page = "details",
): Promise<string | null> {
  const modules = await getProjectModules(projectId);
  const mod = modules.find((m) => m.kind === kind);
  if (!mod) return null;
  return buildWorkspaceModulePath(projectId, kind, mod.id, page);
}


