// ----------------------------------------------------------------------------
// BlogEditPage — wraps BlogForm in edit mode. Fetches the post by id,
// then submits via updateBlogPost. The BlogForm component handles the
// immutability of projectId / locale / slug in edit mode.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { BlogPostDTO, BlogPostUpdateDTO } from "@/types/blog";
import { getBlogPostById, updateBlogPost } from "@/lib/blog";
import BlogForm from "@/components/blog/BlogForm";

const BlogEditPage: React.FC = () => {
  const { t } = useTranslation(["blog", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const postId = id && /^\d+$/.test(id) ? Number(id) : NaN;

  const { data: post, isLoading } = useQuery({
    queryKey: ["blog", "detail", postId],
    queryFn: () => getBlogPostById(postId),
    enabled: Number.isFinite(postId),
  });

  const updateMutation = useMutation({
    mutationFn: (data: BlogPostUpdateDTO) => updateBlogPost(postId, data),
    onSuccess: (data: BlogPostDTO) => {
      showSuccess(t("blog:saved_toast", { title: data.title }));
      queryClient.invalidateQueries({ queryKey: ["blog"] });
      queryClient.invalidateQueries({ queryKey: ["blog", "detail", postId] });
      const isPortal = window.location.pathname.startsWith("/portal");
      navigate(isPortal ? `/portal/blog/view/${data.id}` : `/blog/view/${data.id}`);
    },
    onError: (err: Error) => {
      showError(err.message || t("blog:save_failed_toast"));
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

  return (
    <div className="container mx-auto p-4 max-w-5xl">
      <BlogForm
        mode="edit"
        initialData={post}
        isSubmitting={updateMutation.isPending}
        onSubmit={(data: BlogPostUpdateDTO) => updateMutation.mutate(data)}
      />
    </div>
  );
};

export default BlogEditPage;