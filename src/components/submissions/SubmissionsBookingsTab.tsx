// SubmissionsBookingsTab — paged DataTable of reservation bookings across
// all projects the user can access. Opens SubmissionDetailModal on click.
// Enduser view: Name, Phone, Start, Booked, triple-dot actions.

import { useState } from "react";
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
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import {
  SubmissionDetailModal,
  type SubmissionDetailData,
} from "@/components/submissions/SubmissionDetailModal";

interface Props {
  projectId?: number;
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

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "bookedAt",
    defaultSortOrder: "desc",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["submission-bookings", projectId, query],
    queryFn: () => getSubmissionBookings({ ...query, projectId }),
  });

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
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={(search) => handlers.onQueriesChange(search ? [search] : [])}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField}
            currentSortOrder={query.sortOrder}
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
