// Blog DTOs (admin). Mirrors the BE surface in routes/blog.js.
//
// Lifecycle: draft -> published -> (optionally) archived -> deleted.
// `published_at` is set on the first transition to 'published' and
// preserved across edits so the publication date is stable.

export type BlogPostStatus = "draft" | "published" | "archived";

// Admin: returned by GET /api/blog, GET /api/blog/:id, POST /api/blog,
// PUT /api/blog/:id, POST /api/blog/:id/publish, POST /api/blog/:id/unpublish.
export interface BlogPostDTO {
  id: number;
  projectId: number;
  projectName: string;
  // kebab-case, 1..50 chars. Per-project, per-locale unique.
  slug: string;
  // BCP-47-ish: "hu" | "en" | "en-US" | ... 2..5 chars.
  locale: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  // Sanitized HTML (DOMPurify, see lib/sanitize.js). Stored as the
  // canonical read surface; the editor writes JSON separately to bodyJson.
  bodyHtml: string;
  // Optional Tiptap JSON document. May be null on posts authored in
  // earlier versions of the editor.
  bodyJson: Record<string, unknown> | null;
  status: BlogPostStatus;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string[];
  ogImageUrl: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
  // UUID linking this post to its translations. Posts with the same
  // translationGroupId are considered translations of each other
  // (one per locale). The CRM admin UI uses this to wire up
  // "Read in English" / "Olvassa magyarul" links.
  translationGroupId: string;
}

// POST /api/blog body. projectId is required; slug is optional (the BE
// auto-generates from title if absent). bodyJson is optional (legacy
// posts may not have it).
export interface BlogPostCreateDTO {
  projectId: number;
  locale?: string;
  title: string;
  slug?: string;
  excerpt?: string | null;
  coverImageUrl?: string | null;
  bodyHtml: string;
  bodyJson?: Record<string, unknown> | null;
  status?: BlogPostStatus;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  ogImageUrl?: string | null;
  canonicalUrl?: string | null;
  // Optional. If omitted, the BE generates a fresh UUID via
  // gen_random_uuid(). If provided, this post will be linked to
  // other posts sharing the same id (other-locale translations).
  translationGroupId?: string;
}

// PUT /api/blog/:id body. projectId and locale are immutable post-create
// (the BE rejects any payload containing them). status flips via PUT do
// NOT update published_at — use /publish for that.
export interface BlogPostUpdateDTO {
  title?: string;
  slug?: string;
  excerpt?: string | null;
  coverImageUrl?: string | null;
  bodyHtml?: string;
  bodyJson?: Record<string, unknown> | null;
  status?: BlogPostStatus;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoKeywords?: string[];
  ogImageUrl?: string | null;
  canonicalUrl?: string | null;
  // Update the translation group link. If you set this to a UUID
  // that matches another post's group, this post will be linked
  // to that group. Setting it to a fresh UUID unlinks it.
  translationGroupId?: string;
}

// Slug-availability probe response.
export interface SlugCheckResponse {
  available: boolean;
  slug: string;
}

// Public read DTO (from routes/blog-public.js). Same shape as the
// landing's prerender builder expects.
export interface PublicBlogPostDTO {
  slug: string;
  locale: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  bodyHtml: string;
  seoTitle: string | null;
  seoDescription: string | null;
  seoKeywords: string[];
  ogImageUrl: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  updatedAt: string;
  // UUID of the translation group this post belongs to. Same value
  // across all locales of the same post.
  translationGroupId: string;
  // Map of other-locale translations: `{ en: { slug, title }, de: null, ... }`.
  // The current post's own locale is excluded. Empty `{}` if the
  // operator hasn't linked any translation yet.
  translations: Record<string, { slug: string; title: string } | undefined>;
}

export interface PublicBlogPostsResponse {
  posts: PublicBlogPostDTO[];
}

export interface PublicBlogSlugsResponse {
  slugs: Array<{
    slug: string;
    locale: string;
    updatedAt: string;
  }>;
}