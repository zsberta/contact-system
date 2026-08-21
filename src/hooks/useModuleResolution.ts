import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { getProjectModuleById } from "@/lib/project-modules";

/**
 * Resolves the resource ID from either a workspace route (moduleId → resourceId)
 * or a legacy route (id used directly as resourceId).
 *
 * Returns { resourceId, moduleId, isLegacy } where:
 * - resourceId: the source config/content table ID
 * - moduleId: the project_modules.id (null for legacy routes)
 * - isLegacy: true if the route is a legacy /:id route, not a workspace /modules/:moduleId route
 */
export function useModuleResolution() {
  const { moduleId, id } = useParams<{ moduleId: string; id: string }>();

  const parsedModuleId = moduleId ? Number(moduleId) : undefined;
  const parsedLegacyId = id ? Number(id) : undefined;

  const { data: module, isLoading } = useQuery({
    queryKey: ["project-module", parsedModuleId],
    queryFn: () => getProjectModuleById(parsedModuleId!),
    enabled: !!parsedModuleId,
  });

  if (parsedModuleId && module) {
    return {
      resourceId: module.resourceId,
      moduleId: parsedModuleId,
      isLegacy: false,
      isLoading,
    };
  }

  if (parsedModuleId && isLoading) {
    return { resourceId: null, moduleId: parsedModuleId, isLegacy: false, isLoading: true };
  }

  // Legacy route — id is the resource ID directly.
  return {
    resourceId: parsedLegacyId ?? null,
    moduleId: null,
    isLegacy: true,
    isLoading: false,
  };
}
