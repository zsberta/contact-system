// PortalBlogPage — enduser-facing blog post list for the currently
// selected project. Thin wrapper around BlogPage that reads the
// projectId from the project context and pushes it through the URL so
// the BlogPage filter picks it up.
//
// Endusers have read-only access (RBAC scope is enforced server-side;
// the FE just doesn't surface the publish/delete actions for posts
// they don't own — those are still rendered, but the actions component
// shows them as disabled when the server denies the mutation).

import { useProjectContext } from "@/context/ProjectContext";
import BlogPage from "./BlogPage";
import { useSearchParams, Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function PortalBlogPage() {
  const { selectedId: projectId, projects, isLoading } = useProjectContext();
  const [searchParams] = useSearchParams();

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

  // If the user has projects but none is selected, redirect them to
  // the portal root which lets them pick one. Same UX as the other
  // portal pages.
  if (!projectId && projects && projects.length > 0) {
    return <Navigate to="/portal" replace />;
  }

  // Push projectId into the query string so BlogPage's deep-link filter
  // picks it up. We don't override the operator's other params
  // (status, locale).
  const params = new URLSearchParams(searchParams);
  if (projectId) {
    params.set("projectId", String(projectId));
  }

  return (
    <div className="space-y-0">
      <BlogPage basePath="/portal/blog" showCreateButton={false} />
    </div>
  );
}
