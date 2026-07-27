// PortalAiAssistantNav — shared NavLink navigation bar for the enduser portal
// AI assistant sub-pages (Details / Knowledge Base / Chat Sessions).

import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, BookOpen, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground";

export function PortalAiAssistantNav() {
  const { t } = useTranslation(["ai-assistant", "common"]);

  return (
    <nav className="flex gap-1 border-b pb-px">
      <NavLink
        to="/portal/ai-assistant"
        end
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <Bot className="h-4 w-4" />
        {t("ai-assistant:details_tab")}
      </NavLink>
      <NavLink
        to="/portal/ai-assistant/knowledge"
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <BookOpen className="h-4 w-4" />
        {t("ai-assistant:knowledge_tab")}
      </NavLink>
      <NavLink
        to="/portal/ai-assistant/sessions"
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <MessageSquare className="h-4 w-4" />
        {t("ai-assistant:chat_sessions")}
      </NavLink>
    </nav>
  );
}
