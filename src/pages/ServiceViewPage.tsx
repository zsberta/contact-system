// ----------------------------------------------------------------------------
// ServiceViewPage — preview-mode view of a single Service item.
// Shows both HU and EN title/description/price side by side.
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
import { getServiceItemById, deleteServiceItem } from "@/lib/service";
import { ServiceItemDTO } from "@/types/service";
import ServicePublishButton from "@/components/service/ServicePublishButton";
import { showError, showSuccess } from "@/utils/toast";

const statusBadgeVariant = (status: ServiceItemDTO["status"]) => {
  switch (status) {
    case "published":
      return "default" as const;
    case "draft":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
};

const ServiceViewPage: React.FC = () => {
  const { t } = useTranslation(["service", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const itemId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const isPortal = typeof window !== "undefined" && window.location.pathname.startsWith("/portal");

  const { data: item, isLoading } = useQuery({
    queryKey: ["service", "detail", itemId],
    queryFn: () => getServiceItemById(itemId),
    enabled: Number.isFinite(itemId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteServiceItem(itemId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["service"] });
      showSuccess(t("service:deleted_toast", { title: item?.titleHu ?? "" }));
      setDeleteOpen(false);
      navigate(isPortal ? "/portal/services" : "/services");
    },
    onError: (err: Error) => {
      showError(err.message || t("service:delete_failed_toast"));
    },
  });

  if (!Number.isFinite(itemId)) {
    return (
      <div className="container mx-auto p-4">
        <p className="text-destructive">{t("service:invalid_id")}</p>
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
                  {t(`service:status_${item.status}`)}
                </Badge>
              </div>
              <CardTitle className="text-2xl break-words">
                {item.titleHu}
              </CardTitle>
            </div>
          </div>
          {/* Action buttons */}
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate(isPortal ? "/portal/services" : "/services")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("common:back")}
            </Button>
            <Button
              onClick={() => navigate(isPortal ? `/portal/services/edit/${item.id}` : `/services/edit/${item.id}`)}
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Button>
            <ServicePublishButton item={item} />
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
              <span className="font-medium">{t("service:project")}: </span>
              {item.projectName}
            </div>
            <div>
              <span className="font-medium">{t("service:order")}: </span>
              {item.sortOrder}
            </div>
            <div>
              <span className="font-medium">{t("service:created")}: </span>
              {new Date(item.createdAt).toLocaleString("hu-HU")}
            </div>
            <div>
              <span className="font-medium">{t("service:updated")}: </span>
              {new Date(item.updatedAt).toLocaleString("hu-HU")}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Hungarian section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">🏭 {t("service:hungarian")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:title_hu")}</span>
            <p className="mt-1">{item.titleHu}</p>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:description_hu")}</span>
            <div
              className="prose prose-sm max-w-none dark:prose-invert mt-1"
              dangerouslySetInnerHTML={{ __html: item.descriptionHu }}
            />
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:price_hu")}</span>
            <p className="mt-1">{item.priceHu || <em className="text-muted-foreground">—</em>}</p>
          </div>
        </CardContent>
      </Card>

      {/* English section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">🇬🇧 {t("service:english")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:title_en")}</span>
            <p className="mt-1">{item.titleEn || <em className="text-muted-foreground">—</em>}</p>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:description_en")}</span>
            {item.descriptionEn ? (
              <div
                className="prose prose-sm max-w-none dark:prose-invert mt-1"
                dangerouslySetInnerHTML={{ __html: item.descriptionEn }}
              />
            ) : (
              <p className="mt-1 text-muted-foreground"><em>—</em></p>
            )}
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground">{t("service:price_en")}</span>
            <p className="mt-1">{item.priceEn || <em className="text-muted-foreground">—</em>}</p>
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("service:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("service:delete_confirm_body", { title: item.titleHu })}
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

export default ServiceViewPage;
