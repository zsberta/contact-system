// ReservationServicesPage — list of services for a reservation.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Plus, Pencil, Trash2, CalendarClock, MoreVertical } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { getReservationServices, deleteReservationService } from "@/lib/reservations";
import { useAuth } from "@/context/AuthContext";
export default function ReservationServicesPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();
  const { user } = useAuth();
  const projectId = Number(projectIdParam);
  const moduleId = Number(moduleIdParam);
  const queryClient = useQueryClient();
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);

  const { data: services, isLoading } = useQuery({
    queryKey: ["reservation-services", reservationId],
    queryFn: () => getReservationServices(reservationId),
    enabled: reservationId > 0,
  });

  const deleteMutation = useMutation({
    mutationFn: (serviceId: number) => deleteReservationService(reservationId, serviceId),
    onSuccess: () => {
      showSuccess(t("reservations:service_deleted"));
      queryClient.invalidateQueries({ queryKey: ["reservation-services", reservationId] });
      setDeleteTargetId(null);
    },
    onError: (err: Error) => showError(err.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold break-words">{t("reservations:services")}</h2>
        <Button asChild size="sm">
          <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "services", "create")}>
            <Plus className="mr-2 h-4 w-4" />{t("reservations:add_service")}
          </Link>
        </Button>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common:loading")}</p>}

      {services?.map((s) => (
        <Card key={s.id}>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {s.imageUrl && (
                <img
                  src={s.imageUrl}
                  alt={s.name || ""}
                  className="h-12 w-12 rounded object-cover shrink-0"
                />
              )}
              <div className="space-y-1">
              <div className="font-medium">{s.name || t("reservations:untitled_service")}</div>
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                <Badge variant={s.status === "active" ? "default" : "secondary"}>
                  {t(`reservations:${s.status}`)}
                </Badge>
                <span>{s.durationMinutes} {t("common:min", { defaultValue: "perc" })}</span>
                <span className="text-border">·</span>
                <span>{s.priceAmount} {s.currency === "HUF" ? "Ft" : s.currency}</span>
                <span className="text-border">·</span>
                <span>{s.capacity} {t("reservations:capacity").toLowerCase()}</span>
                {s.workerFirstName && (
                  <>
                    <span className="text-border">·</span>
                    <span>{s.workerLastName} {s.workerFirstName}</span>
                  </>
                )}
              </div>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-8 w-8 shrink-0 self-start p-0">
                  <span className="sr-only">{t("common:actions")}</span>
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
                <DropdownMenuItem asChild>
                  <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "services", `edit/${s.id}`)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("common:edit")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "services", `${s.id}/schedules`)}>
                    <CalendarClock className="mr-2 h-4 w-4" />
                    {t("reservations:schedules_tab")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => setDeleteTargetId(s.id)}
                  className="text-red-600 focus:text-red-600"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("common:delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardContent>
        </Card>
      ))}

      {services?.length === 0 && !isLoading && (
        <p className="text-center text-muted-foreground py-8">{t("reservations:no_services")}</p>
      )}

      <AlertDialog open={deleteTargetId !== null} onOpenChange={(open) => { if (!open) setDeleteTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reservations:confirm_delete_service_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reservations:confirm_delete_service")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTargetId !== null) deleteMutation.mutate(deleteTargetId); }}
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
