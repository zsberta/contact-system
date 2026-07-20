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

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import { QueryParams } from "@/types/common";
import {
  getAllBlogPostsPaged,
  GetAllBlogPostsParams,
  PageBlogPostDTO,
} from "@/lib/blog";
import { BlogPostDTO, BlogPostStatus } from "@/types/blog";
import BlogActions from "@/components/blog/BlogActions";
import BlogPublishButton from "@/components/blog/BlogPublishButton";

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

const BlogPage: React.FC = () => {
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

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "updatedAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const fetchParams: GetAllBlogPostsParams = {
    page: queryParams.page,
    size: queryParams.size,
    sortField: queryParams.sortField,
    sortOrder: queryParams.sortOrder,
    queries: queryParams.queries,
    filterType: queryParams.filterType,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
    ...(statusFilter !== undefined ? { status: statusFilter } : {}),
    ...(localeFilter !== undefined ? { locale: localeFilter } : {}),
  };

  const { data, isLoading } = useQuery<PageBlogPostDTO>({
    queryKey: ["blog", queryParams, projectIdFilter, statusFilter, localeFilter],
    queryFn: () => getAllBlogPostsPaged(fetchParams),
  });

  const handlePageChange = useCallback(
    (page: number) => setQueryParams((p) => ({ ...p, page })),
    [],
  );
  const handlePageSizeChange = useCallback(
    (size: number) => setQueryParams((p) => ({ ...p, size, page: 0 })),
    [],
  );
  const handleQueriesChange = useCallback(
    (queries: string[]) =>
      setQueryParams((p) => ({ ...p, queries, page: 0 })),
    [],
  );
  const handleFilterTypeChange = useCallback(
    (filterType: "any" | "all") =>
      setQueryParams((p) => ({ ...p, filterType, page: 0 })),
    [],
  );
  const handleSearch = useCallback(
    (query: string) =>
      setQueryParams((p) => ({
        ...p,
        queries: query ? [query] : [],
        page: 0,
      })),
    [],
  );
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryParams((p) => ({ ...p, sortField, sortOrder, page: 0 })),
    [],
  );
  const handleRowDoubleClick = useCallback(
    (row: BlogPostDTO) => navigate(`/blog/view/${row.id}`),
    [navigate],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `/blog/create?projectId=${projectIdFilter}`
      : "/blog/create";

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
  ];

  return (
    <div className="container mx-auto p-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle>{t("blog:page_title")}</CardTitle>
          <Button asChild size="sm">
            <a href={createLink}>
              <PlusCircle className="mr-2 h-4 w-4" />
              {t("blog:create_new")}
            </a>
          </Button>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content ?? []}
            isLoading={isLoading}
            pageInfo={data}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            queries={queryParams.queries ?? []}
            filterType={queryParams.filterType ?? "any"}
            onQueriesChange={handleQueriesChange}
            onFilterTypeChange={handleFilterTypeChange}
            onSortChange={handleSortChange}
            currentSortField={queryParams.sortField || "updatedAt"}
            currentSortOrder={queryParams.sortOrder || "desc"}
            onRowDoubleClick={handleRowDoubleClick}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default BlogPage;