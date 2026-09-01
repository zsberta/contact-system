// ----------------------------------------------------------------------------
// ReservationCustomersPage — project-scoped, paged DataTable of customers.
// Shows name, email, and phone. Links to the customer detail page.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { getReservationCustomers } from "@/lib/reservations";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import type { ReservationCustomerDTO } from "@/types/reservation";

export default function ReservationCustomersPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();

  const projectId = projectIdParam ? Number(projectIdParam) : undefined;

  const { query, handlers } = useDataTableQuery({ defaultSize: 10 });

  const { data, isLoading } = useQuery({
    queryKey: ["reservation-customers", query, projectId],
    queryFn: () =>
      getReservationCustomers({
        search: query.searchText || undefined,
        projectId,
        page: query.page,
        size: query.size,
        queries: query.queries,
        filterType: query.filterType,
      }),
  });

  // Build the detail link for each customer — workspace route when available,
  // legacy admin route otherwise.
  const detailPath = (customerId: number) => {
    if (projectIdParam && moduleIdParam) {
      return `/workspace/projects/${projectIdParam}/modules/reservation/${moduleIdParam}/customers/${customerId}`;
    }
    return `/reservations/customers/${customerId}`;
  };

  const columns = [
    {
      accessorKey: "lastName",
      header: t("reservations:name"),
      cell: (row: ReservationCustomerDTO) =>
        [row.lastName, row.firstName].filter(Boolean).join(" ") || "—",
    },
    {
      accessorKey: "email",
      header: t("reservations:email"),
      cell: (row: ReservationCustomerDTO) => row.email || "—",
    },
    {
      accessorKey: "phone",
      header: t("reservations:phone"),
      cell: (row: ReservationCustomerDTO) => row.phone || "—",
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ReservationCustomerDTO) => (
        <Button variant="ghost" size="icon" asChild>
          <Link to={detailPath(row.id)}>
            <ExternalLink className="h-4 w-4" />
          </Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("reservations:customers")}</h2>

      <DataTable
        columns={columns}
        data={data?.content || []}
        pageInfo={data}
        onPageChange={handlers.onPageChange}
        onPageSizeChange={handlers.onPageSizeChange}
        onSearch={() => {}}
        queries={query.queries}
        onSearchTextChange={handlers.onSearchTextChange}
        onQueriesChange={handlers.onQueriesChange}
        onFilterTypeChange={handlers.onFilterTypeChange}
        isLoading={isLoading}
        onSortChange={handlers.onSortChange}
        currentSortField={query.sortField}
        currentSortOrder={query.sortOrder}
        emptyMessage={t("reservations:no_customers")}
      />
    </div>
  );
}
