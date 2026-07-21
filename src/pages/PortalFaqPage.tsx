// PortalFaqPage — enduser-facing FAQ list for the currently
// selected project. Thin wrapper around FaqPage that reads the
// projectId from the project context.
//
// The backend scopes FAQ items by the enduser's assigned projects
// (via getScopedProjectIds), so we don't need to pass projectId as
// a URL filter — the API already handles it server-side.
//
// Endusers have full CRUD access for FAQ items. RBAC scope is
// enforced server-side; the FE shows create/edit/delete actions.

import { useProjectContext } from "@/context/ProjectContext";
import FaqPage from "./FaqPage";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function PortalFaqPage() {
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
      <FaqPage basePath="/portal/faq" contextProjectId={projectId} />
    </div>
  );
}
