import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { Lock, Home, ArrowLeft } from "lucide-react";

const NoPermissionPage = () => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/20 p-4">
      <Card className="w-full max-w-lg border-0 shadow-lg bg-card/80 backdrop-blur-sm">
        <CardContent className="pt-8 pb-8 px-6">
          <div className="text-center space-y-6">
            {/* Lock Icon */}
            <div className="flex justify-center">
              <div className="rounded-full bg-destructive/10 p-6">
                <Lock className="h-16 w-16 text-destructive" />
              </div>
            </div>

            {/* Title */}
            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-foreground">
                {t("error_403_title")}
              </h1>
              <p className="text-muted-foreground max-w-sm mx-auto">
                {t("error_403_message")}
              </p>
            </div>

            {/* Error Code Badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-sm">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
              </span>
              {t("error_code")}: 403
            </div>

            {/* Action Buttons */}
            <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => navigate(-1)}
                className="gap-2"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("go_back")}
              </Button>
              <Button onClick={() => navigate("/dashboard")} className="gap-2">
                <Home className="h-4 w-4" />
                {t("go_home")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default NoPermissionPage;
