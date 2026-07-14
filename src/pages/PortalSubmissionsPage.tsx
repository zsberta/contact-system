// PortalSubmissionsPage — form submissions for the selected project.

import { useTranslation } from "react-i18next";
import { ClipboardList } from "lucide-react";
import SubmissionsFormSubmissionsTab from "@/components/submissions/SubmissionsFormSubmissionsTab";
import { useProjectContext } from "@/context/ProjectContext";

export default function PortalSubmissionsPage() {
  const { t } = useTranslation(["submissions"]);
  const { selectedId } = useProjectContext();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t("submissions:form_submissions_tab")}</h1>
      </div>
      <SubmissionsFormSubmissionsTab projectId={selectedId} />
    </div>
  );
}
