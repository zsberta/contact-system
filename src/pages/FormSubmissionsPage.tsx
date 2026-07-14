// ----------------------------------------------------------------------------
// FormSubmissionsPage — submissions list tab, rendered as a standalone page
// with the same tab nav bar as FormViewPage.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { NavLink, useParams } from "react-router-dom";
import { Loader2, FileText, List } from "lucide-react";
import { cn } from "@/lib/utils";
import { getFormById } from "@/lib/forms";
import { FormSubmissionsList } from "@/components/forms/FormSubmissionsList";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground";

export default function FormSubmissionsPage() {
  const { t } = useTranslation(["forms", "common"]);
  const { id } = useParams<{ id: string }>();
  const formId = id ? Number.parseInt(id) : null;

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
      {/* Tab navigation */}
      <nav className="flex gap-1 border-b pb-px">
        <NavLink
          to={`/forms/view/${formId}`}
          end
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <FileText className="h-4 w-4" />
          {t("forms:details_tab")}
        </NavLink>
        <NavLink
          to={`/forms/view/${formId}/submissions`}
          className={({ isActive: active }) =>
            cn(TAB_LINK_CLASS, active && TAB_LINK_ACTIVE)
          }
        >
          <List className="h-4 w-4" />
          {t("forms:submissions_tab")}
        </NavLink>
      </nav>

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
