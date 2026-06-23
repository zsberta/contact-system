import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

interface ErrorPageProps {
  errorCode?: number;
  title?: string;
  message?: string;
  showHomeButton?: boolean;
}

const ErrorIllustration = ({ errorCode = 500 }: { errorCode?: number }) => {
  if (errorCode === 404) {
    return (
      <svg
        viewBox="0 0 400 300"
        className="w-full max-w-md mx-auto"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop
              offset="0%"
              stopColor="hsl(var(--primary))"
              stopOpacity="0.8"
            />
            <stop
              offset="100%"
              stopColor="hsl(var(--primary))"
              stopOpacity="0.4"
            />
          </linearGradient>
        </defs>
        <circle
          cx="200"
          cy="150"
          r="80"
          fill="hsl(var(--muted))"
          opacity="0.3"
        />
        <circle
          cx="200"
          cy="150"
          r="60"
          fill="hsl(var(--muted))"
          opacity="0.5"
        />
        <path
          d="M160 120 L200 160 L240 120"
          stroke="hsl(var(--primary))"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="animate-pulse"
        />
        <circle cx="170" cy="130" r="4" fill="hsl(var(--primary))" />
        <circle cx="230" cy="130" r="4" fill="hsl(var(--primary))" />
        <path
          d="M170 170 Q200 190 230 170"
          stroke="hsl(var(--primary))"
          strokeWidth="4"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M120 220 L150 200 M280 220 L250 200 M140 240 L160 215 M260 240 L240 215"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.5"
        />
        <circle
          cx="100"
          cy="80"
          r="3"
          fill="hsl(var(--primary))"
          opacity="0.6"
        />
        <circle
          cx="320"
          cy="100"
          r="4"
          fill="hsl(var(--primary))"
          opacity="0.4"
        />
        <circle
          cx="80"
          cy="180"
          r="2"
          fill="hsl(var(--primary))"
          opacity="0.5"
        />
        <circle
          cx="340"
          cy="200"
          r="3"
          fill="hsl(var(--primary))"
          opacity="0.3"
        />
        <text
          x="200"
          y="280"
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize="14"
          fontFamily="system-ui"
          opacity="0.6"
        >
          404
        </text>
      </svg>
    );
  }

  if (errorCode === 403) {
    return (
      <svg
        viewBox="0 0 400 300"
        className="w-full max-w-md mx-auto"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="150"
          y="100"
          width="100"
          height="120"
          rx="8"
          fill="hsl(var(--muted))"
          opacity="0.3"
        />
        <rect
          x="160"
          y="110"
          width="80"
          height="100"
          rx="4"
          fill="hsl(var(--card))"
          stroke="hsl(var(--border))"
        />
        <rect
          x="175"
          y="125"
          width="50"
          height="6"
          rx="3"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <rect
          x="175"
          y="140"
          width="40"
          height="6"
          rx="3"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <rect
          x="175"
          y="155"
          width="45"
          height="6"
          rx="3"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <circle
          cx="250"
          cy="90"
          r="30"
          fill="hsl(var(--destructive))"
          opacity="0.9"
        />
        <path
          d="M235 75 L265 105 M265 75 L235 105"
          stroke="white"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M130 180 L145 165 M270 180 L255 165"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.4"
        />
        <circle
          cx="90"
          cy="100"
          r="3"
          fill="hsl(var(--primary))"
          opacity="0.5"
        />
        <circle
          cx="330"
          cy="130"
          r="4"
          fill="hsl(var(--primary))"
          opacity="0.4"
        />
        <text
          x="200"
          y="280"
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize="14"
          fontFamily="system-ui"
          opacity="0.6"
        >
          403
        </text>
      </svg>
    );
  }

  if (errorCode === 500) {
    return (
      <svg
        viewBox="0 0 400 300"
        className="w-full max-w-md mx-auto"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x="100"
          y="80"
          width="200"
          height="150"
          rx="8"
          fill="hsl(var(--muted))"
          opacity="0.3"
        />
        <rect
          x="110"
          y="90"
          width="180"
          height="130"
          rx="4"
          fill="hsl(var(--card))"
          stroke="hsl(var(--border))"
        />
        <rect
          x="120"
          y="100"
          width="60"
          height="110"
          fill="hsl(var(--muted))"
          opacity="0.5"
        />
        <rect
          x="130"
          y="110"
          width="40"
          height="8"
          rx="2"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <rect
          x="130"
          y="125"
          width="35"
          height="8"
          rx="2"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <rect
          x="130"
          y="140"
          width="38"
          height="8"
          rx="2"
          fill="hsl(var(--muted-foreground))"
          opacity="0.3"
        />
        <circle
          cx="240"
          cy="130"
          r="30"
          fill="hsl(var(--destructive))"
          opacity="0.2"
        />
        <path
          d="M225 115 L240 130 L255 115 M225 145 L240 130 L255 145"
          stroke="hsl(var(--destructive))"
          strokeWidth="3"
          strokeLinecap="round"
          className="animate-spin"
          style={{ transformOrigin: "240px 130px" }}
        />
        <path
          d="M80 250 L100 230 M320 250 L300 230"
          stroke="hsl(var(--muted-foreground))"
          strokeWidth="2"
          strokeLinecap="round"
          opacity="0.4"
        />
        <circle
          cx="70"
          cy="90"
          r="3"
          fill="hsl(var(--primary))"
          opacity="0.5"
        />
        <circle
          cx="340"
          cy="110"
          r="4"
          fill="hsl(var(--primary))"
          opacity="0.4"
        />
        <circle
          cx="60"
          cy="200"
          r="2"
          fill="hsl(var(--primary))"
          opacity="0.6"
        />
        <text
          x="200"
          y="280"
          textAnchor="middle"
          fill="hsl(var(--muted-foreground))"
          fontSize="14"
          fontFamily="system-ui"
          opacity="0.6"
        >
          500
        </text>
      </svg>
    );
  }

  return (
    <svg
      viewBox="0 0 400 300"
      className="w-full max-w-md mx-auto"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="200" cy="130" r="60" fill="hsl(var(--muted))" opacity="0.3" />
      <circle cx="200" cy="130" r="45" fill="hsl(var(--muted))" opacity="0.5" />
      <path
        d="M175 115 Q200 95 225 115"
        stroke="hsl(var(--primary))"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="185" cy="125" r="5" fill="hsl(var(--primary))" />
      <circle cx="215" cy="125" r="5" fill="hsl(var(--primary))" />
      <path
        d="M185 145 Q200 155 215 145"
        stroke="hsl(var(--primary))"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M160 165 L145 150 M240 165 L255 150"
        stroke="hsl(var(--muted-foreground))"
        strokeWidth="2"
        strokeLinecap="round"
        opacity="0.5"
      />
      <circle cx="100" cy="80" r="4" fill="hsl(var(--primary))" opacity="0.4" />
      <circle
        cx="310"
        cy="100"
        r="3"
        fill="hsl(var(--primary))"
        opacity="0.5"
      />
      <circle cx="80" cy="180" r="3" fill="hsl(var(--primary))" opacity="0.3" />
      <circle
        cx="330"
        cy="200"
        r="4"
        fill="hsl(var(--primary))"
        opacity="0.4"
      />
      <text
        x="200"
        y="280"
        textAnchor="middle"
        fill="hsl(var(--muted-foreground))"
        fontSize="14"
        fontFamily="system-ui"
        opacity="0.6"
      >
        Error
      </text>
    </svg>
  );
};

const ErrorPage = ({
  errorCode,
  title,
  message,
  showHomeButton = true,
}: ErrorPageProps) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();

  const getErrorTitle = () => {
    if (title) return title;
    switch (errorCode) {
      case 404:
        return t("error_404_title");
      case 403:
        return t("error_403_title");
      case 500:
        return t("error_500_title");
      default:
        return t("error_generic_title");
    }
  };

  const getErrorMessage = () => {
    if (message) return message;
    switch (errorCode) {
      case 404:
        return t("error_404_message");
      case 403:
        return t("error_403_message");
      case 500:
        return t("error_500_message");
      default:
        return t("error_generic_message");
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-background to-muted/20 p-4">
      <Card className="w-full max-w-lg border-0 shadow-lg bg-card/80 backdrop-blur-sm">
        <CardContent className="pt-8 pb-8 px-6">
          <div className="text-center space-y-6">
            <ErrorIllustration errorCode={errorCode} />

            <div className="space-y-2">
              <h1 className="text-2xl font-bold text-foreground">
                {getErrorTitle()}
              </h1>
              <p className="text-muted-foreground max-w-sm mx-auto">
                {getErrorMessage()}
              </p>
            </div>

            {!!errorCode && (
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-muted text-muted-foreground text-sm">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive"></span>
                </span>
                {t("error_code")}: {errorCode}
              </div>
            )}

            {showHomeButton && (
              <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
                <Button
                  variant="outline"
                  onClick={() => navigate(-1)}
                  className="gap-2"
                >
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m12 19-7-7 7-7" />
                    <path d="M19 12H5" />
                  </svg>
                  {t("go_back")}
                </Button>
                <Button onClick={() => navigate("/")} className="gap-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
                    <polyline points="9 22 9 12 15 12 15 22" />
                  </svg>
                  {t("go_home")}
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default ErrorPage;
