// PortalServicePage — enduser-facing Service list for the currently
// selected project. Thin wrapper around ServicePage that reads the
// projectId from the project context.
//
// The backend scopes Service items by the enduser's assigned projects
// (via getScopedProjectIds), so we don't need to pass projectId as
// a URL filter — the API already handles it server-side.
//
// Endusers have full CRUD access for Service items. RBAC scope is
// enforced server-side; the FE shows create/edit/delete actions.

import { useProjectContext } from "@/context/ProjectContext";
import ServicePage from "./ServicePage";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function PortalServicePage() {
  const { selectedId: projectId, projects, isLoading } = useProjectContext();

  if (isLoading) {
    return (
      <div className="container mx-auto p-4">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!projectId && projects && projects.length > 0) {
    return <Navigate to="/portal" replace />;
  }

  return (
    <div className="space-y-0">
      <ServicePage basePath="/portal/services" contextProjectId={projectId} />
    </div>
  );
}
