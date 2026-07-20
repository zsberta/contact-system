// PortalBlogPage — enduser-facing blog post list for the currently
// selected project. Thin wrapper around BlogPage that reads the
// projectId from the project context.
//
// The backend scopes blog posts by the enduser's assigned projects
// (via getScopedProjectIds), so we don't need to pass projectId as
// a URL filter — the API already handles it server-side.
//
// Endusers have full CRUD access for blog posts. RBAC scope is
// enforced server-side; the FE shows create/edit/delete actions.

import { useProjectContext } from "@/context/ProjectContext";
import BlogPage from "./BlogPage";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export default function PortalBlogPage() {
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

  // If the user has projects but none is selected, redirect them to
  // the portal root which lets them pick one. Same UX as the other
  // portal pages.
  if (!projectId && projects && projects.length > 0) {
    return <Navigate to="/portal" replace />;
  }

  return (
    <div className="space-y-0">
      <BlogPage basePath="/portal/blog" />
    </div>
  );
}
