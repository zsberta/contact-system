// AiAssistantViewPage — details tab of the admin AI assistant view.
// Navigation is handled by sidebar links (see Sidebar.tsx).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModulePath } from "@/lib/workspace-navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Power,
  PowerOff,
  Copy,
  Bot,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import {
  deleteAiAssistantConfig,
  getAiAssistantConfigById,
  updateAiAssistantConfig,
} from "@/lib/ai-assistant";
import { AiChatPreview } from "@/components/ai-assistant/AiChatPreview";

const AiAssistantViewPage: React.FC = () => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resourceId: configId, moduleId } = useModuleResolution();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const { data: config, isLoading, error } = useQuery<
    AiAssistantConfigDTO,
    Error
  >({
    queryKey: ["ai-assistant", configId],
    queryFn: () => getAiAssistantConfigById(configId!),
    enabled: !!configId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAiAssistantConfig(config!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", {
          item: t("ai-assistant:ai_assistant_config"),
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["ai-assistant"] });
      if (config?.projectId && moduleId) {
        navigate(buildWorkspaceModulePath(config.projectId, "ai-assistant", moduleId));
      }
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = config?.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateAiAssistantConfig(config!.id, {
        status: isActive ? "disabled" : "active",
      }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("ai-assistant:action_disable")
          : t("ai-assistant:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["ai-assistant"] });
      queryClient.invalidateQueries({ queryKey: ["ai-assistant", configId] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleConfirmDelete = async () => {
    await deleteMutation.mutateAsync();
    setIsDeleteDialogOpen(false);
  };

  const handleConfirmStatusChange = async () => {
    await statusMutation.mutateAsync();
    setIsStatusDialogOpen(false);
  };

  const copySecretToken = async () => {
    if (!config?.secretToken) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(config.secretToken);
        showSuccess(t("ai-assistant:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = config.secretToken;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("ai-assistant:secret_token_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
    }
  };

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!configId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return <div className="text-center p-8">{t("common:loading")}</div>;
  if (!config)
    return (
      <div className="text-center p-8">
        {t("ai-assistant:ai_assistant_not_found")}
      </div>
    );

  const statusVariant =
    config.status === "disabled" ? "destructive" : "default";

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: config.id },
    { label: t("ai-assistant:name"), value: config.name },
    {
      label: t("ai-assistant:project"),
      value: config.projectName || `(#${config.projectId})`,
    },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusVariant}>
          {t(`ai-assistant:status_${config.status}`)}
        </Badge>
      ),
    },
    {
      label: t("ai-assistant:secret_token"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{config.secretToken}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={copySecretToken}
          >
            <Copy className="h-3 w-3" />
          </Button>
        </span>
      ),
    },
    { label: t("ai-assistant:model"), value: config.model || "—" },
    {
      label: t("ai-assistant:allowed_origins_label"),
      value:
        config.allowedOrigins && config.allowedOrigins.length > 0
          ? config.allowedOrigins.join(", ")
          : t("ai-assistant:allowed_origins_empty_warning"),
    },
    {
      label: t("ai-assistant:rate_limit_burst"),
      value: `${config.rateLimitBurst} / min`,
    },
    {
      label: t("ai-assistant:rate_limit_sustained"),
      value: `${config.rateLimitSustained} / day`,
    },
    {
      label: t("ai-assistant:max_upload_size"),
      value: `${config.maxUploadSizeMb} MB`,
    },
    {
      label: t("ai-assistant:display_name"),
      value: config.displayName || "—",
    },
    {
      label: t("ai-assistant:primary_color"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 rounded-full border"
            style={{ backgroundColor: config.primaryColor }}
          />
          <span className="font-mono text-xs">{config.primaryColor}</span>
        </span>
      ),
    },
    {
      label: t("ai-assistant:secondary_color"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-block h-4 w-4 rounded-full border"
            style={{ backgroundColor: config.secondaryColor }}
          />
          <span className="font-mono text-xs">{config.secondaryColor}</span>
        </span>
      ),
    },
    {
      label: t("ai-assistant:legal_message"),
      value: config.legalMessage || "—",
    },
    {
      label: t("ai-assistant:greeting_message"),
      value: config.greetingMessage || "—",
    },
    {
      label: t("ai-assistant:popup_message"),
      value: config.popupMessage || "—",
    },
    {
      label: t("ai-assistant:position"),
      value:
        config.position === "bottom-left"
          ? t("ai-assistant:position_bottom_left")
          : t("ai-assistant:position_bottom_right"),
    },
    {
      label: t("ai-assistant:default_language"),
      value: config.defaultLanguage,
    },
    {
      label: t("ai-assistant:supported_languages"),
      value: config.supportedLanguages?.join(", ") || "—",
    },
    {
      label: t("common:created_at"),
      value: new Date(config.createdAt).toLocaleString(),
    },
    {
      label: t("common:updated_at"),
      value: new Date(config.updatedAt).toLocaleString(),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (config?.projectId && moduleId) {
              navigate(buildWorkspaceModulePath(config.projectId, "ai-assistant", moduleId));
            }
          }}
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (config?.projectId && moduleId) {
              navigate(buildWorkspaceModulePath(config.projectId, "ai-assistant", moduleId, "edit"));
            }
          }}
        >
          <Pencil className="mr-2 h-4 w-4" />
          {t("common:edit")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setIsStatusDialogOpen(true)}
        >
          {isActive ? (
            <>
              <PowerOff className="mr-2 h-4 w-4" />
              {t("ai-assistant:action_disable")}
            </>
          ) : (
            <>
              <Power className="mr-2 h-4 w-4" />
              {t("ai-assistant:action_enable")}
            </>
          )}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setIsDeleteDialogOpen(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          {t("common:delete")}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            {t("ai-assistant:ai_assistant_details")}
          </CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {details.map((d) => (
              <div key={d.label}>
                <dt className="text-sm font-medium text-muted-foreground">
                  {d.label}
                </dt>
                <dd className="mt-1 text-sm">{d.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("ai-assistant:branding_section")}
          </CardTitle>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6">
          <AiChatPreview config={config} />
        </CardContent>
      </Card>

      {/* Disable / Enable confirmation */}
      <AlertDialog
        open={isStatusDialogOpen}
        onOpenChange={setIsStatusDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isActive
                ? t("ai-assistant:disable_confirm_title")
                : t("ai-assistant:enable_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isActive
                ? t("ai-assistant:disable_confirm_description")
                : t("ai-assistant:enable_confirm_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmStatusChange}
              disabled={statusMutation.isPending}
            >
              {t("common:confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai-assistant:confirm_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("ai-assistant:confirm_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AiAssistantViewPage;
