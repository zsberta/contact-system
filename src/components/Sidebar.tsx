import { LayoutDashboard, Users, Briefcase } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  onClose?: () => void;
}

const Sidebar = ({ onClose }: SidebarProps = {}) => {
  const { t } = useTranslation("navigation");
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "hover:bg-sidebar-accent/50"
    }`;

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
