// ----------------------------------------------------------------------------
// FAQPage — paged list of FAQ (GYIK) items. Same DataTable pattern as
// BlogPage. Columns: question (HU), project, status, sortOrder, updatedAt.
// Supports ?projectId=N deep-link filtering.
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
  getAllFaqItemsPaged,
  GetAllFaqItemsParams,
  PageFaqItemDTO,
} from "@/lib/faq";
import { FaqItemDTO, FaqItemStatus } from "@/types/faq";
import FaqActions from "@/components/faq/FaqActions";
import FaqPublishButton from "@/components/faq/FaqPublishButton";

const statusBadgeVariant = (status: FaqItemStatus) => {
  switch (status) {
    case "published":
      return "default" as const;
    case "draft":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
};

const FaqPage: React.FC = () => {
  const { t } = useTranslation(["faq", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  const statusParam = searchParams.get("status");
  const statusFilter =
    statusParam === "draft" || statusParam === "published"
      ? statusParam
      : undefined;



  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "sortOrder",
    sortOrder: "asc",
    queries: [],
    filterType: "any",
  });

  const fetchParams: GetAllFaqItemsParams = {
    page: queryParams.page,
    size: queryParams.size,
    sortField: queryParams.sortField,
    sortOrder: queryParams.sortOrder,
    queries: queryParams.queries,
    filterType: queryParams.filterType,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
    ...(statusFilter !== undefined ? { status: statusFilter } : {}),
  };

  const { data, isLoading } = useQuery<PageFaqItemDTO>({
    queryKey: ["faq", queryParams, projectIdFilter, statusFilter],
    queryFn: () => getAllFaqItemsPaged(fetchParams),
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
    (row: FaqItemDTO) => navigate(`/faq/view/${row.id}`),
    [navigate],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `/faq/create?projectId=${projectIdFilter}`
      : "/faq/create";

  const columns = [
    {
      accessorKey: "questionHu",
      header: t("faq:question_hu"),
      cell: (row: FaqItemDTO) => (
        <span className="font-medium truncate max-w-[300px]">{row.questionHu}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("faq:project"),
      cell: (row: FaqItemDTO) => row.projectName || "\u2014",
    },

    {
      accessorKey: "sortOrder",
      header: t("faq:order"),
      cell: (row: FaqItemDTO) => row.sortOrder,
      enableSorting: true,
    },
    {
      accessorKey: "status",
      header: t("faq:status"),
      cell: (row: FaqItemDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`faq:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "updatedAt",
      header: t("faq:updated"),
      cell: (row: FaqItemDTO) =>
        new Date(row.updatedAt).toLocaleString("hu-HU"),
      enableSorting: true,
    },
    {
      id: "actions",
      header: t("common:actions"),
      cell: (row: FaqItemDTO) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <FaqPublishButton item={row} />
          <FaqActions item={row} />
        </div>
      ),
      enableSorting: false,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t("faq:title", "GYIK")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t("faq:subtitle", "Gyakran Ismelt K\u00e9rd\u00e9sek kezel\u00e9se")}
          </p>
        </div>
        <Button onClick={() => navigate(createLink)}>
          <PlusCircle className="mr-2 h-4 w-4" />
          {t("faq:create", "\u00dajj t\u00e9tel")}
        </Button>
      </div>

      <Card>
        <CardContent className="pt-6">
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            isLoading={isLoading}
            queries={queryParams.queries}
            filterType={queryParams.filterType}
            onQueriesChange={handleQueriesChange}
            onFilterTypeChange={handleFilterTypeChange}
            onSortChange={handleSortChange}
            currentSortField={queryParams.sortField || "sortOrder"}
            currentSortOrder={queryParams.sortOrder || "asc"}
            onRowDoubleClick={handleRowDoubleClick}
            emptyMessage={t("faq:empty", "M\u00e9g nincsenek GYIK t\u00e9telek.")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default FaqPage;
