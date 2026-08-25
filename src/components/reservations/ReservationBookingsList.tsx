// ----------------------------------------------------------------------------
// ReservationBookingsList — paged DataTable of received reservation bookings.
// Shows service, customer, schedule, status, and worker info. Opens a
// centered Dialog on the "View details" action.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { DataTable } from "@/components/DataTable";
import { Eye, Trash2 } from "lucide-react";
import { getReservationBookings, deleteReservationBooking } from "@/lib/reservations";
import { showError, showSuccess } from "@/utils/toast";
import type { ReservationBookingDTO } from "@/types/reservation";
import { ReservationBookingDetailModal } from "@/components/reservations/ReservationBookingDetailModal";

interface Props {
  reservationId: number;
}

interface QueryState {
  page: number;
  size: number;
  sortField: "startsAt" | "endsAt" | "bookedAt" | "serviceName" | "customerName" | "workerFirstName" | "status";
  sortOrder: "asc" | "desc";
  queries: string[];
  searchText: string;
  filterType: "any" | "all";
}

const isSameDay = (a: string, b: string) => {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
};

export function ReservationBookingsList({ reservationId }: Props) {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "numeric", day: "numeric" });
  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const queryClient = useQueryClient();
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

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

  const [queryState, setQueryState] = useState<QueryState>({
    page: 0,
    size: 10,
    sortField: "bookedAt",
    sortOrder: "desc",
    queries: [],
    searchText: "",
    filterType: "any",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["reservation-bookings", reservationId, queryState],
    queryFn: () => getReservationBookings(reservationId, queryState),
  });

  const handlePageChange = useCallback(
    (page: number) => setQueryState((s) => ({ ...s, page })),
    [],
  );
  const handlePageSizeChange = useCallback(
    (size: number) => setQueryState((s) => ({ ...s, size, page: 0 })),
    [],
  );
  const handleSearchTextChange = useCallback(
    (searchText: string) =>
      setQueryState((s) => ({ ...s, searchText, page: 0 })),
    [],
  );
  const handleQueriesChange = useCallback(
    (queries: string[]) => setQueryState((s) => ({ ...s, queries, page: 0 })),
    [],
  );
  const handleFilterTypeChange = useCallback(
    (filterType: "any" | "all") =>
      setQueryState((s) => ({ ...s, filterType, page: 0 })),
    [],
  );
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryState((s) => ({
        ...s,
        sortField: sortField as QueryState["sortField"],
        sortOrder,
        page: 0,
      })),
    [],
  );

  const openDetails = (id: number) => {
    setSelectedBookingId(id);
    setDialogOpen(true);
  };

  const handleRowDoubleClick = (row: ReservationBookingDTO) =>
    openDetails(row.id);

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
        ? <>{fmtDate(row.startsAt)} <span className="font-semibold">{fmtTime(row.startsAt)} – {fmtTime(row.endsAt)}</span></>
        : <>{fmtDate(row.startsAt)} {fmtTime(row.startsAt)} – {fmtDate(row.endsAt)} {fmtTime(row.endsAt)}</>,
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
        <Badge variant={row.status === "confirmed" ? "default" : row.status === "cancelled" ? "destructive" : row.status === "no_show" ? "outline" : "secondary"}>
          {t(`reservations:booking_status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ReservationBookingDTO) => (
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => openDetails(row.id)}
            aria-label={t("reservations:booking_details")}
            title={t("reservations:booking_details")}
          >
            <Eye className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteTargetId(row.id);
            }}
            aria-label={t("reservations:booking_delete")}
            title={t("reservations:booking_delete")}
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
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
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={() => {}}
            queries={queryState.queries}
            filterType={queryState.filterType}
            onQueriesChange={handleQueriesChange}
            onSearchTextChange={handleSearchTextChange}
            onFilterTypeChange={handleFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handleSortChange}
            currentSortField={queryState.sortField}
            currentSortOrder={queryState.sortOrder}
            onRowDoubleClick={handleRowDoubleClick}
            emptyMessage={t("reservations:no_bookings_yet")}
          />
        </CardContent>
      </Card>

      <ReservationBookingDetailModal
        reservationId={reservationId}
        bookingId={selectedBookingId}
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setSelectedBookingId(null);
        }}
      />

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
