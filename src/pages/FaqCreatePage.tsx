// ----------------------------------------------------------------------------
// FaqCreatePage — create form for a new FAQ (GYIK) item.
// Each item has bilingual fields (HU + EN). Supports ?projectId=N deep-link.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { FaqItemCreateDTO, FaqItemDTO } from "@/types/faq";
import { createFaqItem } from "@/lib/faq";
import { FaqProjectSelectorModal } from "@/components/faq/FaqProjectSelectorModal";
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

const FaqCreatePage: React.FC = () => {
  const { t } = useTranslation(["faq", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdParam = searchParams.get("projectId");
  const initialProjectId =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : null;

  const [selectedProjectId, setSelectedProjectId] = React.useState<number | null>(initialProjectId);
  const [questionHu, setQuestionHu] = React.useState("");
  const [answerHu, setAnswerHu] = React.useState("");
  const [questionEn, setQuestionEn] = React.useState("");
  const [answerEn, setAnswerEn] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState<number>(0);
  const [status, setStatus] = React.useState<"draft" | "published">("draft");

  const createMutation = useMutation({
    mutationFn: (data: FaqItemCreateDTO) => createFaqItem(data),
    onSuccess: (data: FaqItemDTO) => {
      showSuccess(t("faq:created_toast", { title: data.questionHu }));
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      navigate("/faq");
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:create_failed_toast"));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProjectId) {
      showError(t("faq:validation_project_required"));
      return;
    }
    if (!questionHu.trim()) {
      showError(t("faq:validation_question_required"));
      return;
    }
    if (!answerHu.trim()) {
      showError(t("faq:validation_answer_required"));
      return;
    }
    createMutation.mutate({
      projectId: selectedProjectId,
      questionHu: questionHu.trim(),
      answerHu: answerHu.trim(),
      questionEn: questionEn.trim(),
      answerEn: answerEn.trim(),
      sortOrder,
      status,
    });
  };

  return (
    <div className="container mx-auto p-4 max-w-5xl space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => navigate("/faq")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("faq:create_title")}
        </h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>{t("faq:create_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Project selector */}
            <div className="space-y-2">
              <Label>{t("faq:project")}</Label>
              <FaqProjectSelectorModal
                selectedId={selectedProjectId}
                onSelect={(project: ProjectDTO) => setSelectedProjectId(project.id)}
              />
            </div>

            {/* Hungarian fields */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                🇭🇺 {t("faq:hungarian")}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="questionHu">{t("faq:question_hu")}</Label>
                <Textarea
                  id="questionHu"
                  value={questionHu}
                  onChange={(e) => setQuestionHu(e.target.value)}
                  placeholder={t("faq:question_placeholder")}
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="answerHu">{t("faq:answer_hu")}</Label>
                <Textarea
                  id="answerHu"
                  value={answerHu}
                  onChange={(e) => setAnswerHu(e.target.value)}
                  placeholder={t("faq:answer_placeholder")}
                  rows={8}
                />
              </div>
            </div>

            {/* English fields */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                🇬🇧 {t("faq:english")}
              </h3>
              <div className="space-y-2">
                <Label htmlFor="questionEn">{t("faq:question_en")}</Label>
                <Textarea
                  id="questionEn"
                  value={questionEn}
                  onChange={(e) => setQuestionEn(e.target.value)}
                  placeholder={t("faq:question_placeholder")}
                  rows={3}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="answerEn">{t("faq:answer_en")}</Label>
                <Textarea
                  id="answerEn"
                  value={answerEn}
                  onChange={(e) => setAnswerEn(e.target.value)}
                  placeholder={t("faq:answer_placeholder")}
                  rows={8}
                />
              </div>
            </div>

            {/* Sort order & status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sortOrder">{t("faq:order")}</Label>
                <Input
                  id="sortOrder"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(Number(e.target.value))}
                  min={0}
                />
              </div>
              <div className="space-y-2">
                <Label>{t("faq:status")}</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as "draft" | "published")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="draft">{t("faq:status_draft")}</SelectItem>
                    <SelectItem value="published">{t("faq:status_published")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end gap-2 pt-4">
              <Button type="button" variant="outline" onClick={() => navigate("/faq")}>
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

export default FaqCreatePage;
