// ----------------------------------------------------------------------------
// FormSubmissionDetailsSheet — slides-from-right sheet that shows the full
// submission JSON + metadata. Read-only. Fetches via getFormSubmissionById.
// Renders `data` as a raw-JSON tree (no field-snapshot labelling, since
// forms have no schema).
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetClose,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { getFormSubmissionById } from "@/lib/forms";
import type { FormSubmissionDTO } from "@/types/form";

interface Props {
  formId: number;
  submissionId: number | null;
  open: boolean;
  onClose: () => void;
}

export function FormSubmissionDetailsSheet({
  formId,
  submissionId,
  open,
  onClose,
}: Props) {
  const { t } = useTranslation(["forms", "common"]);

  const enabled = open && submissionId !== null;
  const { data, isLoading, error } = useQuery<FormSubmissionDTO, Error>({
    queryKey: ["form-submission", formId, submissionId],
    queryFn: () => getFormSubmissionById(formId, submissionId!),
    enabled,
  });

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t("forms:submission_details")}</SheetTitle>
          <SheetDescription>
            {submissionId ? `#${submissionId}` : ""}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-4">
          {isLoading && (
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive">
              {t("common:operation_failed", { error: error.message })}
            </div>
          )}
          {data && (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("forms:submission_submitted_at")}
                </p>
                <p className="text-sm">{new Date(data.submittedAt).toLocaleString()}</p>
              </div>
              <Separator />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("forms:submission_ip")}
                </p>
                <p className="text-sm font-mono">{data.ipAddress ?? "—"}</p>
              </div>
              <Separator />
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("forms:submission_locale")}
                </p>
                <p className="text-sm">{data.locale ?? "—"}</p>
              </div>
              <Separator />
              {data.userAgent !== null && (
                <>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {t("forms:submission_user_agent")}
                    </p>
                    <p className="text-xs font-mono break-all">{data.userAgent}</p>
                  </div>
                  <Separator />
                </>
              )}
              {data.referer !== null && (
                <>
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {t("forms:submission_referer")}
                    </p>
                    <p className="text-xs font-mono break-all">{data.referer}</p>
                  </div>
                  <Separator />
                </>
              )}
              <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">
                  {t("forms:submission_data")}
                </p>
                {/* Forms have no field-schema, so the submission data is
                    always rendered as raw JSON. */}
                <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono">
                  <code>{JSON.stringify(data.data ?? {}, null, 2)}</code>
                </pre>
              </div>
            </>
          )}
        </div>

        <SheetFooter className="mt-6">
          <SheetClose asChild>
            <Button type="button" variant="outline" onClick={onClose}>
              {t("forms:submission_close")}
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
