// ----------------------------------------------------------------------------
// AiAssistantActions — row-level dropdown menu for the AI Assistant list
// page (view / edit / disable-enable / delete). Mirrors AnalyticsActions
// structurally.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreVertical, Eye, Edit, Trash2, Power, PowerOff } from "lucide-react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
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
import type { AiAssistantConfigDTO } from "@/types/ai-assistant";
import {
  deleteAiAssistantConfig,
  updateAiAssistantConfig,
} from "@/lib/ai-assistant";
import { showError, showSuccess } from "@/utils/toast";

interface AiAssistantActionsProps {
  config: AiAssistantConfigDTO;
}

const AiAssistantActions = ({ config }: AiAssistantActionsProps) => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const queryClient = useQueryClient();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteAiAssistantConfig(config.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", {
          item: t("ai-assistant:ai_assistant_config"),
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["ai-assistant"] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = config.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateAiAssistantConfig(config.id, {
        status: isActive ? "disabled" : "active",
      }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("ai-assistant:action_disable")
          : t("ai-assistant:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["ai-assistant"] });
      queryClient.invalidateQueries({ queryKey: ["ai-assistant", config.id] });
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

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={deleteMutation.isPending || statusMutation.isPending}
          >
            <span className="sr-only">{t("common:actions")}</span>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to={`/ai-assistant/view/${config.id}`}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/ai-assistant/edit/${config.id}`}>
              <Edit className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setIsStatusDialogOpen(true)}
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
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setIsDeleteDialogOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
    </>
  );
};

export default AiAssistantActions;
