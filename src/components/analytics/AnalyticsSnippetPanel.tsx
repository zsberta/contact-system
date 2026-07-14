// ----------------------------------------------------------------------------
// AnalyticsSnippetPanel — read-only card that shows the rendered <script>
// snippet for a given analytics config id. Fetches lazily from
// /api/analytics/:id/snippet which renders the literal HTML against the
// configured APP_PUBLIC_URL. A Copy button writes the snippet to the
// clipboard via navigator.clipboard.writeText and toasts on success.
// Mirrors FormSnippetPanel structurally (one-line diff: title + i18n ns).
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
import { getAnalyticsSnippet } from "@/lib/analytics";
import { showError, showSuccess } from "@/utils/toast";

interface AnalyticsSnippetPanelProps {
  configId: number;
  allowedOrigins?: string[];
}

export function AnalyticsSnippetPanel({
  configId,
  allowedOrigins,
}: AnalyticsSnippetPanelProps) {
  const { t } = useTranslation(["analytics", "common"]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["analytics-snippet", configId],
    queryFn: () => getAnalyticsSnippet(configId),
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
        showSuccess(t("analytics:snippet_copied"));
      } else {
        // Fallback for older browsers without Clipboard API.
        const ta = document.createElement("textarea");
        ta.value = data.html;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("analytics:snippet_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(t("analytics:snippet_copy_failed", { error: message }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("analytics:snippet_title")}</CardTitle>
        <CardDescription>{t("analytics:snippet_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">
              {t("analytics:allowed_origins_snippet_warning_title")}
            </p>
            <p className="mt-1">
              {t("analytics:allowed_origins_snippet_warning_body", {
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
                {t("analytics:snippet_origin_label")}:{" "}
                <span className="font-mono">{data?.origin}</span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopy}
              >
                <Copy className="mr-2 h-4 w-4" />
                {t("analytics:copy_snippet")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("analytics:snippet_help")}
            </p>
            <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40">
              <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
                {t("analytics:snippet_consent_help")}
              </p>
              <pre className="overflow-x-auto rounded bg-amber-100/60 p-3 text-xs font-mono text-amber-950 dark:bg-amber-900/40 dark:text-amber-50">
                <code>{t("analytics:snippet_consent_code")}</code>
              </pre>
              <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
                {t("analytics:snippet_consent_note")}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("analytics:event_tracking_help")}
            </p>
            <details className="rounded-md border border-border bg-muted/40 p-3">
              <summary className="cursor-pointer text-xs font-medium text-foreground">
                {t("analytics:data_collected_title")}
              </summary>
              <div className="mt-3 space-y-3 text-xs text-muted-foreground">
                <p>{t("analytics:data_collected_intro")}</p>
                <div>
                  <p className="font-medium text-foreground">
                    {t("analytics:data_collected_client_title")}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    <li>{t("analytics:data_field_path")}</li>
                    <li>{t("analytics:data_field_referrer")}</li>
                    <li>{t("analytics:data_field_title")}</li>
                    <li>{t("analytics:data_field_locale")}</li>
                    <li>{t("analytics:data_field_screen")}</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {t("analytics:data_collected_generated_title")}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    <li>{t("analytics:data_field_visitor_id")}</li>
                    <li>{t("analytics:data_field_session_id")}</li>
                    <li>{t("analytics:data_field_timestamp")}</li>
                  </ul>
                </div>
                <div>
                  <p className="font-medium text-foreground">
                    {t("analytics:data_collected_server_title")}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">
                    <li>{t("analytics:data_field_ip")}</li>
                    <li>{t("analytics:data_field_user_agent")}</li>
                  </ul>
                </div>
                <p>{t("analytics:data_collected_not_collected")}</p>
                <p>{t("analytics:data_collected_storage")}</p>
              </div>
            </details>
          </>
        )}
        <span className="sr-only">
          <ClipboardCheck />
        </span>
      </CardContent>
    </Card>
  );
}
