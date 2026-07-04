// ----------------------------------------------------------------------------
// ProjectReservations — a card on the project view page that lists all
// reservations belonging to a given project. Click → /reservations/:id.
// Empty state offers a "Create reservation" button that deep-links to
// /reservations/create?projectId=:id. Mirrors ProjectForms.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarClock, PlusCircle } from "lucide-react";
import { getAllReservationsPaged } from "@/lib/reservations";
import type { ReservationStatus } from "@/types/reservation";

interface ProjectReservationsProps {
  projectId: number;
}

const statusBadgeVariant = (status: ReservationStatus) => {
  return status === "disabled" ? ("destructive" as const) : ("default" as const);
};

export function ProjectReservations({ projectId }: ProjectReservationsProps) {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["reservations", "project", projectId],
    queryFn: () =>
      getAllReservationsPaged({
        projectId,
        page: 0,
        size: 100,
        sortField: "createdAt",
        sortOrder: "desc",
      }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <CalendarClock className="h-5 w-5" />
          {t("reservations:project_section_reservations_title")}
        </CardTitle>
        <Button
          size="sm"
          onClick={() =>
            navigate(`/reservations/create?projectId=${projectId}`)
          }
        >
          <PlusCircle className="mr-2 h-4 w-4" />
          {t("reservations:project_section_create_reservation")}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data || data.content.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("reservations:project_section_reservations_empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {data.content.map((reservation) => (
              <li
                key={reservation.id}
                className="flex items-center justify-between p-3 border rounded-md cursor-pointer hover:bg-muted/50"
                onClick={() => navigate(`/reservations/view/${reservation.id}`)}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <CalendarClock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{reservation.name}</p>
                    <p className="text-xs font-mono text-muted-foreground truncate">
                      {reservation.slug}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {reservation.granularity}
                  </Badge>
                  <Badge variant={statusBadgeVariant(reservation.status)}>
                    {t(`reservations:status_${reservation.status}`)}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectReservations;
