// ----------------------------------------------------------------------------
// ReservationCustomersPage — project-scoped, paged DataTable of customers.
// Shows name, email, and phone. Row double-click and the actions menu open
// the customer view page; deletion uses a confirmation dialog.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Eye, MoreVertical, Trash2 } from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { deleteReservationCustomer, getReservationCustomers } from "@/lib/reservations";
import { showError, showSuccess } from "@/utils/toast";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import type { ReservationCustomerDTO } from "@/types/reservation";

export default function ReservationCustomersPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();

  const projectId = projectIdParam ? Number(projectIdParam) : undefined;
  const [deleteTarget, setDeleteTarget] = useState<ReservationCustomerDTO | null>(null);

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

  const deleteMutation = useMutation({
    mutationFn: (customerId: number) => deleteReservationCustomer(customerId),
    onSuccess: () => {
      showSuccess(t("reservations:customer_deleted"));
      queryClient.invalidateQueries({ queryKey: ["reservation-customers"] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => showError(err.message),
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-8 w-8 p-0"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="sr-only">{t("common:actions")}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => navigate(detailPath(row.id))}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDeleteTarget(row)}
              className="text-red-600 focus:text-red-600"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              {t("common:delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold break-words">{t("reservations:customers")}</h2>
      </div>

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
        onRowDoubleClick={(row: ReservationCustomerDTO) => navigate(detailPath(row.id))}
        emptyMessage={t("reservations:no_customers")}
      />

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reservations:delete_customer_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reservations:delete_customer_confirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t("common:deleting") : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
