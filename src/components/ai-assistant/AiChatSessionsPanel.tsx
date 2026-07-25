// ----------------------------------------------------------------------------
// AiChatSessionsPanel — chat sessions viewer. Lists sessions with
// expandable message view. Used in the admin view page and portal page.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ChevronDown,
  ChevronRight,
  MessageSquare,
  User,
  Bot,
  Info,
} from "lucide-react";
import { getChatSessions, getChatMessages } from "@/lib/ai-assistant";
import type { AiChatSessionDTO, AiChatMessageDTO } from "@/types/ai-assistant";

interface AiChatSessionsPanelProps {
  configId: number;
}

export function AiChatSessionsPanel({
  configId,
}: AiChatSessionsPanelProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(
    null,
  );

  const { data: sessionsData, isLoading: sessionsLoading } = useQuery({
    queryKey: ["ai-assistant", configId, "sessions"],
    queryFn: () =>
      getChatSessions(configId, {
        page: 0,
        size: 50,
        sortField: "createdAt",
        sortOrder: "desc",
      }),
    enabled: !!configId,
  });

  const sessions = sessionsData?.content ?? [];

  const toggleSession = (sessionId: string) => {
    setExpandedSessionId((prev) =>
      prev === sessionId ? null : sessionId,
    );
  };

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

      {sessionsLoading ? (
        <p className="text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : sessions.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <MessageSquare className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p className="text-sm">{t("ai-assistant:sessions_empty")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <SessionCard
              key={session.id}
              session={session}
              configId={configId}
              isExpanded={expandedSessionId === session.sessionId}
              onToggle={() => toggleSession(session.sessionId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Separate component for each session card to isolate the messages query
function SessionCard({
  session,
  configId,
  isExpanded,
  onToggle,
}: {
  session: AiChatSessionDTO;
  configId: number;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const { data: messages, isLoading: messagesLoading } = useQuery({
    queryKey: ["ai-assistant", configId, "sessions", session.sessionId, "messages"],
    queryFn: () => getChatMessages(configId, session.sessionId),
    enabled: isExpanded,
  });

  return (
    <Card>
      <CardContent className="py-3">
        <button
          type="button"
          className="flex items-center justify-between w-full text-left"
          onClick={onToggle}
        >
          <div className="flex items-center gap-3">
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <div>
              <p className="text-sm font-medium">
                {session.visitorId || session.sessionId}
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>
                  {session.messageCount ?? 0} {t("ai-assistant:session_messages")}
                </span>
                <span>·</span>
                <span>{session.language}</span>
                <span>·</span>
                <span>
                  {new Date(session.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
          <Badge variant="outline" className="text-xs">
            {session.language}
          </Badge>
        </button>

        {isExpanded && (
          <div className="mt-3 space-y-2 border-t pt-3">
            {messagesLoading ? (
              <p className="text-sm text-muted-foreground">
                {t("common:loading")}
              </p>
            ) : messages && messages.length > 0 ? (
              messages.map((msg) => (
                <MessageBubble key={msg.id} message={msg} />
              ))
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("ai-assistant:session_empty_messages")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MessageBubble({ message }: { message: AiChatMessageDTO }) {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const roleConfig = {
    user: {
      icon: <User className="h-3 w-3" />,
      variant: "secondary" as const,
      label: "User",
    },
    assistant: {
      icon: <Bot className="h-3 w-3" />,
      variant: "default" as const,
      label: "Assistant",
    },
    system: {
      icon: <Info className="h-3 w-3" />,
      variant: "outline" as const,
      label: "System",
    },
  };

  const role = roleConfig[message.role];

  return (
    <div className="rounded-md bg-muted/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <Badge variant={role.variant} className="gap-1 text-xs">
          {role.icon}
          {role.label}
        </Badge>
        <span className="text-xs text-muted-foreground">
          {new Date(message.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{message.content}</p>
      {message.ragSources && message.ragSources.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-muted-foreground mb-1">
            {t("ai-assistant:rag_sources")}:
          </p>
          <div className="flex flex-wrap gap-1">
            {message.ragSources.map((src, i) => (
              <Badge key={i} variant="outline" className="text-xs">
                {src.filename}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
