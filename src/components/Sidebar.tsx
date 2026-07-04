import {
  LayoutDashboard,
  Users,
  Briefcase,
  Building2,
  FileText,
  CalendarClock,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/AuthContext";

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

  // Endusers see only the projects section — they have no access to
  // the admin dashboard, forms list, reservations list, or user
  // management. Their project view is the single page that aggregates
  // everything they're allowed to see.
  if (role === "enduser") {
    return (
      <nav className="flex flex-col gap-1 p-2">
        <NavLink
          to="/portal"
          onClick={() => onClose?.()}
          className={linkClass}
        >
          <Briefcase className="h-4 w-4" />
          <span>{t("navigation:my_projects")}</span>
        </NavLink>
      </nav>
    );
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
      <NavLink
        to="/projects"
        onClick={() => onClose?.()}
        className={linkClass}
      >
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

export default Sidebar;
