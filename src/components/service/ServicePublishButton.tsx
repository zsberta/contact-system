// ----------------------------------------------------------------------------
// ServicePublishButton — standalone Publish / Unpublish button with a
// confirmation dialog. Used as a dedicated button on the ServiceViewPage
// header and as a per-row button on the ServicePage list. Mirrors the
// FaqPublishButton pattern.
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
import { publishServiceItem, unpublishServiceItem } from "@/lib/service";
import { ServiceItemDTO } from "@/types/service";
import { cn } from "@/lib/utils";

interface ServicePublishButtonProps {
  item: ServiceItemDTO;
  /** Render as a compact icon-only button (for list rows) or full button. */
  variant?: "default" | "compact";
  className?: string;
}

const ServicePublishButton: React.FC<ServicePublishButtonProps> = ({
  item,
  variant = "default",
  className,
}) => {
  const { t } = useTranslation(["service", "common"]);
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const isPublished = item.status === "published";

  const publishMutation = useMutation({
    mutationFn: () => publishServiceItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service"] });
      queryClient.invalidateQueries({ queryKey: ["service", "detail", item.id] });
      showSuccess(t("service:published_toast", { title: item.titleHu }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("service:publish_failed_toast"));
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: () => unpublishServiceItem(item.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service"] });
      queryClient.invalidateQueries({ queryKey: ["service", "detail", item.id] });
      showSuccess(t("service:unpublished_toast", { title: item.titleHu }));
      setConfirmOpen(false);
    },
    onError: (err: Error) => {
      showError(err.message || t("service:unpublish_failed_toast"));
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
          title={isPublished ? t("service:unpublish") : t("service:publish")}
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
                  ? t("service:unpublish_confirm_title")
                  : t("service:publish_confirm_title")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isPublished
                  ? t("service:unpublish_confirm_body", { title: item.titleHu })
                  : t("service:publish_confirm_body", { title: item.titleHu })}
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
                    ? t("service:unpublish")
                    : t("service:publish")}
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
      >
        {isPending ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : isPublished ? (
          <Undo2 className="mr-2 h-4 w-4" />
        ) : (
          <Send className="mr-2 h-4 w-4" />
        )}
        {isPublished ? t("service:unpublish") : t("service:publish")}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPublished
                ? t("service:unpublish_confirm_title")
                : t("service:publish_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPublished
                ? t("service:unpublish_confirm_body", { title: item.titleHu })
                : t("service:publish_confirm_body", { title: item.titleHu })}
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
                  ? t("service:unpublish")
                  : t("service:publish")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default ServicePublishButton;
