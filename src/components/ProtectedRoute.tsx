import React from "react";
import { Navigate, useLocation, Outlet } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  children?: React.ReactNode;
  // Whitelist of roles allowed on this branch. Defaults to ["admin"]
  // (the historical behaviour) so existing routes are unchanged.
  // The enduser portal sets `roles={["enduser"]}` to lock out admins
  // and vice-versa.
  roles?: ("admin" | "enduser")[];
  // Where to send users that don't satisfy the role check. Defaults to
  // the role-appropriate landing page (admin → /dashboard, enduser →
  // /portal) so a stale localStorage role doesn't bounce the user to
  // a confusing 404.
  fallbackPath?: string;
  requiredPermissions?: { name: string; action: string }[];
  requiredAnyPermission?: boolean; // OR logic vs AND (default is AND)
}

const defaultLanding = (role) => (role === "enduser" ? "/portal" : "/dashboard");

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  roles,
  fallbackPath,
  requiredPermissions,
  requiredAnyPermission = false,
}) => {
  const { isAuthenticated, isLoading, passwordChangeRequired, user } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (passwordChangeRequired && location.pathname !== "/change-password") {
    return <Navigate to="/change-password" replace />;
  }

  if (!passwordChangeRequired && location.pathname === "/change-password") {
    const dest = defaultLanding(user?.role);
    return <Navigate to={dest} replace />;
  }

  // Role check (after the password-change gate so users with a
  // must-set-password flag always hit the change-password page first).
  if (roles && roles.length > 0 && user) {
    if (!roles.includes(user.role)) {
      const dest = fallbackPath || defaultLanding(user.role);
      return <Navigate to={dest} replace />;
    }
  }

  // Stub permissions gate — kept for backwards compatibility with the
  // existing route tree. The v1 enduser module doesn't define a real
  // permission catalog, so the check always passes (mirrors the old
  // usePermission stub). Replace when a real permission system lands.
  if (requiredPermissions && requiredPermissions.length > 0) {
    const hasAccess = requiredAnyPermission
      ? requiredPermissions.length > 0
      : true;
    if (!hasAccess) {
      return <Navigate to={fallbackPath || defaultLanding(user?.role)} replace />;
    }
  }

  // Use children if provided (single page route), otherwise use Outlet for nested routes
  return children ? children : <Outlet />;
};

export default ProtectedRoute;
