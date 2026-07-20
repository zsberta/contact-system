// ----------------------------------------------------------------------------
// BlogCoverUploader — drag-and-drop image upload for blog post cover
// images. Mirrors the ProjectAttachments drop zone pattern, but with
// image-only MIME allowlist (webp first, then png/jpeg/avif) and a
// preview thumbnail instead of a generic file icon.
//
// Two key UX rules:
//
//   1. The <input type="file" accept="..."> attribute lists webp first.
//      Browsers don't strictly honor order for the dropdown, but the
//      server-side allowlist DOES, so we pick the best format the
//      browser offers.
//
//   2. We never upload to /api/blog/:id/cover before the post exists.
//      The upload route requires a post id (FK constraint). So:
//        - Edit mode (post already saved at least once): we upload
//          immediately on file selection. The saved form already has
//          a post id; the URL gets stored into cover_image_url.
//        - Create mode: we save the post first (as draft) to obtain
//          an id, then upload. The component handles this with a
//          "createPostAndUpload" prop that the parent calls.
// ----------------------------------------------------------------------------

import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import {
  deleteBlogCoverImage,
  uploadBlogCoverImage,
} from "@/lib/blog";
import { Button } from "@/components/ui/button";
import { ImageIcon, Upload, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { showError, showSuccess } from "@/utils/toast";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Mirror the BE allowlist (routes/blog-attachments.js#ALLOWED_MIME).
// The order matters for the file-picker default in some browsers —
// webp is listed first so the "default format" the OS picker offers
// (if any) prefers it.
const ACCEPT_ATTR =
  "image/webp,image/avif,image/png,image/jpeg,.webp,.avif,.png,.jpg,.jpeg";

interface BlogCoverUploaderProps {
  postId: number | null;
  /**
   * Current cover URL — either uploaded and persisted, or a stale
   * string from initialData that the user might want to clear.
   */
  value: string | null;
  onChange: (url: string | null) => void;
  disabled?: boolean;
}

export const BlogCoverUploader: React.FC<BlogCoverUploaderProps> = ({
  postId,
  value,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation(["blog", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  //
  // We deliberately do NOT revoke the blob URL in a useEffect cleanup.
  // The cleanup would run on every previewUrl change AND on every
  // Strict-Mode mount/unmount cycle, and a race in Strict Mode
  // revokes the URL after the second mount has already captured it,
  // leaving the <img src=...> pointing at a dead blob: URL.
  //
  // Instead, we revoke the previous URL only when a NEW file is
  // selected (in handleFile), and let the browser GC the blob URL
  // when the file object itself goes out of scope (the React tree
  // holds the only reference). The blob URL's lifetime is bounded
  // by the time the user spends on this page, which is the same
  // window in which the preview is useful anyway.

  const uploadMutation = useMutation({
    mutationFn: (f: File) => {
      if (!postId) throw new Error("Post must be saved before uploading");
      return uploadBlogCoverImage(postId, f);
    },
    onSuccess: (data) => {
      onChange(data.url);
      setFile(null);
      // The blob URL is no longer used (the uploaded URL is now in
      // `data.url` and we render that instead). Explicit revoke —
      // we no longer rely on the useEffect cleanup, so this is the
      // only place the URL gets freed on the upload-success path.
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      showSuccess(t("blog:cover_uploaded"));
    },
    onError: (err: Error) => {
      showError(err.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!postId) throw new Error("Post must be saved before deleting");
      return deleteBlogCoverImage(postId);
    },
    onSuccess: () => {
      onChange(null);
      showSuccess(t("blog:cover_removed"));
    },
    onError: (err: Error) => {
      showError(err.message);
    },
  });

  const handleFile = (f: File | null) => {
    if (!f) {
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      return;
    }
    // Client-side allowlist check — the BE re-validates by sniffing
    // the actual mime, but failing fast in the FE saves a roundtrip.
    const okTypes = [
      "image/webp",
      "image/png",
      "image/jpeg",
      "image/avif",
    ];
    if (!okTypes.includes(f.type)) {
      showError(t("blog:cover_type_rejected", { type: f.type || "?" }));
      return;
    }
    // 10 MB cap to match the BE.
    if (f.size > 10 * 1024 * 1024) {
      showError(t("blog:cover_too_large"));
      return;
    }
    // Revoke the previous blob URL (if any) before allocating a
    // fresh one. This is the only place we explicitly revoke — the
    // component doesn't run a useEffect cleanup, so the only way
    // a stale URL gets freed is when a new file supersedes it.
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));

    // Auto-upload: in EDIT mode (postId is set), we have a target
    // row to write the URL into, so kick off the upload
    // immediately and let the success handler push the absolute
    // URL back into the form via onChange. The user sees a
    // spinner briefly, then the persisted preview replaces the
    // blob URL.
    //
    // In CREATE mode (postId is null), there's no row to write
    // into yet — the post must be saved first. We just hold the
    // blob preview in state and let the user save the post; after
    // save, the form re-mounts with the new id and the blob is
    // lost (which is fine, the user can re-pick). To avoid that
    // paper cut, the parent (BlogCreatePage) calls an explicit
    // upload right after a successful create — see
    // BlogCreatePage's onSuccess handler below.
    if (postId && !disabled) {
      uploadMutation.mutate(f);
    }
  };

  // Auto-upload on create-mode save: when the user picks a file in
  // the create form, the file has nowhere to live until the post
  // itself is saved (we have no postId to attach the upload to).
  // We hold the File object in `file` state and a blob: preview
  // URL in `previewUrl` — and watch for postId to flip from null
  // to a real value. As soon as the parent (BlogCreatePage)
  // re-mounts this component with the freshly-saved post's id,
  // we kick off the upload automatically. The blob preview stays
  // visible (via previewUrl) until the success handler swaps in
  // the persisted absolute URL from data.url.
  useEffect(() => {
    if (postId && file && !disabled && !uploadMutation.isPending) {
      uploadMutation.mutate(file);
    }
    // We intentionally only depend on postId so the effect fires
    // when postId flips; we don't want it to re-fire every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postId]);

  // The displayed preview: either the local blob (pre-upload) or
  // the existing URL (post-upload or initialData).
  //
  // Legacy data: pre-fix uploads stored relative URLs like
  // "/api/public/blog/attachments/<uuid>.webp" — those resolve
  // relative to whatever origin the SPA is served from, which is
  // wrong when the SPA is on crm.zsoltberta.hu but the image is
  // served by the same host (it works) — but when the SPA is on a
  // landing (a different origin) or the upload was made before
  // APP_PUBLIC_URL was wired, the relative URL breaks. The
  // post-fix uploads return absolute URLs (see routes/blog-attachments.js),
  // so this fallback only kicks in for legacy rows.
  const absoluteUrl = (url) => {
    if (!url || typeof url !== "string") return url;
    if (/^https?:\/\//i.test(url)) return url;          // already absolute
    if (url.startsWith("//")) return `https:${url}`;    // protocol-relative
    if (url.startsWith("/")) return `${window.location.origin}${url}`;
    return url;                                          // data: or other scheme, leave alone
  };
  const displayedUrl = absoluteUrl(previewUrl ?? value);

  return (
    <div className="space-y-3">
      {/* Preview */}
      {displayedUrl && (
        <div className="relative inline-block">
          <img
            src={displayedUrl}
            alt={t("blog:cover_alt")}
            className="rounded-md border border-input max-h-48 w-auto object-contain bg-muted"
          />
          {!disabled && (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="absolute top-1 right-1 h-7 w-7 p-0"
              onClick={() => {
                if (previewUrl) {
                  // We have a local blob we never uploaded — just
                  // clear it.
                  URL.revokeObjectURL(previewUrl);
                  setPreviewUrl(null);
                  setFile(null);
                  onChange(null);
                  return;
                }
                if (value && postId) {
                  deleteMutation.mutate();
                } else {
                  onChange(null);
                }
              }}
              disabled={deleteMutation.isPending}
              title={t("blog:cover_remove")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}

      {/* Drop zone / file picker */}
      {!disabled && (
        <div
          className={cn(
            "border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors",
            dragOver
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-primary/50",
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
            const f = e.dataTransfer.files?.[0];
            if (f) handleFile(f);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              handleFile(f);
              // Reset so picking the same file twice re-fires onChange.
              e.target.value = "";
            }}
          />
          {file ? (
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <ImageIcon className="h-5 w-5" />
              <span className="font-medium">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                ({formatBytes(file.size)})
              </span>
            </div>
          ) : (
            <>
              <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">
                {t("blog:cover_upload_hint")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("blog:cover_upload_formats")}
              </p>
            </>
          )}
        </div>
      )}

      {/* Upload button — no longer needed, the upload happens
          automatically as soon as a file is picked (in edit mode)
          or as soon as the post is saved (in create mode). The
          spinner in the preview box reflects the in-flight state. */}

      {/* Edit-mode hint when no post id yet (create flow) */}
      {file && !disabled && !postId && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {t("blog:cover_save_first_hint")}
        </p>
      )}
    </div>
  );
};

export default BlogCoverUploader;