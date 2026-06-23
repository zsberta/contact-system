import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import { PageProjectDTO, ProjectDTO } from "@/types/project";
import type { BillingPeriod } from "@/types/project";
import { getAllProjectsPaged } from "@/lib/api";
import { QueryParams } from "@/types/common";
import ProjectActions from "@/components/projects/ProjectActions";

const formatPrice = (price: number | null): string => {
  if (price === null || price === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(price);
};

const statusBadgeVariant = (
  status: ProjectDTO["status"],
): "default" | "secondary" | "destructive" => {
  if (status === "cancelled") return "destructive";
  if (status === "under_construction") return "secondary";
  return "default";
};

const ProjectsPage: React.FC = () => {
  const { t } = useTranslation(["projects", "common"]);
  const navigate = useNavigate();

  const formatFordulonap = (
    fordulonap: string | null,
    period: BillingPeriod | null,
  ): string => {
    if (!fordulonap || !period) return "—";
    if (period === "monthly") {
      const day = fordulonap.padStart(2, "0");
      return t("projects:every_month_day", { day });
    }
    if (period === "yearly") {
      // fordulonap is "MM-DD"
      const [mm, dd] = fordulonap.split("-");
      return t("projects:billing_month_day", { month: mm, day: dd });
    }
    // one_off: "YYYY-MM-DD"
    const d = new Date(fordulonap);
    if (Number.isNaN(d.getTime())) return fordulonap;
    return d.toLocaleDateString();
  };

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "createdAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const { data, isLoading } = useQuery<PageProjectDTO, Error>({
    queryKey: ["projects", queryParams],
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
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryParams((p) => ({ ...p, sortField, sortOrder, page: 0 })),
    [],
  );
  const handleRowDoubleClick = useCallback(
    (row: ProjectDTO) => navigate(`/projects/view/${row.id}`),
    [navigate],
  );

  const columns = [
    {
      accessorKey: "name",
      header: t("projects:name"),
      cell: (row: ProjectDTO) => row.name || "—",
      enableSorting: true,
    },
    {
      accessorKey: "customerName",
      header: t("projects:customer"),
      cell: (row: ProjectDTO) => row.customerName || "—",
      enableSorting: true,
    },
    {
      accessorKey: "domainAddress",
      header: t("projects:domain_address"),
      cell: (row: ProjectDTO) => row.domainAddress || "—",
      enableSorting: true,
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: ProjectDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`projects:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "fordulonap",
      header: t("projects:fordulonap"),
      cell: (row: ProjectDTO) =>
        formatFordulonap(row.fordulonap, row.billingPeriod),
      enableSorting: true,
    },
    {
      accessorKey: "price",
      header: t("projects:price"),
      cell: (row: ProjectDTO) => formatPrice(row.price),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ProjectDTO) => <ProjectActions project={row} />,
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("projects:project_management")}
          </CardTitle>
          <div className="flex justify-start">
            <Link to="/projects/create">
              <Button className="w-full sm:w-auto">
                <PlusCircle className="mr-2 h-4 w-4" />
                {t("projects:create_project")}
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
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default ProjectsPage;