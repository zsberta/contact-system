import { apiFetch, apiUpload, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  BlogPostCreateDTO,
  BlogPostDTO,
  BlogPostUpdateDTO,
  PublicBlogPostDTO,
  PublicBlogPostsResponse,
  PublicBlogSlugsResponse,
  SlugCheckResponse,
} from "@/types/blog";

export type PageBlogPostDTO = Page<BlogPostDTO>;

/**
 * Optional project / status / locale filter — when provided, only
 * matching posts are returned. Mirrors the BE query-string contract.
 */
export interface GetAllBlogPostsParams extends QueryParams {
  projectId?: number;
  status?: "draft" | "published" | "archived";
  locale?: string;
}

export const getAllBlogPostsPaged = (
  params: GetAllBlogPostsParams = {},
): Promise<PageBlogPostDTO> => {
  return apiFetch<PageBlogPostDTO>(`/blog?${buildQueryString(params)}`);
};

export const getBlogPostById = (id: number): Promise<BlogPostDTO> => {
  return apiFetch<BlogPostDTO>(`/blog/${id}`);
};

export const createBlogPost = (
  data: BlogPostCreateDTO,
): Promise<BlogPostDTO> => {
  return apiFetch<BlogPostDTO>("/blog", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateBlogPost = (
  id: number,
  data: BlogPostUpdateDTO,
): Promise<BlogPostDTO> => {
  return apiFetch<BlogPostDTO>(`/blog/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteBlogPost = (id: number): Promise<void> => {
  return apiFetch<void>(`/blog/${id}`, {
    method: "DELETE",
  });
};

export const publishBlogPost = (id: number): Promise<BlogPostDTO> => {
  return apiFetch<BlogPostDTO>(`/blog/${id}/publish`, {
    method: "POST",
  });
};

export const unpublishBlogPost = (id: number): Promise<BlogPostDTO> => {
  return apiFetch<BlogPostDTO>(`/blog/${id}/unpublish`, {
    method: "POST",
  });
};

/**
 * Slug-availability probe. Used by the FE form for the debounced
 * "is this slug free?" check on the title field. Returns
 * { available: boolean, slug: string } — note that availability is
 * scoped to (projectId, locale), so a slug can be "taken" on one
 * project and "free" on another.
 */
export async function checkBlogPostSlug(
  projectId: number,
  slug: string,
  locale = "hu",
): Promise<SlugCheckResponse> {
  const qs = new URLSearchParams({
    projectId: String(projectId),
    slug,
    locale,
  });
  return apiFetch<SlugCheckResponse>(`/blog/slug-check?${qs.toString()}`);
}

// ---------------------------------------------------------------------------
// Public read endpoints (no auth, mounted under /api/public/blog/*).
// Used by the admin UI's preview pane to render what the landing will
// see. The landing itself calls these directly from its prerender
// script — the wrapper functions below exist so the admin UI can show
// the same view the public gets.
// ---------------------------------------------------------------------------

export interface GetPublicBlogPostsParams {
  domain: string;
  locale?: string;
  /** ISO-8601 timestamp; only return posts updated at-or-after this. */
  since?: string;
  limit?: number;
}

export async function getPublicBlogPosts(
  params: GetPublicBlogPostsParams,
): Promise<PublicBlogPostsResponse> {
  const qs = new URLSearchParams();
  if (params.locale) qs.set("locale", params.locale);
  if (params.since) qs.set("since", params.since);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const url = `/api/public/blog/by-domain/${encodeURIComponent(params.domain)}/posts${
    qs.toString() ? `?${qs}` : ""
  }`;
  // Bypass the apiFetch wrapper because it adds CSRF headers and runs
  // through the auth pipeline — neither is appropriate for the public
  // surface. Use raw fetch with credentials omitted.
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`public blog fetch failed: ${res.status}`);
  }
  return res.json() as Promise<PublicBlogPostsResponse>;
}

export async function getPublicBlogPostSlugs(
  params: GetPublicBlogPostsParams,
): Promise<PublicBlogSlugsResponse> {
  const qs = new URLSearchParams();
  if (params.locale) qs.set("locale", params.locale);
  if (params.since) qs.set("since", params.since);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const url = `/api/public/blog/by-domain/${encodeURIComponent(params.domain)}/posts/slugs${
    qs.toString() ? `?${qs}` : ""
  }`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`public blog slugs fetch failed: ${res.status}`);
  }
  return res.json() as Promise<PublicBlogSlugsResponse>;
}

// ---------------------------------------------------------------------------
// Cover image upload — multipart POST to /api/blog/:id/cover.
// Returns the public URL where the uploaded image is served, which
// the caller stores into blog_posts.cover_image_url.
// ---------------------------------------------------------------------------

export interface BlogCoverUploadResponse {
  id: number;
  postId: number;
  originalFilename: string;
  storedFilename: string;
  mimeType: string;
  sizeBytes: number;
  purpose: "cover" | "inline";
  uploadedAt: string;
  /**
   * Public URL where the image is served, e.g.
   * "/api/public/blog/attachments/<uuid>.webp". Stored verbatim into
   * blog_posts.cover_image_url.
   */
  url: string;
}

export function uploadBlogCoverImage(
  postId: number,
  file: File,
): Promise<BlogCoverUploadResponse> {
  const formData = new FormData();
  formData.append("file", file);
  return apiUpload<BlogCoverUploadResponse>(
    `/blog/${postId}/cover`,
    formData,
  );
}

export function deleteBlogCoverImage(postId: number): Promise<void> {
  return apiFetch<void>(`/blog/${postId}/cover`, {
    method: "DELETE",
  });
}