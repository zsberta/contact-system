// ----------------------------------------------------------------------------
// ProjectAiAssistant — a card on the project view page that surfaces the
// AI assistant config (lazy-created on first access) and offers a quick path
// to the snippet + knowledge base. Mirrors ProjectAnalytics structurally.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Bot, PlusCircle } from "lucide-react";
import {
  getAllAiAssistantConfigsPaged,
  getOrCreateAiAssistantConfigByProject,
} from "@/lib/ai-assistant";
import { showError, showSuccess } from "@/utils/toast";
import type { AiAssistantStatus } from "@/types/ai-assistant";

interface ProjectAiAssistantProps {
  projectId: number;
}

const statusBadgeVariant = (status: AiAssistantStatus) =>
  status === "disabled" ? ("destructive" as const) : ("default" as const);

export function ProjectAiAssistant({ projectId }: ProjectAiAssistantProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const enableMutation = useMutation({
    mutationFn: () => getOrCreateAiAssistantConfigByProject(projectId),
    onSuccess: (data) => {
      showSuccess(
        t("common:create_success", {
          item: t("ai-assistant:ai_assistant_config"),
        }),
      );
      queryClient.setQueryData(["ai-assistant", data.id], data);
      queryClient.invalidateQueries({
        queryKey: ["ai-assistant", "project", projectId],
      });
      navigate(`/ai-assistant/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ["ai-assistant", "project", projectId],
    queryFn: async () => {
      const page = await getAllAiAssistantConfigsPaged({
        projectId,
        page: 0,
        size: 1,
      });
      return page.content[0] ?? null;
    },
    enabled: !!projectId,
    retry: false,
  });

  const hasConfig = !!data;
  if (error) {
    console.error("[project-ai-assistant] query error:", error);
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <Bot className="h-5 w-5" />
          {t("ai-assistant:config_section_ai_assistant_title")}
        </CardTitle>
        {hasConfig && (
          <Badge variant={statusBadgeVariant(data!.status)}>
            {t(`ai-assistant:status_${data!.status}`)}
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !hasConfig ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground py-2 text-center">
              {t("ai-assistant:config_section_ai_assistant_empty")}
            </p>
            <div className="flex justify-center">
              <Button
                onClick={() => enableMutation.mutate()}
                disabled={enableMutation.isPending}
              >
                <PlusCircle className="mr-2 h-4 w-4" />
                {enableMutation.isPending
                  ? t("common:creating")
                  : t("ai-assistant:config_section_create_ai_assistant")}
              </Button>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            <li
              className="flex items-center justify-between p-3 border rounded-md cursor-pointer hover:bg-muted/50"
              onClick={() => navigate(`/ai-assistant/view/${data!.id}`)}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <Bot className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium truncate">{data!.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {data!.model} · {data!.defaultLanguage}
                  </p>
                </div>
              </div>
            </li>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectAiAssistant;
