import React from "react";
import { Navigate, useLocation, Outlet } from "react-router-dom";
import { useAuth } from "@/context/AuthContext";
import { usePermission } from "@/hooks/usePermission";
import { Loader2 } from "lucide-react";

interface ProtectedRouteProps {
  children?: React.ReactNode;
  requiredPermissions?: { name: string; action: string }[];
  requiredAnyPermission?: boolean; // OR logic vs AND (default is AND)
  fallbackPath?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredPermissions,
  requiredAnyPermission = false,
  fallbackPath = "/dashboard",
}) => {
  const { isAuthenticated, isLoading, passwordChangeRequired } = useAuth();
  const { hasPermission, hasAnyPermission, hasAllPermissions } = usePermission();
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
    return <Navigate to="/dashboard" replace />;
  }

  // Check permissions if requiredPermissions is specified
  if (requiredPermissions && requiredPermissions.length > 0) {
    const hasAccess = requiredAnyPermission
      ? hasAnyPermission(requiredPermissions)
      : hasAllPermissions(requiredPermissions);

    if (!hasAccess) {
      return <Navigate to={fallbackPath} replace />;
    }
  }

  // Use children if provided (single page route), otherwise use Outlet for nested routes
  return children ? children : <Outlet />;
};

export default ProtectedRoute;
