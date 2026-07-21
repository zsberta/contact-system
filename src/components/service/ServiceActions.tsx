// ----------------------------------------------------------------------------
// ServiceActions — row-level dropdown for the Service DataTable. Simplified
// to Edit + Delete only. Publish/unpublish is handled by ServicePublishButton
// as a separate dedicated button with its own confirmation dialog.
//
// The actions mutate the underlying record via the helper API functions
// in src/lib/service.ts. On success the QueryClient cache is invalidated so
// the DataTable re-fetches and the action's effect is visible.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/utils/toast";
import { deleteServiceItem } from "@/lib/service";
import { ServiceItemDTO } from "@/types/service";

interface ServiceActionsProps {
  item: ServiceItemDTO;
  basePath?: string;
}

const ServiceActions: React.FC<ServiceActionsProps> = ({ item, basePath = "/services" }) => {
  const { t } = useTranslation(["service", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteServiceItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service"] });
      showSuccess(t("service:deleted_toast", { title: item.titleHu }));
      setDeleteOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("service:delete_failed_toast"));
    },
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" aria-label={t("common:actions")}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("service:item_actions")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate(`${basePath}/edit/${item.id}`)}>
            <Pencil className="mr-2 h-4 w-4" />
            {t("common:edit")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setDeleteOpen(true)}
            className="text-destructive focus:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("service:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("service:delete_confirm_body", { title: item.titleHu })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t("common:deleting") : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ServiceActions;
