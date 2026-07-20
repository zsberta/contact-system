// ----------------------------------------------------------------------------
// FaqActions — row-level dropdown for the FAQ DataTable. Simplified
// to Edit + Delete only. Publish/unpublish is handled by FaqPublishButton
// as a separate dedicated button with its own confirmation dialog.
//
// The actions mutate the underlying record via the helper API functions
// in src/lib/faq.ts. On success the QueryClient cache is invalidated so
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
import { deleteFaqItem } from "@/lib/faq";
import { FaqItemDTO } from "@/types/faq";

interface FaqActionsProps {
  item: FaqItemDTO;
  basePath?: string;
}

const FaqActions: React.FC<FaqActionsProps> = ({ item, basePath = "/faq" }) => {
  const { t } = useTranslation(["faq", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteFaqItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      showSuccess(t("faq:deleted_toast", { question: item.question }));
      setDeleteOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:delete_failed_toast"));
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
          <DropdownMenuLabel>{t("faq:item_actions")}</DropdownMenuLabel>
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
            <AlertDialogTitle>{t("faq:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("faq:delete_confirm_body", { question: item.question })}
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

export default FaqActions;
