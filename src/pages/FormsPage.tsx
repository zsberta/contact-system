// ----------------------------------------------------------------------------
// FormsPage — paged list of forms. Mirrors ProjectsPage structurally:
// DataTable with name / slug / project / status / createdAt columns,
// a "Create form" button at the top, and row-level actions via FormActions.
// Supports `?projectId=N` deep-link filtering (ProjectViewPage passes the
// project's id in the URL when the operator clicks "Create form" for a
// given project).
// ----------------------------------------------------------------------------

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import { QueryParams } from "@/types/common";
import {
  getAllFormsPaged,
  PageFormDTO,
  GetAllFormsParams,
} from "@/lib/forms";
import { FormDTO, FormStatus } from "@/types/form";
import FormActions from "@/components/forms/FormActions";

const statusBadgeVariant = (status: FormStatus) => {
  return status === "disabled" ? ("destructive" as const) : ("default" as const);
};

const FormsPage: React.FC = () => {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Deep-link filter — `?projectId=N` narrows the list to forms of one project.
  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "createdAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const fetchParams: GetAllFormsParams = {
    ...queryParams,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
  };

  const { data, isLoading } = useQuery<PageFormDTO, Error>({
    queryKey: ["forms", queryParams, projectIdFilter],
    queryFn: () => getAllFormsPaged(fetchParams),
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
    (row: FormDTO) => navigate(`/forms/view/${row.id}`),
    [navigate],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `/forms/create?projectId=${projectIdFilter}`
      : "/forms/create";

  const columns = [
    {
      accessorKey: "name",
      header: t("forms:name"),
      cell: (row: FormDTO) => row.name || "—",
      enableSorting: true,
    },
    {
      accessorKey: "slug",
      header: t("forms:slug"),
      cell: (row: FormDTO) => (
        <span className="font-mono text-xs">{row.slug}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "projectName",
      header: t("forms:project"),
      cell: (row: FormDTO) => row.projectName || "—",
      enableSorting: false,
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: FormDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`forms:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: FormDTO) => new Date(row.createdAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: FormDTO) => <FormActions form={row} />,
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("forms:form_management")}
          </CardTitle>
          <div className="flex justify-start">
            <Link to={createLink}>
              <Button className="w-full sm:w-auto">
                <PlusCircle className="mr-2 h-4 w-4" />
                {t("forms:create_form")}
              </Button>
            </Link>
          </div>
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
            emptyMessage={t("forms:project_section_forms_empty")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default FormsPage;
