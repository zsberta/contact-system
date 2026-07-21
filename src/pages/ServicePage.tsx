// ----------------------------------------------------------------------------
// ServicePage — paged list of Service (Szolgaltatasok) items. Same DataTable pattern as
// FaqPage. Columns: title (HU), project, status, sortOrder, updatedAt.
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
  getAllServiceItemsPaged,
  GetAllServiceItemsParams,
  PageServiceItemDTO,
} from "@/lib/service";
import { ServiceItemDTO, ServiceItemStatus } from "@/types/service";
import ServiceActions from "@/components/service/ServiceActions";
import ServicePublishButton from "@/components/service/ServicePublishButton";

const statusBadgeVariant = (status: ServiceItemStatus) => {
  switch (status) {
    case "published":
      return "default" as const;
    case "draft":
      return "secondary" as const;
    default:
      return "secondary" as const;
  }
};

interface ServicePageProps {
  basePath?: string;
  /** Project ID from context (portal mode). Used when no URL projectId is set. */
  contextProjectId?: number | null;
}

const ServicePage: React.FC<ServicePageProps> = ({ basePath = "/services", contextProjectId = undefined }) => {
  const { t } = useTranslation(["service", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : contextProjectId ?? undefined;

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

  const fetchParams: GetAllServiceItemsParams = {
    page: queryParams.page,
    size: queryParams.size,
    sortField: queryParams.sortField,
    sortOrder: queryParams.sortOrder,
    queries: queryParams.queries,
    filterType: queryParams.filterType,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
    ...(statusFilter !== undefined ? { status: statusFilter } : {}),
  };

  const queryKeyProjectId = projectIdFilter ?? contextProjectId ?? null;

  const { data, isLoading } = useQuery<PageServiceItemDTO>({
    queryKey: ["service", queryParams, queryKeyProjectId, statusFilter],
    queryFn: () => getAllServiceItemsPaged(fetchParams),
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
    (queries: string[])=>
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
    (row: ServiceItemDTO) => navigate(`${basePath}/view/${row.id}`),
    [navigate, basePath],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `${basePath}/create?projectId=${projectIdFilter}`
      : `${basePath}/create`;

  const columns = [
    {
      accessorKey: "titleHu",
      header: t("service:title_hu"),
      cell: (row: ServiceItemDTO) => (
        <span className="font-medium truncate max-w-[300px]">{row.titleHu}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("service:project"),
      cell: (row: ServiceItemDTO) => row.projectName || "\u2014",
    },

    {
      accessorKey: "sortOrder",
      header: t("service:order"),
      cell: (row: ServiceItemDTO) => row.sortOrder,
      enableSorting: true,
    },
    {
      accessorKey: "status",
      header: t("service:status"),
      cell: (row: ServiceItemDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`service:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "updatedAt",
      header: t("service:updated"),
      cell: (row: ServiceItemDTO) =>
        new Date(row.updatedAt).toLocaleString("hu-HU"),
      enableSorting: true,
    },
    {
      id: "actions",
      header: t("common:actions"),
      cell: (row: ServiceItemDTO) => (
        <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <ServicePublishButton item={row} />
          <ServiceActions item={row} />
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
            {t("service:title", "Szolgaltatasok")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t("service:subtitle", "Szolgaltatasok kezelese")}
          </p>
        </div>
        <Button onClick={() => navigate(createLink)}>
          <PlusCircle className="mr-2 h-4 w-4" />
          {t("service:create", "\u00dajj t\u00e9tel")}
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
            emptyMessage={t("service:empty", "M\u00e9g nincsenek szolg\u00e1ltat\u00e1s t\u00e9telek.")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default ServicePage;
