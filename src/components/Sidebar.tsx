import React from "react";
import {
  LayoutDashboard,
  Users,
  Briefcase,
  FileText,
  BarChart3,
  ClipboardList,
  Newspaper,
  HelpCircle,
  Layers,
  Bot,
  UserCircle,
  BookOpen,
  Code,
  MessageSquare,
  Settings,
  CalendarDays,
  Lock,
  List,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/context/AuthContext";
import { useProjectContext } from "@/context/ProjectContext";
import { ProjectSelector } from "./ProjectSelector";
import { ModuleSelector } from "./ModuleSelector";
import { buildWorkspaceModulePath } from "@/lib/workspace-navigation";
import type { ProjectModuleDTO, ProjectModuleKind } from "@/types/project-module";

interface SidebarProps {
  onClose?: () => void;
}

// Module-kind → sidebar link definitions.
// Each entry: { kind, page, icon, translationKey }.
const MODULE_LINKS: Record<ProjectModuleKind, Array<{ page: string; icon: React.ReactNode; translationKey: string; adminOnly?: boolean }>> = {
  reservation: [
    { page: "details", icon: <Settings className="h-4 w-4" />, translationKey: "navigation:details", adminOnly: true },
    { page: "services", icon: <Layers className="h-4 w-4" />, translationKey: "navigation:services" },
    { page: "bookings", icon: <ClipboardList className="h-4 w-4" />, translationKey: "navigation:bookings" },
    { page: "calendar", icon: <CalendarDays className="h-4 w-4" />, translationKey: "navigation:calendar" },
    { page: "blocked", icon: <Lock className="h-4 w-4" />, translationKey: "navigation:blocked" },
    { page: "customers", icon: <UserCircle className="h-4 w-4" />, translationKey: "navigation:reservation_customers" },
  ],
  form: [
    { page: "details", icon: <FileText className="h-4 w-4" />, translationKey: "navigation:details" },
    { page: "submissions", icon: <List className="h-4 w-4" />, translationKey: "navigation:submissions" },
  ],
  analytics: [
    { page: "details", icon: <BarChart3 className="h-4 w-4" />, translationKey: "navigation:details" },
    { page: "stats", icon: <BarChart3 className="h-4 w-4" />, translationKey: "navigation:stats" },
    { page: "snippet", icon: <Code className="h-4 w-4" />, translationKey: "navigation:snippet" },
  ],
  "ai-assistant": [
    { page: "details", icon: <Bot className="h-4 w-4" />, translationKey: "navigation:details" },
    { page: "knowledge", icon: <BookOpen className="h-4 w-4" />, translationKey: "navigation:knowledge" },
    { page: "snippet", icon: <Code className="h-4 w-4" />, translationKey: "navigation:snippet" },
    { page: "sessions", icon: <MessageSquare className="h-4 w-4" />, translationKey: "navigation:chat_sessions" },
  ],
  blog: [
    { page: "posts", icon: <Newspaper className="h-4 w-4" />, translationKey: "navigation:blog" },
  ],
  faq: [
    { page: "items", icon: <HelpCircle className="h-4 w-4" />, translationKey: "navigation:faq" },
  ],
  service: [
    { page: "items", icon: <Layers className="h-4 w-4" />, translationKey: "navigation:services" },
  ],
};

const Sidebar = ({ onClose }: SidebarProps = {}) => {
  const { t } = useTranslation("navigation");
  const { user } = useAuth();
  const {
    projects,
    selectedProject,
    modules,
    selectedModule,
    isProjectsLoading,
    isModulesLoading,
    setSelectedId,
    setSelectedModule,
  } = useProjectContext();
  const role = user?.role ?? "admin";

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2 px-3 py-2 rounded-md text-sm transition-colors ${
      isActive
        ? "bg-sidebar-accent text-sidebar-accent-foreground"
        : "hover:bg-sidebar-accent/50"
    }`;

  const moduleLinks = selectedModule
    ? (MODULE_LINKS[selectedModule.kind] ?? []).filter((l) => !l.adminOnly || role === "admin")
    : [];

  return (
    <nav className="flex flex-col gap-1 p-2">
      {/* Project selector — top of sidebar */}
      <div className="mb-1">
        {projects.length > 1 ? (
          <ProjectSelector
            projects={projects}
            selectedId={selectedProject?.id ?? null}
            onSelect={setSelectedId}
            isLoading={isProjectsLoading}
          />
        ) : selectedProject ? (
          <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium">
            <Briefcase className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{selectedProject.name}</span>
          </div>
        ) : null}
      </div>

      {/* Module selector — directly below project */}
      <div className="mb-1">
        <ModuleSelector
          modules={modules}
          selectedModule={selectedModule}
          onSelect={setSelectedModule}
          isLoading={isModulesLoading}
        />
      </div>

      {/* Module-specific links */}
      {selectedModule && moduleLinks.length > 0 && (
        <div className="flex flex-col gap-1">
          {moduleLinks.map((link) => {
            const path = buildWorkspaceModulePath(
              selectedModule.projectId,
              selectedModule.kind,
              selectedModule.id,
              link.page,
            );
            return (
              <NavLink
                key={link.page}
                to={path}
                end={link.page === "details"}
                onClick={() => onClose?.()}
                className={linkClass}
              >
                {link.icon}
                <span>{t(link.translationKey)}</span>
              </NavLink>
            );
          })}
        </div>
      )}

      {/* Admin-only utility links */}
      {role === "admin" && (
        <>
          <div className="my-2 border-t" />
          <NavLink to="/dashboard" onClick={() => onClose?.()} className={linkClass}>
            <LayoutDashboard className="h-4 w-4" />
            <span>{t("navigation:dashboard")}</span>
          </NavLink>
          <NavLink to="/projects" onClick={() => onClose?.()} className={linkClass}>
            <Briefcase className="h-4 w-4" />
            <span>{t("navigation:projects")}</span>
          </NavLink>
          <NavLink to="/users" onClick={() => onClose?.()} className={linkClass}>
            <Users className="h-4 w-4" />
            <span>{t("navigation:users")}</span>
          </NavLink>
        </>
      )}
    </nav>
  );
};

export default Sidebar;
