// ----------------------------------------------------------------------------
// ReservationSnippetPanel — read-only card showing the rendered <form>
// snippet for a given reservation id. Mirrors FormSnippetPanel but adds
// display of the availability endpoint + granularity / slot / lead-time
// / max-advance configuration so the operator can verify what the landing
// page will see.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Copy, ClipboardCheck, Link as LinkIcon } from "lucide-react";
import { getReservationSnippet } from "@/lib/reservations";
import { showError, showSuccess } from "@/utils/toast";

interface ReservationSnippetPanelProps {
  reservationId: number;
  allowedOrigins?: string[];
}

export function ReservationSnippetPanel({
  reservationId,
  allowedOrigins,
}: ReservationSnippetPanelProps) {
  const { t } = useTranslation(["reservations", "common"]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["reservation-snippet", reservationId],
    queryFn: () => getReservationSnippet(reservationId),
    enabled: !!reservationId,
  });

  const handleCopy = async (value: string | undefined, successKey: string) => {
    if (!value) return;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        showSuccess(t(successKey));
      } else {
        const ta = document.createElement("textarea");
        ta.value = value;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t(successKey));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(t("reservations:snippet_copy_failed", { error: message }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">
          {t("reservations:snippet_title")}
        </CardTitle>
        <CardDescription>
          {t("reservations:snippet_description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {Array.isArray(allowedOrigins) && allowedOrigins.length > 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
            <p className="font-medium">
              {t("reservations:allowed_origins_snippet_warning_title")}
            </p>
            <p className="mt-1">
              {t("reservations:allowed_origins_snippet_warning_body", {
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

            {/* Configured endpoints */}
            {data && (
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-muted-foreground break-all flex items-center gap-1">
                    <LinkIcon className="h-3 w-3" />
                    {t("reservations:availability_endpoint_label")}:
                  </p>
                  <div className="flex items-center gap-2">
                    <InputReadOnly
                      value={data.availabilityEndpoint}
                      aria-label={t(
                        "reservations:availability_endpoint_label",
                      )}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleCopy(
                          data.availabilityEndpoint,
                          "reservations:availability_endpoint_copied",
                        )
                      }
                    >
                      <Copy className="mr-2 h-3 w-3" />
                      {t("reservations:copy")}
                    </Button>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground break-all flex items-center gap-1">
                    <LinkIcon className="h-3 w-3" />
                    {t("reservations:submission_endpoint_label")}:
                  </p>
                  <div className="flex items-center gap-2">
                    <InputReadOnly
                      value={data.submissionEndpoint}
                      aria-label={t(
                        "reservations:submission_endpoint_label",
                      )}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleCopy(
                          data.submissionEndpoint,
                          "reservations:submission_endpoint_copied",
                        )
                      }
                    >
                      <Copy className="mr-2 h-3 w-3" />
                      {t("reservations:copy")}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground break-all">
                {t("reservations:snippet_origin_label")}:{" "}
                <span className="font-mono">{data?.origin}</span>
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() =>
                  handleCopy(data?.html, "reservations:snippet_copied")
                }
              >
                <Copy className="mr-2 h-4 w-4" />
                {t("reservations:copy_snippet")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("reservations:snippet_help")}
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

// Tiny inline read-only input — keeps the panel self-contained without
// pulling in form wrappers.
function InputReadOnly({ value, ...rest }: { value: string }) {
  return (
    <input
      type="text"
      readOnly
      value={value}
      className="flex h-9 w-full rounded-md border border-input bg-muted px-3 py-1 text-xs font-mono shadow-sm"
      {...rest}
    />
  );
}
