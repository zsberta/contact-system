// ----------------------------------------------------------------------------
// PortalBlogViewPage — read-only detail view of a single blog post for
// endusers. Same content as BlogViewPage but without the admin action
// buttons (publish, edit, delete). The enduser can read the post and see
// its metadata.
// ----------------------------------------------------------------------------

import React from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, ExternalLink, ImageIcon } from "lucide-react";
import { getBlogPostById } from "@/lib/blog";
import { BlogPostDTO } from "@/types/blog";

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

export default function PortalBlogViewPage() {
  const { t } = useTranslation(["blog", "common"]);
  const { id } = useParams<{ id: string }>();
  const postId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const { data: post, isLoading } = useQuery({
    queryKey: ["blog", "detail", postId],
    queryFn: () => getBlogPostById(postId),
    enabled: Number.isFinite(postId),
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

  const publicUrl =
    post.status === "published"
      ? `https://<project-domain>/blog/${post.slug}`
      : null;

  return (
    <div className="container mx-auto p-4 max-w-5xl space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-start gap-4">
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
              {publicUrl}
            </code>
          </CardContent>
        </Card>
      )}

      {/* Cover image preview */}
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
          <SeoRow
            label={t("blog:seo_title")}
            value={post.seoTitle}
            fallback={post.title}
          />
          <SeoRow
            label={t("blog:seo_description")}
            value={post.seoDescription}
            fallback={post.excerpt}
          />
          {post.seoKeywords.length > 0 && (
            <SeoRow
              label={t("blog:seo_keywords")}
              value={post.seoKeywords.join(", ")}
            />
          )}
          <SeoRow
            label={t("blog:og_image")}
            value={post.ogImageUrl}
            fallback={post.coverImageUrl}
          />
          <SeoRow label={t("blog:canonical_url")} value={post.canonicalUrl} />
        </CardContent>
      </Card>
    </div>
  );
}

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
