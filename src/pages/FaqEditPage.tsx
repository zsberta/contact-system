// ----------------------------------------------------------------------------
// FaqEditPage — edit form for an existing FAQ (GYIK) item.
// Each item has bilingual fields (HU + EN).
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import { FaqItemDTO, FaqItemUpdateDTO } from "@/types/faq";
import { getFaqItemById, updateFaqItem } from "@/lib/faq";
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

const FaqEditPage: React.FC = () => {
  const { t } = useTranslation(["faq", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const itemId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const { data: item, isLoading } = useQuery({
    queryKey: ["faq", "detail", itemId],
    queryFn: () => getFaqItemById(itemId),
    enabled: Number.isFinite(itemId),
  });

  const [questionHu, setQuestionHu] = React.useState("");
  const [answerHu, setAnswerHu] = React.useState("");
  const [questionEn, setQuestionEn] = React.useState("");
  const [answerEn, setAnswerEn] = React.useState("");
  const [sortOrder, setSortOrder] = React.useState<number>(0);
  const [status, setStatus] = React.useState<"draft" | "published">("draft");
  const [initialized, setInitialized] = React.useState(false);

  // Populate form when data arrives
  React.useEffect(() => {
    if (item && !initialized) {
      setQuestionHu(item.questionHu);
      setAnswerHu(item.answerHu);
      setQuestionEn(item.questionEn);
      setAnswerEn(item.answerEn);
      setSortOrder(item.sortOrder);
      setStatus(item.status);
      setInitialized(true);
    }
  }, [item, initialized]);

  const updateMutation = useMutation({
    mutationFn: (data: FaqItemUpdateDTO) => updateFaqItem(itemId, data),
    onSuccess: (data: FaqItemDTO) => {
      showSuccess(t("faq:saved_toast", { title: data.questionHu }));
      queryClient.invalidateQueries({ queryKey: ["faq"] });
      queryClient.invalidateQueries({ queryKey: ["faq", "detail", itemId] });
      const isPortal = window.location.pathname.startsWith("/portal");
      navigate(isPortal ? `/portal/faq/view/${data.id}` : `/faq/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(err.message || t("faq:save_failed_toast"));
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!questionHu.trim()) {
      showError(t("faq:validation_question_required"));
      return;
    }
    if (!answerHu.trim()) {
      showError(t("faq:validation_answer_required"));
      return;
    }
    updateMutation.mutate({
      questionHu: questionHu.trim(),
      answerHu: answerHu.trim(),
      questionEn: questionEn.trim(),
      answerEn: answerEn.trim(),
      sortOrder,
      status,
    });
  };

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
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => {
          const isPortal = window.location.pathname.startsWith("/portal");
          navigate(isPortal ? `/portal/faq/view/${itemId}` : `/faq/view/${itemId}`);
        }}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("common:back")}
        </Button>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("faq:edit_title")}
        </h1>
      </div>

      <form onSubmit={handleSubmit}>
        <Card>
          <CardHeader>
            <CardTitle>{t("faq:edit_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* Project — read-only in edit mode */}
            <div className="space-y-2">
              <Label>{t("faq:project")}</Label>
              <Input value={item.projectName || ""} disabled />
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
              <Button type="button" variant="outline" onClick={() => {
                const isPortal = window.location.pathname.startsWith("/portal");
                navigate(isPortal ? `/portal/faq/view/${itemId}` : `/faq/view/${itemId}`);
              }}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? (
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

export default FaqEditPage;
