// ----------------------------------------------------------------------------
// AnalyticsPage — paged list of analytics configs. Mirrors FormsPage
// structurally: DataTable with name / project / status / createdAt, a
// "Create analytics" button, double-click row → /view, and row-level
// actions via AnalyticsActions.
// ----------------------------------------------------------------------------

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { BarChart3 } from "lucide-react";
import { QueryParams } from "@/types/common";
import {
  getAllAnalyticsConfigsPaged,
  PageAnalyticsConfigDTO,
  GetAllAnalyticsConfigsParams,
} from "@/lib/analytics";
import { AnalyticsConfigDTO, AnalyticsStatus } from "@/types/analytics";
import AnalyticsActions from "@/components/analytics/AnalyticsActions";

const statusBadgeVariant = (status: AnalyticsStatus) =>
  status === "disabled" ? ("destructive" as const) : ("default" as const);

const AnalyticsPage: React.FC = () => {
  const { t } = useTranslation(["analytics", "common"]);
  const navigate = useNavigate();

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "createdAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const fetchParams: GetAllAnalyticsConfigsParams = {
    ...queryParams,
  };

  const { data, isLoading } = useQuery<PageAnalyticsConfigDTO, Error>({
    queryKey: ["analytics", queryParams],
    queryFn: () => getAllAnalyticsConfigsPaged(fetchParams),
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
    (row: AnalyticsConfigDTO) => navigate(`/analytics/view/${row.id}`),
    [navigate],
  );

  const columns = [
    {
      accessorKey: "name",
      header: t("analytics:name"),
      cell: (row: AnalyticsConfigDTO) => row.name || "—",
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("analytics:project"),
      cell: (row: AnalyticsConfigDTO) => row.projectName || "—",
      enableSorting: false,
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: AnalyticsConfigDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`analytics:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: AnalyticsConfigDTO) =>
        new Date(row.createdAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: AnalyticsConfigDTO) => <AnalyticsActions config={row} />,
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words flex items-center gap-2">
            <BarChart3 className="h-6 w-6" />
            {t("analytics:analytics_management")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            queries={queryParams.queries}
            filterType={queryParams.filterType}
            onQueriesChange={handleQueriesChange}
            onFilterTypeChange={handleFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handleSortChange}
            currentSortField={queryParams.sortField || "createdAt"}
            currentSortOrder={queryParams.sortOrder || "desc"}
            onRowDoubleClick={handleRowDoubleClick}
            emptyMessage={t("analytics:config_section_analytics_empty")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default AnalyticsPage;
