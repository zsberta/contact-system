// ----------------------------------------------------------------------------
// BlogForm — shared create/edit form for blog posts.
//
// Pattern: RHF + zod (mirrors FormForm). Differences:
//   - Title and bodyHtml are the primary fields; SEO + locale are
//     collapsible secondary sections to keep the create-page uncluttered.
//   - The body uses the Tiptap-backed BlogBodyEditor. The editor owns
//     its own state but forwards HTML+JSON upward via onChange, and the
//     RHF form state holds the canonical values (so debounced save /
//     invalidation work the same way as for forms).
//   - Slug is auto-generated from title on create mode until the user
//     types in the field. On edit mode it is locked (changing slug
//     breaks inbound links without a redirect — same convention as forms).
//   - Project picker is read-only in edit mode (immutable post-create).
// ----------------------------------------------------------------------------

import { useEffect, useMemo, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { getProjectById } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Globe, Lock, Sparkles, Plus, Copy } from "lucide-react";
import type {
  BlogPostCreateDTO,
  BlogPostDTO,
  BlogPostUpdateDTO,
} from "@/types/blog";
import { showError, showSuccess } from "@/utils/toast";
import { checkBlogPostSlug } from "@/lib/blog";
import { Link } from "react-router-dom";
import type { ProjectDTO } from "@/types/project";
import BlogBodyEditor from "@/components/blog/BlogBodyEditor";
import { BlogProjectSelectorModal } from "@/components/blog/BlogProjectSelectorModal";
import { BlogCoverUploader } from "@/components/blog/BlogCoverUploader";

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const SLUG_MAX = 50;
const TITLE_MAX = 200;
const EXCERPT_MAX = 500;
const SEO_TITLE_MAX = 70;
const SEO_DESC_MAX = 200;

// Hungarian-friendly slug from a free-form title. Mirrors the server-side
// implementation in routes/blog.js#slugify so the auto-generated preview
// matches what the BE will store. Operators can override the field.
function slugify(title: string): string {
  if (!title) return "";
  const stripped = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (hyphenated.length <= SLUG_MAX) return hyphenated;
  const truncated = hyphenated.slice(0, SLUG_MAX);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 10 ? truncated.slice(0, lastHyphen) : truncated;
}

interface BlogFormValues {
  projectId: number | null;
  locale: string;
  title: string;
  slug: string;
  excerpt: string;
  coverImageUrl: string;
  bodyHtml: string;
  bodyJson: Record<string, unknown> | null;
  seoTitle: string;
  seoDescription: string;
  seoKeywordsRaw: string;
  ogImageUrl: string;
  canonicalUrl: string;
  // Read-only in the form — auto-set from a deep-link
  // ?translationGroupId=… param when the operator clicks "Új
  // fordítás" on the BlogViewPage. Submitting a fresh post with
  // this value links it to the existing translation group.
  translationGroupId: string;
}

interface BlogFormProps {
  initialData?: BlogPostDTO;
  mode: "create" | "edit";
  isSubmitting: boolean;
  /**
   * Optional pre-selected projectId (used by deep-link from
   * ProjectViewPage "Create blog post for this project").
   */
  initialProjectId?: number;
  /**
   * Optional pre-filled translationGroupId (used by deep-link from
   * BlogViewPage "Új fordítás hozzáadása" — the operator copies
   * the source post's group id, then opens the create form with
   * ?translationGroupId=<uuid> in the URL).
   */
  initialTranslationGroupId?: string;
  /**
   * Optional pre-selected locale for create mode (used by deep-link
   * from BlogViewPage's "Új fordítás" button — passes ?locale=en
   * or ?locale=hu so the operator doesn't have to re-pick). Edit
   * mode ignores this (locale is immutable post-create).
   */
  initialLocale?: string;
  onSubmit: (data: BlogPostCreateDTO | BlogPostUpdateDTO) => void;
}

const BlogForm: React.FC<BlogFormProps> = ({
  initialData,
  mode,
  isSubmitting,
  initialProjectId,
  initialTranslationGroupId,
  initialLocale,
  onSubmit,
}) => {
  const { t } = useTranslation(["blog", "common"]);
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  const initialValues = useMemo<BlogFormValues>(() => {
    if (initialData) {
      return {
        projectId: initialData.projectId,
        locale: initialData.locale,
        title: initialData.title,
        slug: initialData.slug,
        excerpt: initialData.excerpt ?? "",
        coverImageUrl: initialData.coverImageUrl ?? "",
        bodyHtml: initialData.bodyHtml,
        bodyJson: initialData.bodyJson ?? null,
        seoTitle: initialData.seoTitle ?? "",
        seoDescription: initialData.seoDescription ?? "",
        seoKeywordsRaw: (initialData.seoKeywords ?? []).join(", "),
        ogImageUrl: initialData.ogImageUrl ?? "",
        canonicalUrl: initialData.canonicalUrl ?? "",
        translationGroupId: initialData.translationGroupId,
      };
    }
    return {
      projectId: initialProjectId ?? null,
      // Pre-fill from ?locale= deep-link if the operator came in
      // via BlogViewPage's "Új fordítás" button. Otherwise default
      // to "hu". (Edit mode never reaches this branch — locale is
      // immutable after create.)
      locale: initialLocale ?? "hu",
      title: "",
      slug: "",
      excerpt: "",
      coverImageUrl: "",
      bodyHtml: "",
      bodyJson: null,
      seoTitle: "",
      seoDescription: "",
      seoKeywordsRaw: "",
      ogImageUrl: "",
      canonicalUrl: "",
      // Pre-fill with the deep-link value if the operator came in
      // via BlogViewPage's "Új fordítás" link. Otherwise leave
      // empty — the BE generates a fresh UUID on insert.
      translationGroupId: initialTranslationGroupId ?? "",
    };
  }, [initialData, initialProjectId, initialTranslationGroupId, initialLocale]);

  // Build the zod schema dynamically. Slug is required on edit; on create
  // it's optional (auto-generated from title) but if provided must match.
  const schema = useMemo(() => {
    return z.object({
      projectId: z
        .number({ message: t("blog:validation_project_required") })
        .int()
        .positive(),
      locale: z
        .string()
        .regex(LOCALE_RE, t("blog:validation_locale")),
      title: z
        .string()
        .min(1, t("blog:validation_title_required"))
        .max(TITLE_MAX, t("blog:validation_title_too_long", { max: TITLE_MAX })),
      slug: z
        .string()
        .min(1, t("blog:validation_slug_required"))
        .max(SLUG_MAX, t("blog:validation_slug_too_long", { max: SLUG_MAX }))
        .regex(SLUG_RE, t("blog:validation_slug_format")),
      excerpt: z.string().max(EXCERPT_MAX, t("blog:validation_excerpt_too_long", { max: EXCERPT_MAX })),
      coverImageUrl: z.string().url(t("blog:validation_url_invalid")).or(z.literal("")),
      bodyHtml: z.string().min(1, t("blog:validation_body_required")),
      bodyJson: z.any().nullable(),
      seoTitle: z.string().max(SEO_TITLE_MAX, t("blog:validation_seo_title_too_long", { max: SEO_TITLE_MAX })),
      seoDescription: z.string().max(SEO_DESC_MAX, t("blog:validation_seo_desc_too_long", { max: SEO_DESC_MAX })),
      seoKeywordsRaw: z.string(),
      canonicalUrl: z.string().url(t("blog:validation_url_invalid")).or(z.literal("")),
      // Read-only in the form (rendered as copyable text), but
      // validated as a UUID when present so a typo doesn't
      // silently unlink the post from its group on save.
      translationGroupId: z
        .string()
        .refine(
          (v) => v === "" || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
          { message: t("blog:validation_translation_group_id") },
        ),
    });
  }, [t]);

  const form = useForm<BlogFormValues>({
    resolver: zodResolver(schema),
    defaultValues: initialValues,
  });

  // Reset the form whenever initialData changes (e.g. when edit page
  // finishes loading). Without this, the form keeps the empty defaults
  // from the first render and the user sees blank fields for ~200ms.
  useEffect(() => {
    form.reset(initialValues);
    setSlugManuallyEdited(mode === "edit");
  }, [initialValues, mode, form]);

  const watchedTitle = form.watch("title");
  const watchedProjectId = form.watch("projectId");
  const watchedLocale = form.watch("locale");
  const watchedSlug = form.watch("slug");

  // Auto-slug preview: when the user types a title and hasn't manually
  // touched the slug field, we update the slug with the slugified title.
  useEffect(() => {
    if (mode === "edit") return;
    if (slugManuallyEdited) return;
    if (!watchedTitle) return;
    const generated = slugify(watchedTitle);
    if (generated && generated !== form.getValues("slug")) {
      form.setValue("slug", generated, { shouldValidate: false });
    }
  }, [watchedTitle, slugManuallyEdited, mode, form]);

  // Slug-availability probe — fires after the slug field is valid and
  // stable. Used purely as a UX hint ("slug is free / taken"), not as a
  // hard gate (the BE will 409 on collision at submit time).
  const slugProbeEnabled =
    !!watchedProjectId &&
    !!watchedLocale &&
    !!watchedSlug &&
    SLUG_RE.test(watchedSlug) &&
    watchedSlug.length <= SLUG_MAX &&
    (mode === "create" || watchedSlug !== initialData?.slug);

  const { data: slugProbe, isFetching: slugProbeLoading } = useQuery({
    queryKey: ["blog", "slug-check", watchedProjectId, watchedLocale, watchedSlug],
    queryFn: () =>
      checkBlogPostSlug(watchedProjectId!, watchedSlug, watchedLocale),
    enabled: slugProbeEnabled,
    // Cache the result for 30s — the user usually finishes typing within
    // a few seconds, and stale-but-correct results are fine here.
    staleTime: 30_000,
  });

  // Fetch project brand color for editor theming.
  const { data: projectData } = useQuery({
    queryKey: ["projects", watchedProjectId],
    queryFn: () => getProjectById(watchedProjectId!),
    enabled: Number.isFinite(watchedProjectId),
    staleTime: 60_000,
  });
  const brandColor = projectData?.brandColor ?? null;

  // Project picker — delegated to BlogProjectSelectorModal which
// wraps the shared ModalDatatableSelect. The modal handles its own
// pagination, search, and sort via the projects API; we just
// surface the chosen Project back into the form. In edit mode the
// picker is replaced with a read-only project name field (immutable
// per migration 0017 — public URLs depend on the project's
// domain_address and changing projects mid-edit would silently
// orphan the post).

  const handleSubmit = form.handleSubmit((values) => {
    // Don't bother the BE if the slug is provably taken on the same
    // (projectId, locale). Save a roundtrip and surface a clean error.
    if (slugProbeEnabled && slugProbe && slugProbe.available === false) {
      showError(t("blog:slug_taken"));
      form.setError("slug", {
        type: "manual",
        message: t("blog:slug_taken"),
      });
      return;
    }

    const seoKeywords = values.seoKeywordsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 20);

    const basePayload = {
      locale: values.locale,
      title: values.title,
      slug: values.slug,
      excerpt: values.excerpt || null,
      coverImageUrl: values.coverImageUrl || null,
      bodyHtml: values.bodyHtml,
      bodyJson: values.bodyJson,
      seoTitle: values.seoTitle || null,
      seoDescription: values.seoDescription || null,
      seoKeywords,
      // ogImageUrl is intentionally omitted — the public API
      // resolves it from cover_image_url when the operator hasn't
      // uploaded a separate OG asset. Sending undefined here is
      // fine: the BE treats an absent og_image_url as "no
      // override" and the DTO resolver falls back to cover.
      canonicalUrl: values.canonicalUrl || null,
      // Empty string in the form means "no override — let the BE
      // generate a fresh group id" (POST) or "don't change the
      // group" (PUT, where the field isn't in the SET clause).
      translationGroupId: values.translationGroupId || undefined,
    };

    if (mode === "create") {
      const payload: BlogPostCreateDTO = {
        ...basePayload,
        projectId: values.projectId!,
      };
      onSubmit(payload);
    } else {
      const payload: BlogPostUpdateDTO = basePayload;
      onSubmit(payload);
    }
  });

  return (
    <Form {...form}>
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Main editor card */}
        <Card>
          <CardHeader>
            <CardTitle>{t("blog:section_main")}</CardTitle>
            <CardDescription>
              {mode === "create"
                ? t("blog:section_main_desc_create")
                : t("blog:section_main_desc_edit")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Project picker */}
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:project")}</FormLabel>
                  {mode === "create" ? (
                    <FormControl>
                      <BlogProjectSelectorModal
                        selectedId={field.value ?? null}
                        onSelect={(picked: ProjectDTO) => {
                          field.onChange(picked.id);
                        }}
                      />
                    </FormControl>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Input
                        value={initialData?.projectName ?? ""}
                        disabled
                        className="font-mono text-sm"
                      />
                      <Lock className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-[200px,1fr] gap-4">
              {/* Locale */}
              <FormField
                control={form.control}
                name="locale"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("blog:locale")}</FormLabel>
                    {mode === "create" ? (
                      <Select
                        value={field.value}
                        onValueChange={field.onChange}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="hu">hu</SelectItem>
                          <SelectItem value="en">en</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Input
                          value={field.value}
                          disabled
                          className="font-mono text-sm"
                        />
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <FormDescription>{t("blog:locale_help")}</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Title */}
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("blog:title")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        placeholder={t("blog:title_placeholder")}
                        maxLength={TITLE_MAX}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Slug */}
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-2">
                    {t("blog:slug")}
                    {mode === "create" && !slugManuallyEdited && watchedTitle && (
                      <span className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                        <Sparkles className="h-3 w-3" />
                        {t("blog:slug_auto")}
                      </span>
                    )}
                  </FormLabel>
                  <FormControl>
                    <div className="flex items-center gap-2">
                      <Input
                        {...field}
                        placeholder="my-post-title"
                        disabled={mode === "edit"}
                        className="font-mono text-sm"
                        onChange={(e) => {
                          field.onChange(e);
                          setSlugManuallyEdited(true);
                        }}
                      />
                      {mode === "edit" && (
                        <Lock className="h-4 w-4 text-muted-foreground" />
                      )}
                      {slugProbeLoading && (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                      )}
                      {slugProbe && slugProbe.available && (
                        <Badge variant="outline" className="text-green-600">
                          {t("blog:slug_free")}
                        </Badge>
                      )}
                      {slugProbe && !slugProbe.available && (
                        <Badge variant="destructive">
                          {t("blog:slug_taken")}
                        </Badge>
                      )}
                    </div>
                  </FormControl>
                  <FormDescription>{t("blog:slug_help")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Excerpt */}
            <FormField
              control={form.control}
              name="excerpt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:excerpt")}</FormLabel>
                  <FormControl>
                    <textarea
                      {...field}
                      placeholder={t("blog:excerpt_placeholder")}
                      maxLength={EXCERPT_MAX}
                      rows={3}
                      className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </FormControl>
                  <FormDescription>
                    {t("blog:excerpt_help", { max: EXCERPT_MAX })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Cover image URL */}
            <FormField
              control={form.control}
              name="coverImageUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:cover_image")}</FormLabel>
                  <FormControl>
                    <BlogCoverUploader
                      postId={initialData?.id ?? null}
                      value={field.value || null}
                      onChange={(url) => field.onChange(url ?? "")}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("blog:cover_image_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Body editor */}
            <FormField
              control={form.control}
              name="bodyHtml"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:body")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="bodyJson"
                      render={({ field: jsonField }) => (
                        <BlogBodyEditor
                          initialJson={jsonField.value}
                          initialHtml={field.value}
                          placeholder={t("blog:editor_placeholder")}
                          brandColor={brandColor ?? undefined}
                          onChange={(value) => {
                            field.onChange(value.html);
                            jsonField.onChange(value.json);
                          }}
                        />
                      )}
                    />
                  </FormControl>
                  <FormDescription>{t("blog:body_help")}</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* SEO card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              {t("blog:section_seo")}
            </CardTitle>
            <CardDescription>{t("blog:section_seo_desc")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <FormField
              control={form.control}
              name="seoTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:seo_title")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("blog:seo_title_placeholder")}
                      maxLength={SEO_TITLE_MAX}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("blog:seo_title_help", { max: SEO_TITLE_MAX })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="seoDescription"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:seo_description")}</FormLabel>
                  <FormControl>
                    <textarea
                      {...field}
                      placeholder={t("blog:seo_description_placeholder")}
                      maxLength={SEO_DESC_MAX}
                      rows={2}
                      className="flex min-h-[60px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                    />
                  </FormControl>
                  <FormDescription>
                    {t("blog:seo_description_help", { max: SEO_DESC_MAX })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="seoKeywordsRaw"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("blog:seo_keywords")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder={t("blog:seo_keywords_placeholder")}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("blog:seo_keywords_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* OG image is not a free-form URL field — we
                  always reuse the cover image. The OG meta tag in
                  the prerendered HTML and the ogImageUrl in the
                  public API both fall back to coverImageUrl when
                  no explicit OG image is set, so the operator
                  doesn't have to maintain two URLs. We display
                  the resolved URL (or a hint) read-only so they
                  can confirm what's being shipped. */}
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  {t("blog:og_image")}
                  <Lock className="h-3 w-3 text-muted-foreground" />
                </FormLabel>
                <FormControl>
                  {(() => {
                    const cover = form.watch("coverImageUrl");
                    const resolved = cover?.trim() || null;
                    return resolved ? (
                      <code className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 py-2 text-xs font-mono break-all">
                        {resolved}
                      </code>
                    ) : (
                      <div className="flex h-10 w-full items-center rounded-md border border-dashed border-input px-3 text-xs italic text-muted-foreground">
                        {t("blog:og_image_no_cover")}
                      </div>
                    );
                  })()}
                </FormControl>
                <FormDescription>{t("blog:og_image_help")}</FormDescription>
              </FormItem>

              <FormField
                control={form.control}
                name="canonicalUrl"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("blog:canonical_url")}</FormLabel>
                    <FormControl>
                      <Input
                        {...field}
                        type="url"
                        placeholder="https://example.com/blog/post-slug"
                      />
                    </FormControl>
                    <FormDescription>
                      {t("blog:canonical_url_help")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </CardContent>
        </Card>

        {/* Translations — links this post to its locale variants. The
            operator copies the UUID when creating a new post in
            another language (the BlogViewPage's "Új fordítás"
            link pre-fills this field via ?translationGroupId=
            query param). In create mode, the field is
            pre-fillable but the operator doesn't have to type
            anything (the BE auto-generates a fresh UUID on
            insert if the field is empty). In edit mode, the
            field is read-only — changing the group is a niche
            operation, not a typical one. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4" />
              {t("blog:section_translations")}
            </CardTitle>
            <CardDescription>
              {t("blog:section_translations_desc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <FormField
              control={form.control}
              name="translationGroupId"
              render={({ field }) => {
                // In create mode the field is editable (operator
                // can paste a UUID from another post to link the
                // translations), in edit mode it's read-only
                // because changing the group is a niche flow.
                const isReadOnly = mode === "edit";
                return (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      {t("blog:translations_group_id")}
                      {isReadOnly && (
                        <Lock className="h-3 w-3 text-muted-foreground" />
                      )}
                    </FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        <Input
                          {...field}
                          value={field.value ?? ""}
                          readOnly={isReadOnly}
                          placeholder={t(
                            "blog:translations_group_id_placeholder",
                          )}
                          className="font-mono text-xs"
                          onChange={(e) => field.onChange(e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-10 w-10 p-0 flex-shrink-0"
                          onClick={() => {
                            if (navigator?.clipboard && field.value) {
                              navigator.clipboard.writeText(field.value);
                              showSuccess(t("blog:translations_id_copied"));
                            }
                          }}
                          disabled={!field.value}
                          title={t("blog:translations_copy_id")}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </div>
                    </FormControl>
                    <FormDescription>
                      {t("blog:translations_group_id_help")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                );
              }}
            />

            {/* "Új fordítás hozzáadása" deep-link — only meaningful
                in edit mode (the post already has an id and a
                group). In create mode the form itself is the
                "new translation" target. */}
            {mode === "edit" && initialData && (
              <div>
                <Button
                  asChild
                  variant="outline"
                  size="sm"
                  className="w-full sm:w-auto"
                >
                  <Link
                    to={`/blog/create?projectId=${initialData.projectId}&translationGroupId=${initialData.translationGroupId}`}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    {t("blog:translations_add_new")}
                  </Link>
                </Button>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t("blog:translations_add_new_help")}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("common:saving")}
              </>
            ) : mode === "create" ? (
              t("blog:create_button")
            ) : (
              t("common:save")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default BlogForm;