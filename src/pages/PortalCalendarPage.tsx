// PortalCalendarPage — calendar view of bookings for the selected project.

import { useTranslation } from "react-i18next";
import { CalendarDays } from "lucide-react";
import SubmissionsCalendarTab from "@/components/submissions/SubmissionsCalendarTab";
import { useProjectContext } from "@/context/ProjectContext";

export default function PortalCalendarPage() {
  const { t } = useTranslation(["submissions"]);
  const { selectedId } = useProjectContext();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t("submissions:calendar_tab")}</h1>
      </div>
      <SubmissionsCalendarTab projectId={selectedId} />
    </div>
  );
}
