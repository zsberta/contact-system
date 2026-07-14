// SubmissionsBookingsTab — paged DataTable of reservation bookings across
// all projects the user can access. Opens SubmissionDetailModal on click.
// Enduser view: Name, Phone, Start, Booked, triple-dot actions.

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/DataTable";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, Eye } from "lucide-react";
import { getSubmissionBookings } from "@/lib/submissions";
import type { SubmissionBookingDTO } from "@/types/submissions";
import {
  SubmissionDetailModal,
  type SubmissionDetailData,
} from "@/components/submissions/SubmissionDetailModal";

interface Props {
  projectId?: number;
}

interface QueryState {
  page: number;
  size: number;
  sortField: "startsAt" | "endsAt" | "bookedAt";
  sortOrder: "asc" | "desc";
  queries: string[];
  filterType: "any" | "all";
}

function extractFromData(
  data: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!data) return null;
  for (const key of keys) {
    const val = data[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

export default function SubmissionsBookingsTab({ projectId }: Props) {
  const { t } = useTranslation(["submissions", "common"]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSubmission, setSelectedSubmission] =
    useState<SubmissionDetailData | null>(null);
  const [modalTitle, setModalTitle] = useState("");

  const [queryState, setQueryState] = useState<QueryState>({
    page: 0,
    size: 10,
    sortField: "bookedAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["submission-bookings", projectId, queryState],
    queryFn: () => getSubmissionBookings({ ...queryState, projectId }),
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

  const openDetails = (row: SubmissionBookingDTO) => {
    setSelectedSubmission({
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      bookedAt: row.bookedAt,
      data: row.data,
    });
    setModalTitle(`${row.reservationName} \u2014 ${row.projectName}`);
    setModalOpen(true);
  };

  const columns = [
    {
      accessorKey: "name",
      header: t("common:name"),
      cell: (row: SubmissionBookingDTO) => {
        const name = extractFromData(row.data, ["name", "fullname", "yourname"]);
        return <span className="font-medium truncate">{name || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "email",
      header: t("common:email"),
      cell: (row: SubmissionBookingDTO) => {
        const email = extractFromData(row.data, ["email", "mail", "emailaddress"]);
        return <span className="truncate">{email || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "phone",
      header: t("common:phone_number"),
      cell: (row: SubmissionBookingDTO) => {
        const phone = extractFromData(row.data, [
          "phone",
          "tel",
          "telefon",
          "phonenumber",
        ]);
        return <span className="truncate">{phone || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "startsAt",
      header: t("submissions:starts_at"),
      cell: (row: SubmissionBookingDTO) =>
        new Date(row.startsAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "bookedAt",
      header: t("submissions:booked_at"),
      cell: (row: SubmissionBookingDTO) =>
        new Date(row.bookedAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: SubmissionBookingDTO) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">{t("common:actions")}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openDetails(row)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <Card>
        <CardContent className="pt-6">
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
            onRowDoubleClick={(row) => openDetails(row)}
            emptyMessage={t("submissions:no_bookings")}
          />
        </CardContent>
      </Card>

      <SubmissionDetailModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedSubmission(null);
        }}
        title={modalTitle}
        submission={selectedSubmission}
      />
    </>
  );
}
