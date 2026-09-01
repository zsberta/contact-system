// ----------------------------------------------------------------------------
// AiChatSessionsPanel — paged DataTable of chat sessions with a Dialog to
// view the conversation. Used in the admin view page and portal page.
// Mirrors the AiAssistantPage DataTable pattern.
// ----------------------------------------------------------------------------

import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, User, Bot, Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import { getChatSessions, getChatMessages } from "@/lib/ai-assistant";
import type { AiChatSessionDTO, AiChatMessageDTO } from "@/types/ai-assistant";
import ChatSessionActions from "@/components/ai-assistant/ChatSessionActions";

interface AiChatSessionsPanelProps {
  configId: number;
}

export function AiChatSessionsPanel({
  configId,
}: AiChatSessionsPanelProps) {
  const { t, i18n } = useTranslation(["ai-assistant", "common"]);

  // Pagination / search / sort state
  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["ai-assistant", configId, "sessions", query],
    queryFn: () => getChatSessions(configId, query),
    enabled: !!configId,
  });

  // Dialog state
  const [selectedSession, setSelectedSession] = useState<AiChatSessionDTO | null>(null);
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleSearch = useCallback(
    (query: string) => handlers.onQueriesChange(query ? [query] : []),
    [handlers],
  );

  const handleRowDoubleClick = useCallback((row: AiChatSessionDTO) => {
    setSelectedSession(row);
    setIsDialogOpen(true);
  }, []);

  const columns = [
    {
      accessorKey: "sessionId",
      header: t("ai-assistant:session_visitor"),
      cell: (row: AiChatSessionDTO) => (
        <span className="font-medium truncate max-w-[200px] block">
          {row.visitorId || row.sessionId.slice(0, 12) + "..."}
        </span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "messageCount",
      header: t("ai-assistant:session_messages"),
      cell: (row: AiChatSessionDTO) => (
        <Badge variant="secondary" className="gap-1">
          <MessageSquare className="h-3 w-3" />
          {row.messageCount ?? 0}
        </Badge>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "language",
      header: t("ai-assistant:session_language"),
      cell: (row: AiChatSessionDTO) => (
        <Badge variant="outline">{row.language}</Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: AiChatSessionDTO) =>
        new Date(row.createdAt).toLocaleString(i18n.language),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: AiChatSessionDTO) => (
        <ChatSessionActions
          session={row}
          onView={(s) => {
            setSelectedSession(s);
            setIsDialogOpen(true);
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">
          {t("ai-assistant:chat_sessions")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("ai-assistant:chat_sessions_description")}
        </p>
      </div>

      <DataTable
        columns={columns}
        data={data?.content || []}
        pageInfo={data}
        onPageChange={handlers.onPageChange}
        onPageSizeChange={handlers.onPageSizeChange}
        onSearch={handleSearch}
        queries={query.queries}
        filterType={query.filterType}
        onQueriesChange={handlers.onQueriesChange}
        onFilterTypeChange={handlers.onFilterTypeChange}
        isLoading={isLoading}
        onSortChange={handlers.onSortChange}
        currentSortField={query.sortField}
        currentSortOrder={query.sortOrder}
        onRowDoubleClick={handleRowDoubleClick}
        emptyMessage={t("ai-assistant:sessions_empty")}
      />

      {/* Chat Dialog */}
      <ChatDialog
        session={selectedSession}
        configId={configId}
        isOpen={isDialogOpen}
        onOpenChange={setIsDialogOpen}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatDialog — shows the full conversation in a modal with chat-window UI
// ---------------------------------------------------------------------------
function ChatDialog({
  session,
  configId,
  isOpen,
  onOpenChange,
}: {
  session: AiChatSessionDTO | null;
  configId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation(["ai-assistant", "common"]);

  const { data: messages, isLoading } = useQuery({
    queryKey: ["ai-assistant", configId, "sessions", session?.id, "messages"],
    queryFn: () => getChatMessages(configId, session!.id),
    enabled: isOpen && !!session,
  });

  if (!session) return null;

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-6 pb-4 border-b">
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5" />
            {t("ai-assistant:chat_sessions")}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-3 text-xs">
            <span>{session.visitorId || session.sessionId}</span>
            <span>·</span>
            <span>{session.language}</span>
            <span>·</span>
            <span>{new Date(session.createdAt).toLocaleString(i18n.language)}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto min-h-0">
          {isLoading ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {t("common:loading")}
            </div>
          ) : messages && messages.length > 0 ? (
            <div className="p-4 space-y-3 bg-muted/20">
              {messages.map((msg) => (
                <ChatMessage key={msg.id} message={msg} />
              ))}
            </div>
          ) : (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {t("ai-assistant:session_empty_messages")}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// ChatMessage — individual message bubble (user right, assistant left)
// ---------------------------------------------------------------------------
function ChatMessage({ message }: { message: AiChatMessageDTO }) {
  const { t, i18n } = useTranslation(["ai-assistant", "common"]);

  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`flex gap-2 max-w-[80%] ${isUser ? "flex-row-reverse" : "flex-row"}`}
      >
        {/* Avatar */}
        <div
          className={`shrink-0 h-7 w-7 rounded-full flex items-center justify-center ${
            isUser
              ? "bg-primary text-primary-foreground"
              : isAssistant
                ? "bg-secondary text-secondary-foreground"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {isUser ? (
            <User className="h-3.5 w-3.5" />
          ) : isAssistant ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            <Info className="h-3.5 w-3.5" />
          )}
        </div>

        {/* Message bubble */}
        <div className="space-y-1">
          <div
            className={`rounded-xl px-3 py-2 text-sm ${
              isUser
                ? "bg-primary text-primary-foreground rounded-br-sm"
                : isAssistant
                  ? "bg-card border rounded-bl-sm shadow-sm"
                  : "bg-muted border border-dashed rounded-bl-sm"
            }`}
          >
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
          </div>

          {/* Meta row */}
          <div
            className={`flex items-center gap-2 text-[11px] text-muted-foreground px-1 ${
              isUser ? "justify-end" : "justify-start"
            }`}
          >
            <span>
              {isUser
                ? t("ai-assistant:message_role_user", "User")
                : isAssistant
                  ? t("ai-assistant:message_role_assistant", "Assistant")
                  : t("ai-assistant:message_role_system", "System")}
            </span>
            <span>·</span>
            <span>{new Date(message.createdAt).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            {message.tokensUsed > 0 && (
              <>
                <span>·</span>
                <span>{message.tokensUsed} tokens</span>
              </>
            )}
          </div>

          {/* RAG sources */}
          {message.ragSources && message.ragSources.length > 0 && (
            <div className="px-1">
              <p className="text-[11px] font-medium text-muted-foreground mb-1">
                {t("ai-assistant:rag_sources")}:
              </p>
              <div className="flex flex-wrap gap-1">
                {message.ragSources.map((src, i) => (
                  <Badge key={i} variant="outline" className="text-[11px]">
                    {src.filename || `Doc #${src.documentId}`}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
