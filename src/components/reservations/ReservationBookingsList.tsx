// ----------------------------------------------------------------------------
// ReservationBookingsList — paged DataTable of received reservation bookings.
// Bookings have a structured date/time window + an optional JSONB data bag
// (only when the reservation has extra_fields_enabled). Opens the details
// sheet on the "View details" action.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Eye } from "lucide-react";
import { getReservationBookings } from "@/lib/reservations";
import type { ReservationBookingDTO } from "@/types/reservation";
import { ReservationBookingDetailsSheet } from "@/components/reservations/ReservationBookingDetailsSheet";

interface Props {
  reservationId: number;
}

interface QueryState {
  page: number;
  size: number;
  sortField: "startsAt" | "endsAt" | "bookedAt" | "ipAddress" | "locale";
  sortOrder: "asc" | "desc";
  queries: string[];
  filterType: "any" | "all";
}

const maskIpv4 = (ip: string | null): string => {
  if (!ip) return "—";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  return ip;
};

export function ReservationBookingsList({ reservationId }: Props) {
  const { t } = useTranslation(["reservations", "common"]);
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [queryState, setQueryState] = useState<QueryState>({
    page: 0,
    size: 10,
    sortField: "bookedAt",
    sortOrder: "desc",
    queries: [],
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
  const handleSearch = useCallback(
    (query: string) =>
      setQueryState((s) => ({
        ...s,
        queries: query ? [query] : [],
        page: 0,
      })),
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
    setSheetOpen(true);
  };

  const handleRowDoubleClick = (row: ReservationBookingDTO) =>
    openDetails(row.id);

  const columns = [
    {
      accessorKey: "startsAt",
      header: t("reservations:booking_starts_at"),
      cell: (row: ReservationBookingDTO) =>
        new Date(row.startsAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "endsAt",
      header: t("reservations:booking_ends_at"),
      cell: (row: ReservationBookingDTO) =>
        new Date(row.endsAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "locale",
      header: t("reservations:submission_locale"),
      cell: (row: ReservationBookingDTO) => row.locale ?? "—",
      enableSorting: true,
    },
    {
      accessorKey: "ipAddress",
      header: t("reservations:submission_ip"),
      cell: (row: ReservationBookingDTO) => maskIpv4(row.ipAddress),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ReservationBookingDTO) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openDetails(row.id)}
          aria-label={t("reservations:submission_view_json")}
          title={t("reservations:submission_view_json")}
        >
          <Eye className="mr-1 h-4 w-4" />
          {t("reservations:submission_view_json")}
        </Button>
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
            onSearch={handleSearch}
            queries={queryState.queries}
            filterType={queryState.filterType}
            onQueriesChange={handleQueriesChange}
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

      <ReservationBookingDetailsSheet
        reservationId={reservationId}
        bookingId={selectedBookingId}
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setSelectedBookingId(null);
        }}
      />
    </>
  );
}
