// ----------------------------------------------------------------------------
// FormSubmissionsPage — submissions list for a form.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { getFormById } from "@/lib/forms";
import { FormSubmissionsList } from "@/components/forms/FormSubmissionsList";
import { useModuleResolution } from "@/hooks/useModuleResolution";

export default function FormSubmissionsPage() {
  const { t } = useTranslation(["forms", "common"]);
  const { resourceId: formId } = useModuleResolution();

  const { isLoading } = useQuery({
    queryKey: ["forms", formId],
    queryFn: () => getFormById(formId!),
    enabled: !!formId,
  });

  if (!formId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      ) : (
        <FormSubmissionsList formId={formId} />
      )}
    </div>
  );
}
