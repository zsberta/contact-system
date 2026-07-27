// KnowledgeDocumentActions — row-level dropdown for knowledge base documents.
// Provides "View" and "Delete" actions.

import { useTranslation } from "react-i18next";
import { MoreVertical, Eye, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import type { AiKnowledgeBaseDocument } from "@/types/ai-assistant";

interface KnowledgeDocumentActionsProps {
  document: AiKnowledgeBaseDocument;
  onView: (doc: AiKnowledgeBaseDocument) => void;
  onDelete: (doc: AiKnowledgeBaseDocument) => void;
}

const KnowledgeDocumentActions = ({
  document: doc,
  onView,
  onDelete,
}: KnowledgeDocumentActionsProps) => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const canView = doc.status === "ready" && doc.chunkCount > 0;

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
        {canView && (
          <>
            <DropdownMenuItem onSelect={() => onView(doc)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => onDelete(doc)}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("common:delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export default KnowledgeDocumentActions;
