import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth, landingRouteForRole } from "@/context/AuthContext";

/**
 * 404 page rendered inside the authenticated Layout shell.
 *
 * NOTE: This sits under <ProtectedRoute> → <Layout> in the route tree
 * (see App.tsx), which is why we render a compact centered card here
 * instead of the full-viewport ErrorPage component — that component
 * uses min-h-screen and is meant for standalone routes like
 * /no-permission and /crash that live outside the chrome.
 */
const NotFound = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation("common");
  const { user } = useAuth();

  useEffect(() => {
    console.error(
      "404 Error: User attempted to access non-existent route:",
      location.pathname,
    );
  }, [location.pathname]);

  const homePath = user?.role ? landingRouteForRole(user.role) : "/dashboard";

  return (
    <div className="flex flex-1 items-center justify-center p-4 lg:p-6">
      <div className="w-full max-w-md text-center space-y-6">
        <div className="space-y-2">
          <p className="text-7xl font-bold tracking-tight text-primary">404</p>
          <h1 className="text-xl font-semibold text-foreground">
            {t("error_404_title")}
          </h1>
          <p className="text-muted-foreground">{t("error_404_message")}</p>
        </div>

        <div className="flex flex-col sm:flex-row gap-2 justify-center pt-2">
          <Button
            variant="outline"
            onClick={() => navigate(-1)}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("go_back")}
          </Button>
          <Button onClick={() => navigate(homePath)} className="gap-2">
            <Home className="h-4 w-4" />
            {t("go_home")}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default NotFound;
