// ----------------------------------------------------------------------------
// FaqPublishButton — standalone Publish / Unpublish button with a
// confirmation dialog. Used as a dedicated button on the FaqViewPage
// header and as a per-row button on the FaqPage list. Mirrors the
// BlogPublishButton pattern.
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
import { publishFaqItem, unpublishFaqItem } from "@/lib/faq";
import { FaqItemDTO } from "@/types/faq";
import { cn } from "@/lib/utils";

interface FaqPublishButtonProps {
  item: FaqItemDTO;
  /** Render as a compact icon-only button (for list rows) or full button. */
  variant?: "default" | "compact";
  className?: string;
}

const FaqPublishButton: React.FC<FaqPublishButtonProps> = ({
  item,
  variant = "default",
  className,
}) => {
  const { t } = useTranslation(["faq", "common"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const isPublished = item.status === "published";

  const publishMutation = useMutation({
    mutationFn: () => publishFaqItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      queryClient.invalidateQueries({ queryKey: ["faq", "detail", item.id] });
      showSuccess(t("faq:published_toast", { question: item.question }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:publish_failed_toast"));
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () => unpublishFaqItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      queryClient.invalidateQueries({ queryKey: ["faq", "detail", item.id] });
      showSuccess(t("faq:unpublished_toast", { question: item.question }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:unpublish_failed_toast"));
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
          title={isPublished ? t("faq:unpublish") : t("faq:publish")}
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
                  ? t("faq:unpublish_confirm_title")
                  : t("faq:publish_confirm_title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isPublished
                  ? t("faq:unpublish_confirm_body", { question: item.question })
                  : t("faq:publish_confirm_body", { question: item.question })}
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
                    ? t("faq:unpublish")
                    : t("faq:publish")}
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
        {isPublished ? t("faq:unpublish") : t("faq:publish")}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPublished
                ? t("faq:unpublish_confirm_title")
                : t("faq:publish_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPublished
                ? t("faq:unpublish_confirm_body", { question: item.question })
                : t("faq:publish_confirm_body", { question: item.question })}
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
                  ? t("faq:unpublish")
                  : t("faq:publish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default FaqPublishButton;
