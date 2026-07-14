// SubmissionsPage — unified view of form submissions and reservation bookings
// across all projects the user has access to. URL-based tabs for deep-linking.

import { useTranslation } from "react-i18next";
import { NavLink, useSearchParams } from "react-router-dom";
import { ClipboardList, CalendarDays, List } from "lucide-react";
import { cn } from "@/lib/utils";
import SubmissionsFormSubmissionsTab from "@/components/submissions/SubmissionsFormSubmissionsTab";
import SubmissionsBookingsTab from "@/components/submissions/SubmissionsBookingsTab";
import SubmissionsCalendarTab from "@/components/submissions/SubmissionsCalendarTab";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground";

export default function SubmissionsPage() {
  const { t } = useTranslation(["submissions", "common"]);
  const [searchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") || "forms";
  const projectIdParam = searchParams.get("projectId");
  const projectId =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  return (
    <div className="max-w-6xl mx-auto space-y-6 w-full">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ClipboardList className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold">{t("submissions:page_title")}</h1>
      </div>

      {/* Tab navigation */}
      <nav className="flex gap-1 border-b pb-px">
        <NavLink
          to="/submissions?tab=forms"
          className={({ isActive }) =>
            cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
          }
        >
          <List className="h-4 w-4" />
          {t("submissions:form_submissions_tab")}
        </NavLink>
        <NavLink
          to="/submissions?tab=bookings"
          className={({ isActive }) =>
            cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
          }
        >
          <ClipboardList className="h-4 w-4" />
          {t("submissions:bookings_tab")}
        </NavLink>
        <NavLink
          to="/submissions?tab=calendar"
          className={({ isActive }) =>
            cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
          }
        >
          <CalendarDays className="h-4 w-4" />
          {t("submissions:calendar_tab")}
        </NavLink>
      </nav>

      {/* Tab content */}
      {activeTab === "forms" && (
        <SubmissionsFormSubmissionsTab projectId={projectId} />
      )}
      {activeTab === "bookings" && (
        <SubmissionsBookingsTab projectId={projectId} />
      )}
      {activeTab === "calendar" && (
        <SubmissionsCalendarTab projectId={projectId} />
      )}
    </div>
  );
}
