// ----------------------------------------------------------------------------
// AiAssistantSnippetPanel — read-only card that shows the rendered <script>
// snippet for a given AI assistant config id. Mirrors AnalyticsSnippetPanel.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, ClipboardCheck } from "lucide-react";
import { getAiAssistantSnippet } from "@/lib/ai-assistant";
import { showError, showSuccess } from "@/utils/toast";

interface AiAssistantSnippetPanelProps {
  configId: number;
  allowedOrigins?: string[];
}

export function AiAssistantSnippetPanel({
  configId,
  allowedOrigins,
}: AiAssistantSnippetPanelProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-assistant-snippet", configId],
    queryFn: () => getAiAssistantSnippet(configId),
    enabled: !!configId,
  });

  const handleCopy = async () => {
    if (!data?.html) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(data.html);
        showSuccess(t("ai-assistant:snippet_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = data.html;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("ai-assistant:snippet_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(t("ai-assistant:snippet_copy_failed", { error: message }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("ai-assistant:snippet_title")}</CardTitle>
        <CardDescription>{t("ai-assistant:snippet_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">
              {t("ai-assistant:allowed_origins_label")}
            </p>
            <p className="mt-1">
              {t("ai-assistant:allowed_origins_count", {
                count: allowedOrigins.length,
              })}
            </p>
          </div>
        )}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t("common:loading")}</p>
        ) : error ? (
          <p className="text-sm text-destructive">
            {t("common:operation_failed", {
              error: (error as Error).message,
            })}
          </p>
        ) : (
          <>
            <pre className="overflow-x-auto rounded-md bg-muted p-4 text-xs font-mono">
              <code>{data?.html}</code>
            </pre>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground break-all">
                {t("ai-assistant:secret_token")}:{" "}
                <span className="font-mono">{data?.secretToken}</span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopy}
              >
                <Copy className="mr-2 h-4 w-4" />
                {t("ai-assistant:copy_snippet")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("ai-assistant:snippet_help")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("ai-assistant:snippet_language_override")}
            </p>
          </>
        )}
        <span className="sr-only">
          <ClipboardCheck />
        </span>
      </CardContent>
    </Card>
  );
}
