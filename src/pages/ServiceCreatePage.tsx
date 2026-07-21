// ----------------------------------------------------------------------------
// ServiceCreatePage — create form for a new Service item.
// Each item has bilingual fields (HU + EN).
// In portal mode (/?projectId=N deep-link), project is auto-set from context
// and shown as read-only. In admin mode, a project selector modal is shown.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { ServiceItemCreateDTO, ServiceItemDTO } from "@/types/service";
import { createServiceItem } from "@/lib/service";
import { ServiceProjectSelectorModal } from "@/components/service/ServiceProjectSelectorModal";
import { useProjectContext } from "@/context/ProjectContext";
import type { ProjectDTO } from "@/types/project";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Loader2, Save } from "lucide-react";

const ServiceCreatePage: React.FC = () => {
  const { t } = useTranslation(["service", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const isPortal = window.location.pathname.startsWith("/portal");
  const { selectedId: contextProjectId } = useProjectContext();

  const projectIdParam = searchParams.get("projectId");
  const initialProjectId = isPortal
    ? contextProjectId
    : projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : null;

  const [selectedProjectId, setSelectedProjectId] = React.useState<number | null>(initialProjectId);
  const [titleHu, setTitleHu] = React.useState("");
  const [titleEn, setTitleEn] = React.useState("");
  const [descriptionHu, setDescriptionHu] = React.useState("");
  const [descriptionEn, setDescriptionEn] = React.useState("");
  const [priceHu, setPriceHu] = React.useState("");
  const [priceEn, setPriceEn] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState<number>(0);
  const [status, setStatus] = React.useState<"draft" | "published">("draft");

  const createMutation = useMutation({
    mutationFn: (data: ServiceItemCreateDTO) => createServiceItem(data),
    onSuccess: (data: ServiceItemDTO) => {
      showSuccess(t("service:created_toast", { title: data.titleHu }));
      queryClient.invalidateQueries({ queryKey: ["service"] });
      navigate(isPortal ? `/portal/services/view/${data.id}` : `/services`);
    },
    onError: (err: Error) => {
      showError(err.message || t("service:create_failed_toast"));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      showError(t("service:validation_project_required"));
      return;
    }
    if (!titleHu.trim()) {
      showError(t("service:validation_title_required"));
      return;
    }
    createMutation.mutate({
      projectId: selectedProjectId,
      titleHu: titleHu.trim(),
      titleEn: titleEn.trim(),
      descriptionHu: descriptionHu.trim(),
      descriptionEn: descriptionEn.trim(),
      priceHu: priceHu.trim(),
      priceEn: priceEn.trim(),
      sortOrder,
      status,
    });
  };

  // Resolve project name for read-only display in portal mode
  const { projects } = useProjectContext();
  const selectedProjectName = projects?.find((p) => p.id === selectedProjectId)?.name ?? "";

  return (
    <div className="container mx-auto p-4 max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => {
          navigate(isPortal ? "/portal/services" : "/services");
        }}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("service:create_title")}
        </h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>{t("service:create_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Project selector — read-only in portal, modal in admin */}
            <div className="space-y-2">
              <Label>{t("service:project")}</Label>
              {isPortal ? (
                <Input value={selectedProjectName} disabled />
              ) : (
                <ServiceProjectSelectorModal
                  selectedId={selectedProjectId}
                  onSelect={(project: ProjectDTO) => setSelectedProjectId(project.id)}
                />
              )}
            </div>

            {/* Hungarian fields */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                🏭 {t("service:hungarian")}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="titleHu">{t("service:title_hu")}</Label>
                <Input
                  id="titleHu"
                  value={titleHu}
                  onChange={(e) => setTitleHu(e.target.value)}
                  placeholder={t("service:title_placeholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="descriptionHu">{t("service:description_hu")}</Label>
                <Textarea
                  id="descriptionHu"
                  value={descriptionHu}
                  onChange={(e) => setDescriptionHu(e.target.value)}
                  placeholder={t("service:description_placeholder")}
                  rows={5}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priceHu">{t("service:price_hu")}</Label>
                <Input
                  id="priceHu"
                  value={priceHu}
                  onChange={(e) => setPriceHu(e.target.value)}
                  placeholder={t("service:price_placeholder")}
                />
              </div>
            </div>

            {/* English fields */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                🇬🇧 {t("service:english")}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="titleEn">{t("service:title_en")}</Label>
                <Input
                  id="titleEn"
                  value={titleEn}
                  onChange={(e) => setTitleEn(e.target.value)}
                  placeholder={t("service:title_placeholder")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="descriptionEn">{t("service:description_en")}</Label>
                <Textarea
                  id="descriptionEn"
                  value={descriptionEn}
                  onChange={(e) => setDescriptionEn(e.target.value)}
                  placeholder={t("service:description_placeholder")}
                  rows={5}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="priceEn">{t("service:price_en")}</Label>
                <Input
                  id="priceEn"
                  value={priceEn}
                  onChange={(e) => setPriceEn(e.target.value)}
                  placeholder={t("service:price_placeholder")}
                />
              </div>
            </div>

            {/* Sort order & status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sortOrder">{t("service:order")}</Label>
                <Input
                  id="sortOrder"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(Number(e.target.value))}
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("service:status")}</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "draft" | "published")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">{t("service:status_draft")}</SelectItem>
                    <SelectItem value="published">{t("service:status_published")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => {
                navigate(isPortal ? "/portal/services" : "/services");
              }}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-2 h-4 w-4" />
                )}
                {t("common:save")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>
    </div>
  );
};

export default ServiceCreatePage;
