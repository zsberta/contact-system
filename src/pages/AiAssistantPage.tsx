// ----------------------------------------------------------------------------
// AiAssistantPage — paged list of AI assistant configs. Mirrors
// AnalyticsPage structurally: DataTable with name / project / status /
// createdAt, double-click row -> /view, and row-level actions via
// AiAssistantActions.
// ----------------------------------------------------------------------------

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { resolveModulePath } from "@/lib/workspace-navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Bot } from "lucide-react";
import { QueryParams } from "@/types/common";
import {
  getAllAiAssistantConfigsPaged,
  PageAiAssistantConfigDTO,
  GetAllAiAssistantConfigsParams,
} from "@/lib/ai-assistant";
import type { AiAssistantConfigDTO, AiAssistantStatus } from "@/types/ai-assistant";
import AiAssistantActions from "@/components/ai-assistant/AiAssistantActions";

const statusBadgeVariant = (status: AiAssistantStatus) =>
  status === "disabled" ? ("destructive" as const) : ("default" as const);

const AiAssistantPage: React.FC = () => {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const navigate = useNavigate();

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "createdAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const fetchParams: GetAllAiAssistantConfigsParams = {
    ...queryParams,
  };

  const { data, isLoading } = useQuery<PageAiAssistantConfigDTO, Error>({
    queryKey: ["ai-assistant", queryParams],
    queryFn: () => getAllAiAssistantConfigsPaged(fetchParams),
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
    async (row: AiAssistantConfigDTO) => {
      const path = await resolveModulePath(row.projectId, "ai-assistant");
      if (path) navigate(path);
    },
    [navigate],
  );

  const columns = [
    {
      accessorKey: "name",
      header: t("ai-assistant:name"),
      cell: (row: AiAssistantConfigDTO) => row.name || "—",
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("ai-assistant:project"),
      cell: (row: AiAssistantConfigDTO) => row.projectName || "—",
      enableSorting: false,
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: AiAssistantConfigDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`ai-assistant:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: AiAssistantConfigDTO) =>
        new Date(row.createdAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: AiAssistantConfigDTO) => (
        <AiAssistantActions config={row} />
      ),
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words flex items-center gap-2">
            <Bot className="h-6 w-6" />
            {t("ai-assistant:ai_assistant_management")}
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
            emptyMessage={t("ai-assistant:config_section_ai_assistant_empty")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default AiAssistantPage;
