// ----------------------------------------------------------------------------
// AnalyticsViewPage — read-only detail card + stats + snippet panel inside
// a 3-tab layout (Details / Stats / Snippet). Mirrors FormViewPage.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Power,
  PowerOff,
  Copy,
  Lock,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { AnalyticsConfigDTO } from "@/types/analytics";
import {
  deleteAnalyticsConfig,
  getAnalyticsConfigById,
  updateAnalyticsConfig,
} from "@/lib/analytics";
import { AnalyticsSnippetPanel } from "@/components/analytics/AnalyticsSnippetPanel";
import { AnalyticsViewShell } from "@/components/analytics/AnalyticsViewShell";

const AnalyticsViewPage: React.FC = () => {
  const { t } = useTranslation(["analytics", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const configId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const { data: config, isLoading, error } = useQuery<
    AnalyticsConfigDTO,
    Error
  >({
    queryKey: ["analytics", configId],
    queryFn: () => getAnalyticsConfigById(configId!),
    enabled: !!configId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAnalyticsConfig(config!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", {
          item: t("analytics:analytics_config"),
        }),
      );
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      navigate("/analytics");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = config?.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateAnalyticsConfig(config!.id, {
        status: isActive ? "disabled" : "active",
      }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("analytics:action_disable")
          : t("analytics:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["analytics"] });
      queryClient.invalidateQueries({ queryKey: ["analytics", configId] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const copySecretToken = async () => {
    if (!config?.secretToken) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(config.secretToken);
        showSuccess(t("analytics:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = config.secretToken;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("analytics:secret_token_copied"));
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
    return (
      <div className="text-center p-8">{t("common:loading")}</div>
    );
  if (!config)
    return (
      <div className="text-center p-8">
        {t("analytics:analytics_not_found")}
      </div>
    );

  const statusVariant =
    config.status === "disabled" ? "destructive" : "default";

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: config.id },
    { label: t("analytics:name"), value: config.name },
    {
      label: t("analytics:project"),
      value: config.projectName || `(#${config.projectId})`,
    },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusVariant}>
          {t(`analytics:status_${config.status}`)}
        </Badge>
      ),
    },
    {
      label: t("analytics:secret_token"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{config.secretToken}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={copySecretToken}
            aria-label={t("analytics:secret_token")}
            title={t("analytics:secret_token_immutable_tooltip")}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <span title={t("analytics:secret_token_immutable_tooltip")}>
            <Lock className="h-3 w-3 text-muted-foreground" />
          </span>
        </span>
      ),
    },
    {
      label: t("analytics:allowed_origins"),
      value:
        config.allowedOrigins && config.allowedOrigins.length > 0 ? (
          <ul className="list-disc pl-5 space-y-0.5 text-sm font-mono break-all">
            {config.allowedOrigins.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("analytics:allowed_origins_none")}
          </span>
        ),
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
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">
            {t("analytics:details_tab")}
          </TabsTrigger>
          <TabsTrigger value="stats">{t("analytics:stats_tab")}</TabsTrigger>
          <TabsTrigger value="snippet">
            {t("analytics:snippet_tab")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-col space-y-4 pb-2">
              <CardTitle className="text-2xl font-bold break-words">
                {t("analytics:analytics_details")}: {config.name}
              </CardTitle>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button
                  variant="outline"
                  onClick={() => navigate("/analytics")}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t("analytics:back_to_analytics")}
                </Button>
                <Button
                  onClick={() => navigate(`/analytics/edit/${config.id}`)}
                  className="w-full sm:w-auto"
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("common:edit")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsStatusDialogOpen(true)}
                  disabled={statusMutation.isPending}
                  className="w-full sm:w-auto"
                >
                  {isActive ? (
                    <>
                      <PowerOff className="mr-2 h-4 w-4" />
                      {t("analytics:action_disable")}
                    </>
                  ) : (
                    <>
                      <Power className="mr-2 h-4 w-4" />
                      {t("analytics:action_enable")}
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={deleteMutation.isPending}
                  className="w-full sm:w-auto"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("common:delete")}
                </Button>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {details.map((item) => (
                  <div key={item.label} className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {item.label}
                    </p>
                    <div className="text-base font-semibold break-words">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stats" className="space-y-6">
          <AnalyticsViewShell config={config} />
        </TabsContent>

        <TabsContent value="snippet" className="space-y-6">
          <AnalyticsSnippetPanel
            configId={config.id}
            allowedOrigins={config.allowedOrigins}
          />
        </TabsContent>
      </Tabs>

      {/* Disable / Enable confirmation */}
      <AlertDialog
        open={isStatusDialogOpen}
        onOpenChange={setIsStatusDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isActive
                ? t("analytics:disable_confirm_title")
                : t("analytics:enable_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isActive
                ? t("analytics:disable_confirm_description", {
                  name: config.name,
                })
                : t("analytics:enable_confirm_description", {
                  name: config.name,
                })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={statusMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => statusMutation.mutate()}
              disabled={statusMutation.isPending}
            >
              {statusMutation.isPending
                ? t("common:saving")
                : isActive
                  ? t("analytics:action_disable")
                  : t("analytics:action_enable")}
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
              {t("analytics:confirm_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("analytics:confirm_delete_description", {
                name: config.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("common:deleting")
                : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default AnalyticsViewPage;
