// SubmissionDetailModal — clean Dialog for viewing submission/booking details.
// Shows only the user-facing data (submitted fields + dates), not audit
// metadata (IP, user-agent, referrer). Field keys are mapped to friendly
// Hungarian/English labels using the same pattern as lib/email-templates.js.

import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

import { labelFor, formatValue } from "@/components/submissions/field-labels";

// ── Types ───────────────────────────────────────────────────────────────

export interface SubmissionDetailData {
  /** For form submissions */
  submittedAt?: string;
  /** For reservation bookings */
  startsAt?: string;
  endsAt?: string;
  bookedAt?: string;
  /** The user-supplied data bag */
  data: Record<string, unknown> | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  isLoading?: boolean;
  error?: string | null;
  submission: SubmissionDetailData | null;
}

// ── Component ───────────────────────────────────────────────────────────

export function SubmissionDetailModal({
  open,
  onClose,
  title,
  isLoading = false,
  error = null,
  submission,
}: Props) {
  const { t, i18n } = useTranslation(["submissions", "common"]);
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";

  const data = submission?.data ?? {};
  const dataKeys = Object.keys(data);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-lg">{title}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 -mx-6 px-6 space-y-4">
          {isLoading && (
            <div className="space-y-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          {submission && !isLoading && !error && (
            <>
              {/* Dates section */}
              {submission.startsAt && submission.endsAt && (() => {
                const startDate = new Date(submission.startsAt);
                const endDate = new Date(submission.endsAt);
                const sameDay =
                  startDate.toISOString().slice(0, 10) ===
                  endDate.toISOString().slice(0, 10);
                return (
                  <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                    {sameDay ? (
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-muted-foreground">
                          {t("submissions:time_range")}
                        </span>
                        <span className="text-sm font-medium">
                          {startDate.toLocaleDateString()}{" "}
                          {startDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{" "}
                          –{" "}
                          {endDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            {t("submissions:starts_at")}
                          </span>
                          <span className="text-sm font-medium">
                            {startDate.toLocaleString()}
                          </span>
                        </div>
                        <Separator />
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            {t("submissions:ends_at")}
                          </span>
                          <span className="text-sm font-medium">
                            {endDate.toLocaleString()}
                          </span>
                        </div>
                      </>
                    )}
                    {submission.bookedAt && (
                      <>
                        <Separator />
                        <div className="flex items-center justify-between">
                          <span className="text-sm text-muted-foreground">
                            {t("submissions:booked_at")}
                          </span>
                          <span className="text-sm font-medium">
                            {new Date(submission.bookedAt).toLocaleString()}
                          </span>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

              {/* Submitted at (forms only) */}
              {submission.submittedAt && !submission.startsAt && (
                <div className="rounded-lg border bg-muted/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">
                      {t("submissions:submitted_at")}
                    </span>
                    <span className="text-sm font-medium">
                      {new Date(submission.submittedAt).toLocaleString()}
                    </span>
                  </div>
                </div>
              )}

              {/* Data fields */}
              {dataKeys.length > 0 ? (
                <div className="space-y-2">
                  {dataKeys.map((key) => {
                    const value = data[key];
                    const displayValue = formatValue(value, locale);

                    return (
                      <div
                        key={key}
                        className="flex flex-col gap-0.5 rounded-md border p-3"
                      >
                        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                          {labelFor(key, locale)}
                        </span>
                        <span className="text-sm font-medium break-words">
                          {displayValue}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-4">
                  {t("submissions:no_data")}
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
