// ----------------------------------------------------------------------------
// BlogPage — paged list of blog posts. Mirrors FormsPage structurally:
// DataTable with title / slug / project / status / locale / publishedAt
// columns, a "New post" button at the top, and row-level actions via
// BlogActions. Supports `?projectId=N` deep-link filtering.
//
// Enduser note: the BE scope on this endpoint restricts endusers to posts
// on projects they're assigned to. The page renders whatever the BE returns;
// no client-side filtering is applied.
// ----------------------------------------------------------------------------

import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import {
  getAllBlogPostsPaged,
  GetAllBlogPostsParams,
  PageBlogPostDTO,
} from "@/lib/blog";
import { BlogPostDTO, BlogPostStatus } from "@/types/blog";
import BlogActions from "@/components/blog/BlogActions";
import BlogPublishButton from "@/components/blog/BlogPublishButton";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";

const statusBadgeVariant = (status: BlogPostStatus) => {
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

interface BlogPageProps {
  /** Show the "New post" button. Defaults to true. Set to false for
   *  enduser portal views where creating posts is not allowed. */
  showCreateButton?: boolean;
  /** Show row-level action buttons (publish toggle, edit/delete dropdown).
   *  Defaults to true. Set to false for enduser portal views. */
  showRowActions?: boolean;
}

const BlogPage: React.FC<BlogPageProps> = ({ showCreateButton = true, showRowActions = true }) => {
  const { t } = useTranslation(["blog", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Deep-link filter — `?projectId=N` narrows the list to posts of one project.
  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  // Status filter — `?status=draft|published|archived`. Default: all statuses.
  const statusParam = searchParams.get("status");
  const statusFilter =
    statusParam === "draft" ||
    statusParam === "published" ||
    statusParam === "archived"
      ? statusParam
      : undefined;

  // Locale filter — `?locale=hu|en`. Default: 'hu'.
  const localeParam = searchParams.get("locale");
  const localeFilter =
    localeParam && /^[a-z]{2}(-[A-Z]{2})?$/.test(localeParam)
      ? localeParam
      : "hu";

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "updatedAt",
    defaultSortOrder: "desc",
  });

  const fetchParams: GetAllBlogPostsParams = {
    page: query.page,
    size: query.size,
    sortField: query.sortField,
    sortOrder: query.sortOrder,
    queries: query.queries,
    filterType: query.filterType,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
    ...(statusFilter !== undefined ? { status: statusFilter } : {}),
    ...(localeFilter !== undefined ? { locale: localeFilter } : {}),
  };

  const { data, isLoading } = useQuery<PageBlogPostDTO>({
    queryKey: ["blog", query, projectIdFilter, statusFilter, localeFilter],
    queryFn: () => getAllBlogPostsPaged(fetchParams),
  });

  const handleSearch = useCallback(
    (query: string) =>
      handlers.onQueriesChange(query ? [query] : []),
    [handlers],
  );
  const handleRowDoubleClick = useCallback(
    (row: BlogPostDTO) => navigate(`/blog/view/${row.id}`),
    [navigate],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `/blog/create?projectId=${projectIdFilter}`
      : `/blog/create`;

  const columns = [
    {
      accessorKey: "title",
      header: t("blog:title"),
      cell: (row: BlogPostDTO) => (
        <span className="font-medium">{row.title}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "slug",
      header: t("blog:slug"),
      cell: (row: BlogPostDTO) => (
        <span className="font-mono text-xs">/{row.slug}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("blog:project"),
      cell: (row: BlogPostDTO) => row.projectName || "—",
    },
    {
      accessorKey: "locale",
      header: t("blog:locale"),
      cell: (row: BlogPostDTO) => (
        <Badge variant="outline" className="font-mono text-xs">
          {row.locale}
        </Badge>
      ),
    },
    {
      accessorKey: "status",
      header: t("blog:status"),
      cell: (row: BlogPostDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`blog:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "updatedAt",
      header: t("blog:updated"),
      cell: (row: BlogPostDTO) =>
        new Date(row.updatedAt).toLocaleString("hu-HU"),
      enableSorting: true,
    },
    {
      accessorKey: "publishedAt",
      header: t("blog:published"),
      cell: (row: BlogPostDTO) =>
        row.publishedAt
          ? new Date(row.publishedAt).toLocaleDateString("hu-HU")
          : "—",
      enableSorting: true,
    },
    ...(showRowActions
      ? [
          {
            id: "actions",
            header: t("common:actions"),
            cell: (row: BlogPostDTO) => (
              <div className="flex items-center gap-1">
                <BlogPublishButton post={row} variant="compact" />
                <BlogActions post={row} />
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="container mx-auto p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>{t("blog:page_title")}</CardTitle>
          {showCreateButton && (
            <Button asChild size="sm">
              <a href={createLink}>
                <PlusCircle className="mr-2 h-4 w-4" />
                {t("blog:create_new")}
              </a>
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content ?? []}
            isLoading={isLoading}
            pageInfo={data}
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={handleSearch}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField || "updatedAt"}
            currentSortOrder={query.sortOrder || "desc"}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default BlogPage;