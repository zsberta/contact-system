// ----------------------------------------------------------------------------
// FaqViewPage — preview-mode view of a single FAQ (GYIK) item.
//
// Shows the item's question, answer (rendered as HTML), status badge,
// locale, sortOrder, project name, and dates. Dedicated Publish/
// Unpublish and Delete buttons in the header mirror the BlogViewPage
// and FormViewPage patterns.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { Loader2, ArrowLeft, Pencil, Trash2 } from "lucide-react";
import { getFaqItemById, deleteFaqItem } from "@/lib/faq";
import { FaqItemDTO } from "@/types/faq";
import FaqPublishButton from "@/components/faq/FaqPublishButton";
import { showError, showSuccess } from "@/utils/toast";

const statusBadgeVariant = (status: FaqItemDTO["status"]) => {
  switch (status) {
    case "published":
      return "default" as const;
    case "draft":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
};

const FaqViewPage: React.FC = () => {
  const { t } = useTranslation(["faq", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const { data: item, isLoading } = useQuery({
    queryKey: ["faq", "detail", itemId],
    queryFn: () => getFaqItemById(itemId),
    enabled: Number.isFinite(itemId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteFaqItem(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      showSuccess(t("faq:deleted_toast", { question: item?.question ?? "" }));
      setDeleteOpen(false);
      navigate("/faq");
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:delete_failed_toast"));
    },
  });

  if (!Number.isFinite(itemId)) {
    return (
      <div className="container mx-auto p-4">
        <p className="text-destructive">{t("faq:invalid_id")}</p>
      </div>
    );
  }

  if (isLoading || !item) {
    return (
      <div className="container mx-auto p-4 max-w-5xl">
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 max-w-5xl space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <Badge variant={statusBadgeVariant(item.status)}>
                  {t(`faq:status_${item.status}`)}
                </Badge>
                <Badge variant="outline" className="font-mono text-xs">
                  {item.locale}
                </Badge>
              </div>
              <CardTitle className="text-2xl break-words">
                {item.question}
              </CardTitle>
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate("/faq")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("common:back")}
            </Button>
            <Button
              onClick={() => navigate(`/faq/edit/${item.id}`)}
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Button>
            <FaqPublishButton item={item} />
            <Button
              variant="destructive"
              onClick={() => setDeleteOpen(true)}
              disabled={deleteMutation.isPending}
              className="w-full sm:w-auto"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common:delete")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <div>
              <span className="font-medium">{t("faq:project")}: </span>
              {item.projectName}
            </div>
            <div>
              <span className="font-medium">{t("faq:order")}: </span>
              {item.sortOrder}
            </div>
            <div>
              <span className="font-medium">{t("faq:created")}: </span>
              {new Date(item.createdAt).toLocaleString("hu-HU")}
            </div>
            <div>
              <span className="font-medium">{t("faq:updated")}: </span>
              {new Date(item.updatedAt).toLocaleString("hu-HU")}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Answer — rendered as HTML */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("faq:answer")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            className="prose prose-sm max-w-none dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: item.answer }}
          />
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("faq:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("faq:delete_confirm_body", { question: item.question })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
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
    </div>
  );
};

export default FaqViewPage;
