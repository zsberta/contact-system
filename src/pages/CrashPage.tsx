import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle, Home, ArrowLeft, RefreshCw } from "lucide-react";
import SEO from "@/components/SEO";

interface CrashPageProps {
  error?: Error | null;
  onReset?: () => void;
}

const CrashPage = ({ error, onReset }: CrashPageProps) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();

  return (
    <>
      <SEO
        title={t("error_crash_page_title")}
        description={t("error_crash_message")}
        keywords="error, crash, zsolts-crm"
        url="/crash"
        noindex={true}
      />
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background to-muted p-4">
      <Card className="w-full max-w-lg">
        <CardContent className="pt-8">
          <div className="text-center space-y-6">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-destructive/10">
              <AlertTriangle className="h-16 w-16 text-destructive" />
            </div>

            <h1 className="text-2xl font-bold text-foreground">
              {t("error_crash_title")}
            </h1>
            <p className="text-muted-foreground">{t("error_crash_message")}</p>

            <div className="inline-flex items-center gap-2 rounded-full bg-muted px-4 py-1.5 text-sm font-mono">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-destructive opacity-75"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-destructive"></span>
              </span>
              {t("error_code")}: CRASH
            </div>

            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Button
                variant="outline"
                onClick={() => { onReset?.(); navigate(-1); }}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t("go_back")}
              </Button>
              <Button
                variant="outline"
                onClick={() => window.location.reload()}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("reload_page")}
              </Button>
              <Button onClick={() => { onReset?.(); navigate("/dashboard"); }}>
                <Home className="mr-2 h-4 w-4" />
                {t("go_home")}
              </Button>
            </div>

            {error?.message && (
              <details className="text-left text-xs text-muted-foreground bg-muted/50 rounded-md p-3 max-w-md mx-auto">
                <summary className="cursor-pointer">Technical details (dev)</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words">{error.message}</pre>
              </details>
            )}
          </div>
        </CardContent>
      </Card>
      </div>
    </>
  );
};

export default CrashPage;
