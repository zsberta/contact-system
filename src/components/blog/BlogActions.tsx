// ----------------------------------------------------------------------------
// BlogActions — row-level dropdown for the blog posts DataTable. Simplified
// to Edit + Delete only. Publish/unpublish is handled by BlogPublishButton
// as a separate dedicated button with its own confirmation dialog.
//
// The actions mutate the underlying record via the helper API functions
// in src/lib/blog.ts. On success the QueryClient cache is invalidated so
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
import { deleteBlogPost } from "@/lib/blog";
import { BlogPostDTO } from "@/types/blog";

interface BlogActionsProps {
  post: BlogPostDTO;
}

const BlogActions: React.FC<BlogActionsProps> = ({ post }) => {
  const { t } = useTranslation(["blog", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteBlogPost(post.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      showSuccess(t("blog:deleted_toast", { title: post.title }));
      setDeleteOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:delete_failed_toast"));
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
          <DropdownMenuLabel>{t("blog:post_actions")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate(`/blog/edit/${post.id}`)}>
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
            <AlertDialogTitle>{t("blog:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("blog:delete_confirm_body", { title: post.title })}
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

export default BlogActions;
