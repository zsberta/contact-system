// ----------------------------------------------------------------------------
// BlogViewPage — preview-mode view of a single blog post.
//
// Shows the post's title, excerpt, body (sanitized HTML rendered as-is
// — Tiptap produced it, lib/sanitize.js verified it on save), status
// badge, and SEO metadata. Dedicated Publish/Unpublish and Delete buttons
// in the header mirror the FormViewPage pattern. A separate "Public
// preview URL" section shows what the landing's prerender will produce
// once the post is published.
//
// Differences from FormViewPage: blog posts have no public submission
// surface, so the action set is smaller. We render the body_html
// directly because we trust the sanitizer; if the operator wants to
// see how it looks with custom landing chrome they can navigate to the
// public landing page after publishing.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { Loader2, ExternalLink, Pencil, Copy, Languages, Plus, ImageIcon, Trash2, ArrowLeft } from "lucide-react";
import { getBlogPostById, deleteBlogPost } from "@/lib/blog";
import { BlogPostDTO } from "@/types/blog";
import BlogPublishButton from "@/components/blog/BlogPublishButton";
import { showError, showSuccess } from "@/utils/toast";

const statusBadgeVariant = (status: BlogPostDTO["status"]) => {
  switch (status) {
    case "published":
      return "default" as const;
    case "draft":
      return "secondary" as const;
    case "archived":
      return "destructive" as const;
    default:
      return "secondary" as const;
  }
};

const BlogViewPage: React.FC = () => {
  const { t } = useTranslation(["blog", "common"]);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const postId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const isPortal = typeof window !== "undefined" && window.location.pathname.startsWith("/portal");

  const { data: post, isLoading } = useQuery({
    queryKey: ["blog", "detail", postId],
    queryFn: () => getBlogPostById(postId),
    enabled: Number.isFinite(postId),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteBlogPost(postId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      showSuccess(t("blog:deleted_toast", { title: post?.title ?? "" }));
      setDeleteOpen(false);
      navigate(isPortal ? "/portal/blog" : "/blog");
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:delete_failed_toast"));
    },
  });

  if (!Number.isFinite(postId)) {
    return (
      <div className="container mx-auto p-4">
        <p className="text-destructive">{t("blog:invalid_id")}</p>
      </div>
    );
  }

  if (isLoading || !post) {
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

  // Public preview URL — only meaningful if the post is published and the
  // project has a domain_address configured. We don't actually fetch
  // anything here; the URL is a hint for the operator.
  const publicUrl = post.status === "published"
    ? `https://${post.projectName ? "" : ""}.../blog/${post.slug}`
    : null;

  return (
    <div className="container mx-auto p-4 max-w-5xl space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2 flex-wrap">
                <Badge variant={statusBadgeVariant(post.status)}>
                  {t(`blog:status_${post.status}`)}
                </Badge>
                <Badge variant="outline" className="font-mono text-xs">
                  {post.locale}
                </Badge>
                <span className="text-xs text-muted-foreground font-mono">
                  /{post.slug}
                </span>
              </div>
              <CardTitle className="text-2xl break-words">
                {post.title}
              </CardTitle>
              {post.excerpt && (
                <CardDescription className="mt-2">
                  {post.excerpt}
                </CardDescription>
              )}
            </div>
          </div>
          {/* Action buttons — mirrors FormViewPage layout: Back,
              Edit, Publish/Unpublish, Delete. The dropdown is
              kept for secondary actions but the primary lifecycle
              buttons are always visible. */}
          <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => navigate(isPortal ? "/portal/blog" : "/blog")}
              className="w-full sm:w-auto"
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("common:back", "Back")}
            </Button>
            <Button
              onClick={() => navigate(isPortal ? `/portal/blog/edit/${post.id}` : `/blog/edit/${post.id}`)}
              className="w-full sm:w-auto"
            >
              <Pencil className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Button>
            <BlogPublishButton post={post} />
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
              <span className="font-medium">{t("blog:project")}: </span>
              {post.projectName}
            </div>
            <div>
              <span className="font-medium">{t("blog:created")}: </span>
              {new Date(post.createdAt).toLocaleString("hu-HU")}
            </div>
            <div>
              <span className="font-medium">{t("blog:updated")}: </span>
              {new Date(post.updatedAt).toLocaleString("hu-HU")}
            </div>
            {post.publishedAt && (
              <div>
                <span className="font-medium">{t("blog:published")}: </span>
                {new Date(post.publishedAt).toLocaleString("hu-HU")}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Public URL preview — only when published. */}
      {publicUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <ExternalLink className="h-4 w-4" />
              {t("blog:public_preview_title")}
            </CardTitle>
            <CardDescription>
              {t("blog:public_preview_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <code className="block rounded bg-muted px-3 py-2 text-sm break-all">
              https://&lt;project-domain&gt;/blog/{post.slug}
            </code>
          </CardContent>
        </Card>
      )}

      {/* Cover image preview — large card showing the actual
          image the operator uploaded. The same image is reused
          as the OG / social-share preview (see the SEO card for
          the og:image fallback chain). When the post has no
          cover, we show a muted placeholder so the gap between
          header and body doesn't feel empty. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            {t("blog:cover_image")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {post.coverImageUrl ? (
            <a
              href={post.coverImageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <img
                src={post.coverImageUrl}
                alt={post.title}
                className="rounded-md border border-input max-h-96 w-auto max-w-full object-contain bg-muted"
              />
            </a>
          ) : (
            <div className="flex h-48 w-full items-center justify-center rounded-md border border-dashed border-input text-sm italic text-muted-foreground">
              {t("blog:cover_image_empty")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Body — rendered sanitized HTML. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("blog:body")}</CardTitle>
        </CardHeader>
        <CardContent>
          <article
            className="prose prose-sm max-w-none"
            // The HTML comes from lib/sanitize.js on save, so it's safe
            // to render directly. Any future code path that bypasses the
            // sanitizer must re-sanitize before reaching this div.
            dangerouslySetInnerHTML={{ __html: post.bodyHtml }}
          />
        </CardContent>
      </Card>

      {/* SEO metadata */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("blog:section_seo")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <SeoRow label={t("blog:seo_title")} value={post.seoTitle} fallback={post.title} />
          <SeoRow label={t("blog:seo_description")} value={post.seoDescription} fallback={post.excerpt} />
          {post.seoKeywords.length > 0 && (
            <SeoRow
              label={t("blog:seo_keywords")}
              value={post.seoKeywords.join(", ")}
            />
          )}
          <SeoRow label={t("blog:og_image")} value={post.ogImageUrl} fallback={post.coverImageUrl} />
          <SeoRow label={t("blog:canonical_url")} value={post.canonicalUrl} />
        </CardContent>
      </Card>

      {/* Translations — operator-facing card showing the
          translationGroupId. The operator copies this UUID when
          creating a translation in another locale (passed via the
          ?translationGroupId= query param on /blog/create), and the
          landing's <BlogPost> component uses it to render a
          "Read in English" / "Olvassa magyarul" link. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Languages className="h-4 w-4" />
            {t("blog:translations_title")}
          </CardTitle>
          <CardDescription>
            {t("blog:translations_desc")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("blog:translations_group_id")}
            </div>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-2 text-xs font-mono break-all">
                {post.translationGroupId}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (navigator?.clipboard) {
                    navigator.clipboard.writeText(post.translationGroupId);
                    showSuccess(t("blog:translations_id_copied"));
                  }
                }}
                title={t("blog:translations_copy_id")}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div>
            <Button
              asChild
              variant="outline"
              size="sm"
              className="w-full sm:w-auto"
            >
              <Link
                to={`/blog/create?projectId=${post.projectId}&translationGroupId=${post.translationGroupId}&locale=${post.locale === "hu" ? "en" : "hu"}`}
              >
                <Plus className="mr-2 h-4 w-4" />
                {t("blog:translations_add_new")}
              </Link>
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              {t("blog:translations_add_new_help")}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Delete confirmation */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("blog:delete_confirm_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("blog:delete_confirm_body", { title: post.title })}
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

const SeoRow: React.FC<{
  label: string;
  value: string | null | undefined;
  fallback?: string | null;
}> = ({ label, value, fallback }) => {
  const display = value || fallback;
  return (
    <div>
      <Separator className="my-3" />
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {label}
      </div>
      <div className="mt-1 text-sm break-words">
        {display || <span className="text-muted-foreground italic">—</span>}
      </div>
    </div>
  );
};

export default BlogViewPage;
