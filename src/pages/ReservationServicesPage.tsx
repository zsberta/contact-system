// ReservationServicesPage — list of services for a reservation.
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, ExternalLink } from "lucide-react";
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
    },
    onError: (err: Error) => showError(err.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("reservations:services")}</h2>
        <Button asChild size="sm">
          <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "services", "create")}>
            <Plus className="mr-2 h-4 w-4" />{t("reservations:add_service")}
          </Link>
        </Button>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common:loading")}</p>}

      {services?.map((s) => (
        <Card key={s.id}>
          <CardContent className="flex items-center justify-between p-4">
            <div className="flex items-start gap-3">
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
            <div className="flex gap-1">
              <Button variant="ghost" size="icon" asChild>
                <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "services", `edit/${s.id}`)}>
                  <Pencil className="h-4 w-4" />
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (confirm(t("reservations:confirm_delete_service"))) {
                    deleteMutation.mutate(s.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}

      {services?.length === 0 && !isLoading && (
        <p className="text-center text-muted-foreground py-8">{t("reservations:no_services")}</p>
      )}
    </div>
  );
}
