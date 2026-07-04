// /portal — Enduser landing page.
//
// Lists every project the current enduser is assigned to. Each card
// links to /portal/projects/:id for a read-only view of that project
// and its forms/reservations/payments.

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, Eye, Loader2 } from "lucide-react";
import { getAllProjectsPaged } from "@/lib/api";
import type { QueryParams } from "@/types/common";
import type { ProjectDTO } from "@/types/project";

const statusBadgeVariant = (
  status: ProjectDTO["status"],
): "default" | "secondary" | "destructive" => {
  if (status === "cancelled") return "destructive";
  if (status === "under_construction") return "secondary";
  return "default";
};

const EnduserPortal: React.FC = () => {
  const { t } = useTranslation(["enduser", "projects", "common"]);
  const navigate = useNavigate();

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 50, // endusers usually have a small number of projects
    sortField: "name",
    sortOrder: "asc",
    queries: [],
    filterType: "any",
  });

  // Note: NO projectId filter is needed — the BE scopes to the
  // enduser's assigned projects automatically. The query key is keyed
  // off the role so a switch from admin→enduser or vice versa
  // invalidates the cache.
  const { data, isLoading, error } = useQuery({
    queryKey: ["portal", "projects", queryParams],
    queryFn: () => getAllProjectsPaged(queryParams),
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
  const handleRowDoubleClick = useCallback(
    (row: ProjectDTO) => navigate(`/portal/projects/${row.id}`),
    [navigate],
  );
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryParams((p) => ({ ...p, sortField, sortOrder, page: 0 })),
    [],
  );

  const columns = [
    {
      accessorKey: "name",
      header: t("projects:name"),
      cell: (row: ProjectDTO) => row.name || "—",
    },
    {
      accessorKey: "domainAddress",
      header: t("projects:domain_address"),
      cell: (row: ProjectDTO) => row.domainAddress || "—",
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: ProjectDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`projects:status_${row.status}`)}
        </Badge>
      ),
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ProjectDTO) => (
        <Link to={`/portal/projects/${row.id}`}>
          <Button size="sm" variant="outline">
            <Eye className="mr-2 h-4 w-4" />
            {t("enduser:view_project")}
          </Button>
        </Link>
      ),
    },
  ];

  return (
    <div className="mx-auto w-full space-y-4">
      <Card>
        <CardHeader className="flex flex-col space-y-2 pb-2">
          <CardTitle className="text-2xl font-bold break-words flex items-center gap-2">
            <Building2 className="h-6 w-6" />
            {t("enduser:my_projects")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("enduser:portal_description")}
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("common:loading")}
            </div>
          ) : error ? (
            <p className="text-sm text-muted-foreground">
              {t("common:operation_failed", { error: "" })}
            </p>
          ) : data && data.content.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              {t("enduser:my_projects_empty")}
            </p>
          ) : (
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
              currentSortField={queryParams.sortField || "name"}
              currentSortOrder={queryParams.sortOrder || "asc"}
              onRowDoubleClick={handleRowDoubleClick}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default EnduserPortal;
