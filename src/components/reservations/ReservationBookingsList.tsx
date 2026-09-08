// ----------------------------------------------------------------------------
// ReservationBookingsList — paged DataTable of received reservation bookings.
// Shows service, customer, schedule, status, and worker info. Row
// double-click and the actions menu navigate to the booking view page.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { DataTable } from "@/components/DataTable";
import { Eye, MoreVertical, Trash2 } from "lucide-react";
import {
  getReservationBookings,
  deleteReservationBooking,
  type BookingsQueryParams,
} from "@/lib/reservations";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { showError, showSuccess } from "@/utils/toast";
import type { ReservationBookingDTO } from "@/types/reservation";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";

interface Props {
  reservationId: number;
}

const isSameDay = (a: string, b: string) => {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};

export function ReservationBookingsList({ reservationId }: Props) {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";
  const navigate = useNavigate();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();
  const fmtDate = (iso: string, tz?: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "numeric", day: "numeric", ...(tz ? { timeZone: tz } : {}) });
  const fmtTime = (iso: string, tz?: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false, ...(tz ? { timeZone: tz } : {}) });
  const queryClient = useQueryClient();
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  const bookingPath = (bookingId: number) => {
    const projectId = Number(projectIdParam);
    const moduleId = Number(moduleIdParam);
    if (!projectIdParam || !moduleIdParam || Number.isNaN(projectId) || Number.isNaN(moduleId)) return null;
    return buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "bookings", String(bookingId));
  };

  const openDetails = (id: number) => {
    const path = bookingPath(id);
    if (path) navigate(path);
  };
  const deleteMutation = useMutation({
    mutationFn: (bookingId: number) =>
      deleteReservationBooking(reservationId, bookingId),
    onSuccess: () => {
      showSuccess(t("reservations:booking_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      setDeleteTargetId(null);
    },
    onError: (err: Error) => {
      showError(err.message || t("reservations:booking_delete_failed"));
    },
  });

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "bookedAt",
    defaultSortOrder: "desc",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["reservation-bookings", reservationId, query],
    queryFn: () =>
      getReservationBookings(reservationId, {
        ...query,
        sortField: query.sortField as BookingsQueryParams["sortField"],
      }),
  });

  const columns = [
    {
      accessorKey: "serviceName",
      header: t("reservations:booking_service"),
      cell: (row: ReservationBookingDTO) =>
        row.serviceName || row.serviceNameSnapshot || "—",
      enableSorting: true,
    },
    {
      accessorKey: "customerName",
      header: t("reservations:booking_customer"),
      cell: (row: ReservationBookingDTO) => {
        const name = row.customerName || [row.lastName, row.firstName].filter(Boolean).join(" ");
        return name || "—";
      },
      enableSorting: true,
    },
    {
      accessorKey: "startsAt",
      header: t("reservations:booking_reservation"),
      cell: (row: ReservationBookingDTO) => isSameDay(row.startsAt, row.endsAt)
        ? <>{fmtDate(row.startsAt, row.timezone)} <span className="font-semibold">{fmtTime(row.startsAt, row.timezone)} – {fmtTime(row.endsAt, row.timezone)}</span></>
        : <>{fmtDate(row.startsAt, row.timezone)} {fmtTime(row.startsAt, row.timezone)} – {fmtDate(row.endsAt, row.timezone)} {fmtTime(row.endsAt, row.timezone)}</>,
      enableSorting: true,
    },
    {
      accessorKey: "workerFirstName",
      header: t("reservations:booking_worker"),
      cell: (row: ReservationBookingDTO) => {
        const name = [row.workerLastName, row.workerFirstName].filter(Boolean).join(" ");
        return name || "—";
      },
      enableSorting: true,
    },
    {
      accessorKey: "status",
      header: t("reservations:booking_status"),
      cell: (row: ReservationBookingDTO) => (
        <div>
          <Badge variant={row.status === "confirmed" || row.status === "attended" ? "default" : row.status === "cancelled" ? "destructive" : row.status === "no_show" ? "outline" : "secondary"}>
            {t(`reservations:booking_status_${row.status}`)}
          </Badge>
          {row.status === "cancelled" && row.cancellationReason && (
            <p className="text-xs text-muted-foreground mt-1 max-w-[200px] truncate" title={row.cancellationReason}>
              {row.cancellationReason}
            </p>
          )}
        </div>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ReservationBookingDTO) => (
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
            <DropdownMenuItem onSelect={() => openDetails(row.id)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => setDeleteTargetId(row.id)}
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
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("reservations:bookings_section")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data as never}
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={() => {}}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onSearchTextChange={handlers.onSearchTextChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField}
            currentSortOrder={query.sortOrder}
            onRowDoubleClick={(row: ReservationBookingDTO) => openDetails(row.id)}
            emptyMessage={t("reservations:no_bookings_yet")}
          />
        </CardContent>
      </Card>

      <AlertDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("reservations:booking_delete_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("reservations:booking_delete_description")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteTargetId !== null) {
                  deleteMutation.mutate(deleteTargetId);
                }
              }}
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending
                ? t("reservations:booking_deleting")
                : t("reservations:booking_delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
