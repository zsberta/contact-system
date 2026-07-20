// ----------------------------------------------------------------------------
// BlogCreatePage — wraps BlogForm in create mode, hooks up the mutation.
// Supports ?projectId=N deep-link from ProjectViewPage.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { showError, showSuccess } from "@/utils/toast";
import {
  BlogPostCreateDTO,
  BlogPostDTO,
} from "@/types/blog";
import { createBlogPost } from "@/lib/blog";
import BlogForm from "@/components/blog/BlogForm";

const BlogCreatePage: React.FC = () => {
  const { t } = useTranslation(["blog", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const projectIdParam = searchParams.get("projectId");
  const initialProjectId =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;
  // Optional: when the operator clicks "Új fordítás hozzáadása" on
  // BlogViewPage, the link carries ?translationGroupId=<uuid>. We
  // pre-fill the form's translationGroupId with it so the new post
  // is linked to the existing translations on save.
  //
  // Format check: must be a UUID (8-4-4-4-12 hex chars). Anything
  // else is treated as no value — a malformed link shouldn't 500 the
  // create page.
  const translationGroupIdParam = searchParams.get("translationGroupId");
  const initialTranslationGroupId =
    translationGroupIdParam &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      translationGroupIdParam,
    )
      ? translationGroupIdParam
      : undefined;

  // Optional locale deep-link — the BlogViewPage's "Új fordítás
  // hozzáadása" button carries ?locale=en (or hu) so the operator
  // doesn't have to re-pick the language in the form. We accept
  // only "hu" and "en" because those are the languages the landing
  // serves — anything else falls back to the form's default (hu).
  const localeParam = searchParams.get("locale");
  const initialLocale = localeParam === "en" || localeParam === "hu"
    ? localeParam
    : undefined;

  const createMutation = useMutation({
    mutationFn: (data: BlogPostCreateDTO) => createBlogPost(data),
    onSuccess: (data: BlogPostDTO) => {
      showSuccess(t("blog:created_toast", { title: data.title }));
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      // Navigate to portal view if we're in the portal, admin view otherwise
      const isPortal = window.location.pathname.startsWith("/portal");
      navigate(isPortal ? `/portal/blog/view/${data.id}` : `/blog/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:create_failed_toast"));
    },
  });

  return (
    <div className="container mx-auto p-4 max-w-5xl">
      <BlogForm
        mode="create"
        isSubmitting={createMutation.isPending}
        initialProjectId={initialProjectId}
        initialTranslationGroupId={initialTranslationGroupId}
        initialLocale={initialLocale}
        onSubmit={(data: BlogPostCreateDTO) => createMutation.mutate(data)}
      />
    </div>
  );
};

export default BlogCreatePage;