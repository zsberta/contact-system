// ----------------------------------------------------------------------------
// ReservationsPage — paged list of reservations. Mirrors FormsPage
// structurally: DataTable with name / slug / project / granularity /
// lead-time / status / createdAt columns, a "Create reservation" button,
// and row-level actions. Supports `?projectId=N` deep-link filtering.
// ----------------------------------------------------------------------------

import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { resolveModulePath } from "@/lib/workspace-navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import {
  getAllReservationsPaged,
  PageReservationDTO,
  GetAllReservationsParams,
} from "@/lib/reservations";
import { ReservationDTO, ReservationStatus } from "@/types/reservation";
import ReservationActions from "@/components/reservations/ReservationActions";

const statusBadgeVariant = (status: ReservationStatus) => {
  return status === "disabled" ? ("destructive" as const) : ("default" as const);
};

const ReservationsPage: React.FC = () => {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam)
      ? Number(projectIdParam)
      : undefined;

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
  });

  const fetchParams: GetAllReservationsParams = {
    ...query,
    ...(projectIdFilter !== undefined ? { projectId: projectIdFilter } : {}),
  };

  const { data, isLoading } = useQuery<PageReservationDTO, Error>({
    queryKey: ["reservations", query, projectIdFilter],
    queryFn: () => getAllReservationsPaged(fetchParams),
  });

  const handleSearch = useCallback(
    (query: string) => handlers.onQueriesChange(query ? [query] : []),
    [handlers],
  );
  const handleRowDoubleClick = useCallback(
    async (row: ReservationDTO) => {
      const path = await resolveModulePath(row.projectId, "reservation");
      if (path) navigate(path);
    },
    [navigate],
  );

  const createLink =
    projectIdFilter !== undefined
      ? `/reservations/create?projectId=${projectIdFilter}`
      : "/reservations/create";

  const columns = [
    {
      accessorKey: "name",
      header: t("reservations:name"),
      cell: (row: ReservationDTO) => row.name || "—",
      enableSorting: true,
    },

    {
      accessorKey: "projectName",
      header: t("reservations:project"),
      cell: (row: ReservationDTO) => row.projectName || "—",
      enableSorting: false,
    },
    {
      accessorKey: "granularity",
      header: t("reservations:granularity"),
      cell: (row: ReservationDTO) => (
        <Badge variant="secondary" className="font-mono text-xs">
          {t(`reservations:granularity_${row.granularity}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "leadTimeMinutes",
      header: t("reservations:lead_time_minutes_short"),
      cell: (row: ReservationDTO) => (
        <span className="font-mono text-xs">{row.leadTimeMinutes}m</span>
      ),
      enableSorting: false,
    },
    {
      accessorKey: "status",
      header: t("common:status"),
      cell: (row: ReservationDTO) => (
        <Badge variant={statusBadgeVariant(row.status)}>
          {t(`reservations:status_${row.status}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: ReservationDTO) => new Date(row.createdAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: ReservationDTO) => <ReservationActions reservation={row} />,
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("reservations:reservation_management")}
          </CardTitle>
          <div className="flex justify-start">
            <Link to={createLink}>
              <Button className="w-full sm:w-auto">
                <PlusCircle className="mr-2 h-4 w-4" />
                {t("reservations:create_reservation")}
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data}
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={handleSearch}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField}
            currentSortOrder={query.sortOrder}
            onRowDoubleClick={handleRowDoubleClick}
            emptyMessage={t("reservations:project_section_reservations_empty")}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default ReservationsPage;
