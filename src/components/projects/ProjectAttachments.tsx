import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Download,
  FileText,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import {
  deleteProjectAttachment,
  downloadProjectAttachment,
  getProjectAttachments,
  uploadProjectAttachment,
} from "@/lib/api";
import type { ProjectAttachmentDTO } from "@/types/project";
import { showError, showSuccess } from "@/utils/toast";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ProjectAttachmentsProps {
  projectId: number;
}

export function ProjectAttachments({ projectId }: ProjectAttachmentsProps) {
  const { t } = useTranslation(["projects", "common"]);
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const { data: attachments = [], isLoading } = useQuery<
    ProjectAttachmentDTO[]
  >({
    queryKey: ["projects", projectId, "attachments"],
    queryFn: () => getProjectAttachments(projectId),
  });

  const uploadMutation = useMutation({
    mutationFn: (f: File) => uploadProjectAttachment(projectId, f),
    onSuccess: () => {
      showSuccess(t("projects:attachment_uploaded"));
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "attachments"],
      });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
      setFile(null);
    },
    onError: (err: Error) =>
      showError(t("common:operation_failed", { error: err.message })),
  });

  const deleteMutation = useMutation({
    mutationFn: (attachmentId: number) =>
      deleteProjectAttachment(projectId, attachmentId),
    onSuccess: () => {
      showSuccess(t("projects:attachment_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["projects", projectId, "attachments"],
      });
      queryClient.invalidateQueries({ queryKey: ["projects", projectId] });
    },
    onError: (err: Error) =>
      showError(t("common:operation_failed", { error: err.message })),
  });

  const handleDownload = async (att: ProjectAttachmentDTO) => {
    try {
      const blob = await downloadProjectAttachment(projectId, att.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = att.originalFilename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      showError(t("common:operation_failed", { error: (err as Error).message }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("projects:attachments_section")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Attachment list */}
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : attachments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("projects:attachments_empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {attachments.map((att) => (
              <li
                key={att.id}
                className="flex items-center justify-between p-3 border rounded-md"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <span className="truncate font-medium">
                    {att.originalFilename}
                  </span>
                  <span className="text-xs text-muted-foreground flex-shrink-0">
                    ({formatBytes(att.sizeBytes)})
                  </span>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDownload(att)}
                    disabled={deleteMutation.isPending}
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">
                      {t("projects:attachment_download")}
                    </span>
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                        <span className="sr-only">
                          {t("projects:attachment_delete")}
                        </span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("projects:attachment_delete_confirm_title")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("projects:attachment_delete_confirm_description", {
                            name: att.originalFilename,
                          })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleteMutation.isPending}>
                          {t("common:cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => deleteMutation.mutate(att.id)}
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
              </li>
            ))}
          </ul>
        )}

        {/* Drop zone */}
        <div
          className={cn(
            "border-2 border-dashed rounded-md p-6 text-center cursor-pointer transition-colors",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25",
            uploadMutation.isPending && "opacity-50 pointer-events-none",
          )}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files[0];
            if (f) setFile(f);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setFile(f);
            }}
          />
          {file ? (
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <FileText className="h-5 w-5" />
              <span className="font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                ({formatBytes(file.size)})
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setFile(null);
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {t("projects:attachment_upload_hint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("projects:attachment_max_size")}
              </p>
            </>
          )}
        </div>

        {file && (
          <Button
            onClick={() => uploadMutation.mutate(file)}
            disabled={uploadMutation.isPending}
          >
            {uploadMutation.isPending
              ? t("common:uploading")
              : t("projects:attachment_upload")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectAttachments;