// ----------------------------------------------------------------------------
// AiAssistantSnippetPanel — embed code + documentation for the AI assistant
// widget. Shows the copy-paste snippet and explains all configuration options.
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
import { Copy, ClipboardCheck, Globe, Code, Terminal, MousePointer } from "lucide-react";
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
    <div className="space-y-4">
      {/* Embed code card */}
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
            </>
          )}
          <span className="sr-only">
            <ClipboardCheck />
          </span>
        </CardContent>
      </Card>

      {/* Documentation card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Globe className="h-5 w-5" />
            {t("ai-assistant:docs_title")}
          </CardTitle>
          <CardDescription>
            {t("ai-assistant:docs_description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 1. Installation */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Code className="h-4 w-4" />
              {t("ai-assistant:docs_install_title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("ai-assistant:docs_install_text")}
            </p>
            <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono">
              <code>{data?.html || '<script src="..." defer></script>'}</code>
            </pre>
          </section>

          {/* 2. Language configuration */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Globe className="h-4 w-4" />
              {t("ai-assistant:docs_language_title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("ai-assistant:docs_language_text")}
            </p>

            {/* Method A: data-lang */}
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs font-semibold">{t("ai-assistant:docs_lang_method_a")}</p>
              <p className="text-xs text-muted-foreground">{t("ai-assistant:docs_lang_method_a_desc")}</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs font-mono">
                <code>{`<script src="${data?.origin || '...'}/api/public/ai-assistant/${data?.secretToken || '...'}/script.js" data-lang="hu" defer></script>`}</code>
              </pre>
            </div>

            {/* Method B: JavaScript API */}
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs font-semibold">{t("ai-assistant:docs_lang_method_b")}</p>
              <p className="text-xs text-muted-foreground">{t("ai-assistant:docs_lang_method_b_desc")}</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs font-mono">
                <code>{`// Change language programmatically\nwindow.__aiAssistant.setLanguage('hu');`}</code>
              </pre>
            </div>

            {/* Method C: CustomEvent */}
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs font-semibold">{t("ai-assistant:docs_lang_method_c")}</p>
              <p className="text-xs text-muted-foreground">{t("ai-assistant:docs_lang_method_c_desc")}</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs font-mono">
                <code>{`// Dispatch a language-change event\ndocument.dispatchEvent(\n  new CustomEvent('ai-assistant:language-change', {\n    detail: { lang: 'hu' }\n  })\n);`}</code>
              </pre>
            </div>

            {/* Method D: MutationObserver */}
            <div className="rounded-md border p-3 space-y-1">
              <p className="text-xs font-semibold">{t("ai-assistant:docs_lang_method_d")}</p>
              <p className="text-xs text-muted-foreground">{t("ai-assistant:docs_lang_method_d_desc")}</p>
              <pre className="overflow-x-auto rounded bg-muted p-2 text-xs font-mono">
                <code>{`// Change the data-lang attribute — the widget auto-detects\nvar script = document.querySelector('script[data-lang]');\nscript.setAttribute('data-lang', 'en');`}</code>
              </pre>
            </div>
          </section>

          {/* 3. Features */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Terminal className="h-4 w-4" />
              {t("ai-assistant:docs_features_title")}
            </h3>
            <ul className="text-sm text-muted-foreground space-y-1 list-disc pl-5">
              <li>{t("ai-assistant:docs_feature_chat")}</li>
              <li>{t("ai-assistant:docs_feature_popup")}</li>
              <li>{t("ai-assistant:docs_feature_greeting")}</li>
              <li>{t("ai-assistant:docs_feature_legal")}</li>
              <li>{t("ai-assistant:docs_feature_branding")}</li>
              <li>{t("ai-assistant:docs_feature_rag")}</li>
              <li>{t("ai-assistant:docs_feature_mobile")}</li>
            </ul>
          </section>

          {/* 4. How it works */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <MousePointer className="h-4 w-4" />
              {t("ai-assistant:docs_how_title")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("ai-assistant:docs_how_text")}
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
