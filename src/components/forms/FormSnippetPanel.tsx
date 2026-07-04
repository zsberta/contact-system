// ----------------------------------------------------------------------------
// FormSnippetPanel — read-only card that shows the rendered <form> snippet
// for a given form id. The snippet is fetched lazily from /api/forms/:id/snippet
// which renders the literal HTML against the configured APP_PUBLIC_URL.
// A Copy button writes the snippet to the clipboard via
// navigator.clipboard.writeText and toasts on success.
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
import { getFormSnippet } from "@/lib/forms";
import { showError, showSuccess } from "@/utils/toast";

interface FormSnippetPanelProps {
  formId: number;
  allowedOrigins?: string[];
}

export function FormSnippetPanel({ formId, allowedOrigins }: FormSnippetPanelProps) {
  const { t } = useTranslation(["forms", "common"]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["form-snippet", formId],
    queryFn: () => getFormSnippet(formId),
    enabled: !!formId,
  });

  const handleCopy = async () => {
    if (!data?.html) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(data.html);
        showSuccess(t("forms:snippet_copied"));
      } else {
        // Fallback for older browsers without Clipboard API.
        const ta = document.createElement("textarea");
        ta.value = data.html;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("forms:snippet_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(t("forms:snippet_copy_failed", { error: message }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">{t("forms:snippet_title")}</CardTitle>
        <CardDescription>{t("forms:snippet_description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">
              {t("forms:allowed_origins_snippet_warning_title")}
            </p>
            <p className="mt-1">
              {t("forms:allowed_origins_snippet_warning_body", {
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
                {t("forms:snippet_origin_label")}:{" "}
                <span className="font-mono">{data?.origin}</span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={handleCopy}
              >
                <Copy className="mr-2 h-4 w-4" />
                {t("forms:copy_snippet")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("forms:snippet_help")}
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
