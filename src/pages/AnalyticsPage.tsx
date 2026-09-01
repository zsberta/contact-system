// ----------------------------------------------------------------------------
// AnalyticsPage — paged list of analytics configs. Mirrors FormsPage
// structurally: DataTable with name / project / status / createdAt, a
// "Create analytics" button, double-click row → /view, and row-level
// actions via AnalyticsActions.
// ----------------------------------------------------------------------------

import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { resolveModulePath } from "@/lib/workspace-navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { BarChart3 } from "lucide-react";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
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

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
  });

  const fetchParams: GetAllAnalyticsConfigsParams = {
    ...query,
  };

  const { data, isLoading } = useQuery<PageAnalyticsConfigDTO, Error>({
    queryKey: ["analytics", query],
    queryFn: () => getAllAnalyticsConfigsPaged(fetchParams),
  });

  const handleSearch = useCallback(
    (query: string) => handlers.onQueriesChange(query ? [query] : []),
    [handlers],
  );
  const handleRowDoubleClick = useCallback(
    async (row: AnalyticsConfigDTO) => {
      const path = await resolveModulePath(row.projectId, "analytics");
      if (path) navigate(path);
    },
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
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={handleSearch}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField}
            currentSortOrder={query.sortOrder}
            onRowDoubleClick={handleRowDoubleClick}
            emptyMessage={t("analytics:config_section_analytics_empty")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default AnalyticsPage;
