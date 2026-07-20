import {
  LayoutDashboard,
  Users,
  Briefcase,
  Building2,
  FileText,
  CalendarClock,
  BarChart3,
  ClipboardList,
  CalendarDays,
  Newspaper,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { useProjectContext } from "@/context/ProjectContext";
import { getAllFormsPaged } from "@/lib/forms";
import { getAllReservationsPaged } from "@/lib/reservations";
import { getAllAnalyticsConfigsPaged } from "@/lib/analytics";
import { getAllBlogPostsPaged } from "@/lib/blog";

interface SidebarProps {
  onClose?: () => void;
}

const Sidebar = ({ onClose }: SidebarProps = {}) => {
  const { t } = useTranslation("navigation");
  const { user } = useAuth();
  const role = user?.role ?? "admin";

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "hover:bg-sidebar-accent/50"
    }`;

  // Enduser: check which features the selected project has.
  if (role === "enduser") {
    return <EnduserSidebar linkClass={linkClass} onClose={onClose} />;
  }

  return (
    <nav className="flex flex-col gap-1 p-2">
      <NavLink
        to="/dashboard"
        onClick={() => onClose?.()}
        className={linkClass}
      >
        <LayoutDashboard className="h-4 w-4" />
        <span>{t("navigation:dashboard")}</span>
      </NavLink>
      <NavLink
        to="/forms"
        onClick={() => onClose?.()}
        className={linkClass}
      >
        <FileText className="h-4 w-4" />
        <span>{t("navigation:forms")}</span>
      </NavLink>
      <NavLink
        to="/reservations"
        onClick={() => onClose?.()}
        className={linkClass}
      >
        <CalendarClock className="h-4 w-4" />
        <span>{t("navigation:reservations")}</span>
      </NavLink>
      <NavLink to="/blog" onClick={() => onClose?.()} className={linkClass}>
        <Newspaper className="h-4 w-4" />
        <span>{t("navigation:blog")}</span>
      </NavLink>
      <NavLink
        to="/analytics"
        onClick={() => onClose?.()}
        className={linkClass}
      >
        <BarChart3 className="h-4 w-4" />
        <span>{t("navigation:analytics")}</span>
      </NavLink>
      <NavLink
        to="/submissions"
        onClick={() => onClose?.()}
        className={linkClass}
      >
        <ClipboardList className="h-4 w-4" />
        <span>{t("navigation:submissions")}</span>
      </NavLink>
      <NavLink to="/projects" onClick={() => onClose?.()} className={linkClass}>
        <Briefcase className="h-4 w-4" />
        <span>{t("navigation:projects")}</span>
      </NavLink>
      <NavLink to="/users" onClick={() => onClose?.()} className={linkClass}>
        <Users className="h-4 w-4" />
        <span>{t("navigation:users")}</span>
      </NavLink>
    </nav>
  );
};

function EnduserSidebar({
  linkClass,
  onClose,
}: {
  linkClass: (props: { isActive: boolean }) => string;
  onClose?: () => void;
}) {
  const { t } = useTranslation("navigation");
  const { selectedId: projectId } = useProjectContext();

  // Check if the selected project has forms.
  const { data: formsData } = useQuery({
    queryKey: ["portal", "sidebar-has-forms", projectId],
    queryFn: () =>
      getAllFormsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  // Check if the selected project has reservations.
  const { data: reservationsData } = useQuery({
    queryKey: ["portal", "sidebar-has-reservations", projectId],
    queryFn: () =>
      getAllReservationsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  // Check if the selected project has analytics enabled.
  const { data: analyticsData } = useQuery({
    queryKey: ["portal", "sidebar-has-analytics", projectId],
    queryFn: () =>
      getAllAnalyticsConfigsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
      }),
    enabled: !!projectId,
  });

  // Check if the selected project has any blog posts (across statuses).
  // The presence of any post is enough to expose the menu item — the
  // enduser can drill into a draft view to see what's there.
  const { data: blogData } = useQuery({
    queryKey: ["portal", "sidebar-has-blog", projectId],
    queryFn: () =>
      getAllBlogPostsPaged({
        projectId: projectId!,
        page: 0,
        size: 1,
      }),
    enabled: !!projectId,
  });

  const hasForms = (formsData?.totalElements ?? 0) > 0;
  const hasReservations = (reservationsData?.totalElements ?? 0) > 0;
  const hasAnalytics = (analyticsData?.totalElements ?? 0) > 0;
  const hasBlog = (blogData?.totalElements ?? 0) > 0;

  return (
    <nav className="flex flex-col gap-1 p-2">
      {hasAnalytics && (
        <NavLink
          to="/portal/analytics"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <BarChart3 className="h-4 w-4" />
          <span>{t("navigation:analytics")}</span>
        </NavLink>
      )}
      {hasForms && (
        <NavLink
          to="/portal/submissions"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <ClipboardList className="h-4 w-4" />
          <span>{t("navigation:submissions")}</span>
        </NavLink>
      )}
      {hasReservations && (
        <NavLink
          to="/portal/reservations"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <CalendarClock className="h-4 w-4" />
          <span>{t("navigation:reservations")}</span>
        </NavLink>
      )}
      {hasBlog && (
        <NavLink
          to="/portal/blog"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <Newspaper className="h-4 w-4" />
          <span>{t("navigation:blog")}</span>
        </NavLink>
      )}
      {hasReservations && (
        <NavLink
          to="/portal/calendar"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <CalendarDays className="h-4 w-4" />
          <span>{t("navigation:calendar")}</span>
        </NavLink>
      )}
    </nav>
  );
}

export default Sidebar;
