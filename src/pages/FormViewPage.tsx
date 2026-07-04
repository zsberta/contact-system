// ----------------------------------------------------------------------------
// FormViewPage — read-only detail card + snippet panel + submissions list
// inside a 2-tab layout (Details / Submissions). No IntegrationGuide
// (forms have no iframe + loader dance — submission is a direct POST).
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
import type { FormDTO } from "@/types/form";
import { deleteForm, getFormById, updateForm } from "@/lib/forms";
import { FormSnippetPanel } from "@/components/forms/FormSnippetPanel";
import { FormSubmissionsList } from "@/components/forms/FormSubmissionsList";

const FormViewPage: React.FC = () => {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const formId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const { data: form, isLoading, error } = useQuery<FormDTO, Error>({
    queryKey: ["forms", formId],
    queryFn: () => getFormById(formId!),
    enabled: !!formId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteForm(form!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", { item: t("forms:form") }),
      );
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      navigate("/forms");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = form?.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateForm(form!.id, { status: isActive ? "disabled" : "active" }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("forms:action_disable")
          : t("forms:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["forms", formId] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const copySecretToken = async () => {
    if (!form?.secretToken) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(form.secretToken);
        showSuccess(t("forms:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = form.secretToken;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("forms:secret_token_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
    }
  };

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!formId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return (
      <div className="text-center p-8">{t("common:loading")}</div>
    );
  if (!form)
    return (
      <div className="text-center p-8">{t("forms:form_not_found")}</div>
    );

  const statusVariant =
    form.status === "disabled" ? "destructive" : "default";

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: form.id },
    { label: t("forms:name"), value: form.name },
    {
      label: t("forms:project"),
      value: form.projectName || `(#${form.projectId})`,
    },
    {
      label: t("forms:slug"),
      value: <span className="font-mono text-xs">{form.slug}</span>,
    },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusVariant}>
          {t(`forms:status_${form.status}`)}
        </Badge>
      ),
    },
    {
      label: t("forms:secret_token"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{form.secretToken}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={copySecretToken}
            aria-label={t("forms:secret_token")}
            title={t("forms:secret_token_immutable_tooltip")}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <span title={t("forms:secret_token_immutable_tooltip")}>
            <Lock className="h-3 w-3 text-muted-foreground" />
          </span>
        </span>
      ),
    },
    {
      label: t("forms:allowed_origins"),
      value:
        form.allowedOrigins && form.allowedOrigins.length > 0 ? (
          <ul className="list-disc pl-5 space-y-0.5 text-sm font-mono break-all">
            {form.allowedOrigins.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("forms:allowed_origins_none")}
          </span>
        ),
    },
    {
      label: t("common:created_at"),
      value: new Date(form.createdAt).toLocaleString(),
    },
    {
      label: t("common:updated_at"),
      value: new Date(form.updatedAt).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">{t("forms:details_tab")}</TabsTrigger>
          <TabsTrigger value="submissions">
            {t("forms:submissions_tab")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-col space-y-4 pb-2">
              <CardTitle className="text-2xl font-bold break-words">
                {t("forms:form_details")}: {form.name}
              </CardTitle>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button
                  variant="outline"
                  onClick={() => navigate("/forms")}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t("forms:back_to_forms")}
                </Button>
                <Button
                  onClick={() => navigate(`/forms/edit/${form.id}`)}
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
                      {t("forms:action_disable")}
                    </>
                  ) : (
                    <>
                      <Power className="mr-2 h-4 w-4" />
                      {t("forms:action_enable")}
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

          <FormSnippetPanel
            formId={form.id}
            allowedOrigins={form.allowedOrigins}
          />

          {/* Disable / Enable confirmation */}
          <AlertDialog
            open={isStatusDialogOpen}
            onOpenChange={setIsStatusDialogOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isActive
                    ? t("forms:disable_confirm_title")
                    : t("forms:enable_confirm_title")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {isActive
                    ? t("forms:disable_confirm_description", {
                      name: form.name,
                    })
                    : t("forms:enable_confirm_description", {
                      name: form.name,
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
                      ? t("forms:action_disable")
                      : t("forms:action_enable")}
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
                  {t("forms:confirm_delete_title")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("forms:confirm_delete_description", {
                    name: form.name,
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
        </TabsContent>

        <TabsContent value="submissions" className="space-y-6">
          <FormSubmissionsList formId={form.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default FormViewPage;
