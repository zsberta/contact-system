import { LayoutDashboard, Users } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";

interface SidebarProps {
  onClose?: () => void;
}

const Sidebar = ({ onClose }: SidebarProps = {}) => {
  const { t } = useTranslation("navigation");
  return (
    <nav className="flex flex-col gap-1 p-2">
      <NavLink
        to="/dashboard"
        onClick={() => onClose?.()}
        className={({ isActive }) =>
          `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            isActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50"
          }`
        }
      >
        <LayoutDashboard className="h-4 w-4" />
        <span>{t("dashboard")}</span>
      </NavLink>
      <NavLink
        to="/users"
        onClick={() => onClose?.()}
        className={({ isActive }) =>
          `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
            isActive
              ? "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/50"
          }`
        }
      >
        <Users className="h-4 w-4" />
        <span>{t("users")}</span>
      </NavLink>
    </nav>
  );
};

export default Sidebar;