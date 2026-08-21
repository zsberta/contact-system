// ReservationServiceImageUploader — image upload for reservation service
// cover images. Mirrors BlogCoverUploader exactly: memory upload, 10 MB
// cap, webp-first accept, client preview, replace, delete.

import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { uploadServiceImage, deleteServiceImage } from "@/lib/reservations";
import { Button } from "@/components/ui/button";
import { ImageIcon, Upload, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { showError, showSuccess } from "@/utils/toast";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const ACCEPT_ATTR =
  "image/webp,image/avif,image/png,image/jpeg,.webp,.avif,.png,.jpg,.jpeg";

interface ReservationServiceImageUploaderProps {
  serviceId: number | null;
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}

export const ReservationServiceImageUploader: React.FC<ReservationServiceImageUploaderProps> = ({
  serviceId,
  value,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation(["reservations", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const uploadMutation = useMutation({
    mutationFn: (f: File) => {
      if (!serviceId) throw new Error("Service must be saved before uploading");
      return uploadServiceImage(serviceId, f);
    },
    onSuccess: (data) => {
      onChange(data.imageUrl);
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      showSuccess(t("reservations:image_uploaded"));
    },
    onError: (err: Error) => {
      showError(err.message);
      // Clear the stale preview so the user doesn't see a phantom image.
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!serviceId) throw new Error("No service id");
      return deleteServiceImage(serviceId);
    },
    onSuccess: () => {
      onChange(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      showSuccess(t("reservations:image_deleted"));
    },
    onError: (err: Error) => {
      showError(err.message);
    },
  });

  function handleFile(f: File) {
    if (f.size > 10 * 1024 * 1024) {
      showError(t("reservations:image_too_large"));
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const url = URL.createObjectURL(f);
    setPreviewUrl(url);
    setFile(f);
    uploadMutation.mutate(f);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }

  const displayUrl = value || previewUrl;
  const isUploading = uploadMutation.isPending;

  return (
    <div className="space-y-2">
      <div
        className={cn(
          "relative flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25",
          displayUrl ? "min-h-[200px]" : "min-h-[120px]",
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => !disabled && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="hidden"
          disabled={disabled || isUploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = "";
          }}
        />

        {isUploading ? (
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        ) : displayUrl ? (
          <div className="relative w-full">
            <img
              src={displayUrl}
              alt="Service cover"
              className="mx-auto max-h-[300px] rounded object-contain"
            />
            {!disabled && (
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="absolute right-2 top-2 h-7 w-7"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteMutation.mutate();
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <ImageIcon className="h-10 w-10" />
            <p className="text-sm">{t("reservations:drag_or_click_upload")}</p>
            <p className="text-xs">{t("reservations:image_format_hint")}</p>
          </div>
        )}
      </div>
      {value && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload className="mr-2 h-4 w-4" />
          {t("reservations:replace_image")}
        </Button>
      )}
    </div>
  );
};

export default ReservationServiceImageUploader;
