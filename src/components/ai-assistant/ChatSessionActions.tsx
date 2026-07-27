// ChatSessionActions — row-level dropdown for the chat sessions DataTable.
// Provides a "View" action to open the conversation dialog.

import { useTranslation } from "react-i18next";
import { MoreVertical, Eye } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { AiChatSessionDTO } from "@/types/ai-assistant";

interface ChatSessionActionsProps {
  session: AiChatSessionDTO;
  onView: (session: AiChatSessionDTO) => void;
}

const ChatSessionActions = ({ session, onView }: ChatSessionActionsProps) => {
  const { t } = useTranslation(["ai-assistant", "common"]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">{t("common:actions")}</span>
          <MoreVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onView(session)}>
          <Eye className="mr-2 h-4 w-4" />
          {t("common:view")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default ChatSessionActions;
