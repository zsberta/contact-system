// AiAssistantViewNav — shared NavLink navigation bar for the admin AI assistant
// view sub-pages (Details / Knowledge Base / Snippet / Chat Sessions).
// Mirrors the pattern in FormViewPage and ReservationViewPage.

import { NavLink } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, FileText, BookOpen, Code, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const TAB_LINK_CLASS =
  "inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground";
const TAB_LINK_ACTIVE =
  "bg-primary text-primary-foreground shadow hover:bg-primary/90 hover:text-primary-foreground";

interface AiAssistantViewNavProps {
  configId: number;
}

export function AiAssistantViewNav({ configId }: AiAssistantViewNavProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const base = `/ai-assistant/view/${configId}`;

  return (
    <nav className="flex gap-1 border-b pb-px">
      <NavLink
        to={base}
        end
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <Bot className="h-4 w-4" />
        {t("ai-assistant:details_tab")}
      </NavLink>
      <NavLink
        to={`${base}/knowledge`}
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <BookOpen className="h-4 w-4" />
        {t("ai-assistant:knowledge_tab")}
      </NavLink>
      <NavLink
        to={`${base}/snippet`}
        className={({ isActive }) =>
          cn(TAB_LINK_CLASS, isActive && TAB_LINK_ACTIVE)
        }
      >
        <Code className="h-4 w-4" />
        {t("ai-assistant:snippet_tab")}
      </NavLink>
      <NavLink
        to={`${base}/sessions`}
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
