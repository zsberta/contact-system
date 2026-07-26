// ----------------------------------------------------------------------------
// AiKnowledgeBasePanel — knowledge base document management panel.
// Displays documents list, upload button, and delete functionality.
// ----------------------------------------------------------------------------

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import {
  Upload,
  Trash2,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  File,
} from "lucide-react";
import {
  getKnowledgeBaseDocuments,
  uploadKnowledgeBaseDocument,
  deleteKnowledgeBaseDocument,
} from "@/lib/ai-assistant";
import { showError, showSuccess } from "@/utils/toast";
import type { AiKnowledgeBaseDocument } from "@/types/ai-assistant";

interface AiKnowledgeBasePanelProps {
  configId: number;
}

const formatFileSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const statusBadgeVariant = (
  status: AiKnowledgeBaseDocument["status"],
): "default" | "secondary" | "destructive" => {
  switch (status) {
    case "ready":
      return "default";
    case "processing":
      return "secondary";
    case "error":
      return "destructive";
  }
};

const statusIcon = (status: AiKnowledgeBaseDocument["status"]) => {
  switch (status) {
    case "ready":
      return <CheckCircle2 className="h-3 w-3" />;
    case "processing":
      return <Loader2 className="h-3 w-3 animate-spin" />;
    case "error":
      return <AlertCircle className="h-3 w-3" />;
  }
};

export function AiKnowledgeBasePanel({
  configId,
}: AiKnowledgeBasePanelProps) {
  const { t, i18n } = useTranslation(["ai-assistant", "common"]);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [docToDelete, setDocToDelete] =
    useState<AiKnowledgeBaseDocument | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: documents, isLoading } = useQuery({
    queryKey: ["ai-assistant", configId, "knowledge"],
    queryFn: () => getKnowledgeBaseDocuments(configId),
    enabled: !!configId,
    refetchInterval: (query) => {
      // Poll every 2 seconds while any document is still processing
      const docs = query.state.data;
      if (Array.isArray(docs) && docs.some((d) => d.status === "processing")) {
        return 2000;
      }
      return false;
    },
  });

  const uploadMutation = useMutation({
    mutationFn: (file: File) =>
      uploadKnowledgeBaseDocument(configId, file),
    onSuccess: () => {
      showSuccess(
        t("common:upload_success", {
          item: t("ai-assistant:knowledge_base_title"),
        }),
      );
      queryClient.invalidateQueries({
        queryKey: ["ai-assistant", configId, "knowledge"],
      });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
    onSettled: () => {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (docId: number) =>
      deleteKnowledgeBaseDocument(configId, docId),
    onSuccess: () => {
      showSuccess(t("ai-assistant:document_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["ai-assistant", configId, "knowledge"],
      });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const allowedExtensions = [".pdf", ".txt", ".md", ".docx", ".csv"];
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      showError(t("ai-assistant:invalid_file_type"));
      return;
    }

    setIsUploading(true);
    uploadMutation.mutate(file);
  };

  const handleConfirmDelete = async () => {
    if (!docToDelete) return;
    await deleteMutation.mutateAsync(docToDelete.id);
    setIsDeleteDialogOpen(false);
    setDocToDelete(null);
  };

  const handleDeleteClick = (doc: AiKnowledgeBaseDocument) => {
    setDocToDelete(doc);
    setIsDeleteDialogOpen(true);
  };

  const getFileIcon = (fileType: string) => {
    switch (fileType.toLowerCase()) {
      case "pdf":
        return <FileText className="h-4 w-4 text-red-500" />;
      case "docx":
        return <FileText className="h-4 w-4 text-blue-500" />;
      case "csv":
        return <File className="h-4 w-4 text-green-500" />;
      default:
        return <File className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">
            {t("ai-assistant:knowledge_base_title")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("ai-assistant:knowledge_base_description")}
          </p>
        </div>
        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.md,.docx,.csv"
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common:uploading")}
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                {t("ai-assistant:upload_documents")}
              </>
            )}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">
          {t("common:loading")}
        </p>
      ) : documents && documents.length > 0 ? (
        <div className="space-y-2">
          {documents.map((doc) => (
            <Card key={doc.id}>
              <CardContent className="flex items-center justify-between py-3">
                <div className="flex items-center gap-3 min-w-0">
                  {getFileIcon(doc.fileType)}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {doc.originalFilename}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{formatFileSize(doc.fileSizeBytes)}</span>
                      <span>·</span>
                      <span>
                        {doc.chunkCount} {t("ai-assistant:upload_chunks")}
                      </span>
                      <span>·</span>
                      <span>
                        {new Date(doc.createdAt).toLocaleString(i18n.language)}
                      </span>
                    </div>
                    {doc.errorMessage && (
                      <p className="text-xs text-destructive mt-1">
                        {doc.errorMessage}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge
                    variant={statusBadgeVariant(doc.status)}
                    className="gap-1"
                  >
                    {statusIcon(doc.status)}
                    {t(`ai-assistant:status_${doc.status}`)}
                  </Badge>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    onClick={() => handleDeleteClick(doc)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <FileText className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p className="text-sm">{t("ai-assistant:documents_empty")}</p>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("common:confirm_delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("ai-assistant:delete_document_confirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
