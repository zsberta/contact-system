// ----------------------------------------------------------------------------
// BlogPublishButton — standalone Publish / Unpublish button with a
// confirmation dialog. Used as a dedicated button on the BlogViewPage
// header and as a per-row button on the BlogPage list. Mirrors the
// FormViewPage Enable/Disable pattern.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send, Undo2, Loader2 } from "lucide-react";
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
import { publishBlogPost, unpublishBlogPost } from "@/lib/blog";
import { BlogPostDTO } from "@/types/blog";
import { cn } from "@/lib/utils";

interface BlogPublishButtonProps {
  post: BlogPostDTO;
  /** Render as a compact icon-only button (for list rows) or full button. */
  variant?: "default" | "compact";
  className?: string;
}

const BlogPublishButton: React.FC<BlogPublishButtonProps> = ({
  post,
  variant = "default",
  className,
}) => {
  const { t } = useTranslation(["blog", "common"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const isPublished = post.status === "published";

  const publishMutation = useMutation({
    mutationFn: () => publishBlogPost(post.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      queryClient.invalidateQueries({ queryKey: ["blog", "detail", post.id] });
      showSuccess(t("blog:published_toast", { title: post.title }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:publish_failed_toast"));
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () => unpublishBlogPost(post.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      queryClient.invalidateQueries({ queryKey: ["blog", "detail", post.id] });
      showSuccess(t("blog:unpublished_toast", { title: post.title }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:unpublish_failed_toast"));
    },
  });

  const isPending = publishMutation.isPending || unpublishMutation.isPending;

  if (variant === "compact") {
    return (
      <>
        <Button
          variant={isPublished ? "outline" : "default"}
          size="sm"
          className={cn("h-8 px-2", className)}
          onClick={() => setConfirmOpen(true)}
          disabled={isPending}
          title={isPublished ? t("blog:unpublish") : t("blog:publish")}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isPublished ? (
            <Undo2 className="h-3.5 w-3.5" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isPublished
                  ? t("blog:unpublish_confirm_title")
                  : t("blog:publish_confirm_title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isPublished
                  ? t("blog:unpublish_confirm_body", { title: post.title })
                  : t("blog:publish_confirm_body", { title: post.title })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>
                {t("common:cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  isPublished
                    ? unpublishMutation.mutate()
                    : publishMutation.mutate()
                }
                disabled={isPending}
              >
                {isPending
                  ? t("common:saving")
                  : isPublished
                    ? t("blog:unpublish")
                    : t("blog:publish")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    );
  }

  return (
    <>
      <Button
        variant={isPublished ? "outline" : "default"}
        onClick={() => setConfirmOpen(true)}
        disabled={isPending}
        className={cn("w-full sm:w-auto", className)}
      >
        {isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : isPublished ? (
          <Undo2 className="mr-2 h-4 w-4" />
        ) : (
          <Send className="mr-2 h-4 w-4" />
        )}
        {isPublished ? t("blog:unpublish") : t("blog:publish")}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPublished
                ? t("blog:unpublish_confirm_title")
                : t("blog:publish_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPublished
                ? t("blog:unpublish_confirm_body", { title: post.title })
                : t("blog:publish_confirm_body", { title: post.title })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                isPublished
                  ? unpublishMutation.mutate()
                  : publishMutation.mutate()
              }
              disabled={isPending}
            >
              {isPending
                ? t("common:saving")
                : isPublished
                  ? t("blog:unpublish")
                  : t("blog:publish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default BlogPublishButton;
