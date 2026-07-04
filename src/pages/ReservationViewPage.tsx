// ----------------------------------------------------------------------------
// ReservationViewPage — read-only detail card + snippet panel + bookings list
// inside a 2-tab layout (Details / Bookings). The 3rd tab from the plan
// was collapsed into a "Configuration summary" section inside Details since
// the operator already sees granularity/slot/lead-time/max-advance directly
// in the details card.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft,
  Pencil,
  Trash2,
  Power,
  PowerOff,
  Copy,
  Lock,
} from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import type { ReservationDTO } from "@/types/reservation";
import {
  deleteReservation,
  getReservationById,
  updateReservation,
} from "@/lib/reservations";
import { ReservationSnippetPanel } from "@/components/reservations/ReservationSnippetPanel";
import { ReservationBookingsList } from "@/components/reservations/ReservationBookingsList";

const ReservationViewPage: React.FC = () => {
  const { t } = useTranslation(["reservations", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const reservationId = id ? Number.parseInt(id) : null;

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const { data: reservation, isLoading, error } = useQuery<ReservationDTO, Error>({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReservation(reservation!.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", { item: t("reservations:reservation") }),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      navigate("/reservations");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = reservation?.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateReservation(reservation!.id, {
        status: isActive ? "disabled" : "active",
      }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("reservations:action_disable")
          : t("reservations:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["reservations", reservationId] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const copySecretToken = async () => {
    if (!reservation?.secretToken) return;
    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard?.writeText
      ) {
        await navigator.clipboard.writeText(reservation.secretToken);
        showSuccess(t("reservations:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = reservation.secretToken;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("reservations:secret_token_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
    }
  };

  if (error) {
    showError(t("common:operation_failed", { error: error.message }));
  }
  if (!reservationId)
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  if (isLoading)
    return (
      <div className="text-center p-8">{t("common:loading")}</div>
    );
  if (!reservation)
    return (
      <div className="text-center p-8">
        {t("reservations:reservation_not_found")}
      </div>
    );

  const statusVariant =
    reservation.status === "disabled" ? "destructive" : "default";

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: reservation.id },
    { label: t("reservations:name"), value: reservation.name },
    {
      label: t("reservations:project"),
      value: reservation.projectName || `(#${reservation.projectId})`,
    },
    {
      label: t("reservations:slug"),
      value: <span className="font-mono text-xs">{reservation.slug}</span>,
    },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusVariant}>
          {t(`reservations:status_${reservation.status}`)}
        </Badge>
      ),
    },
    {
      label: t("reservations:granularity"),
      value: (
        <Badge variant="secondary" className="font-mono text-xs">
          {t(`reservations:granularity_${reservation.granularity}`)}
        </Badge>
      ),
    },
    {
      label: t("reservations:slot_duration_minutes"),
      value:
        reservation.slotDurationMinutes === null ||
        reservation.slotDurationMinutes === undefined
          ? "—"
          : (
            <span className="font-mono text-xs">
              {reservation.slotDurationMinutes}
            </span>
          ),
    },
    {
      label: t("reservations:lead_time_minutes"),
      value: (
        <span className="font-mono text-xs">{reservation.leadTimeMinutes}</span>
      ),
    },
    {
      label: t("reservations:max_advance_days"),
      value: (
        <span className="font-mono text-xs">{reservation.maxAdvanceDays}</span>
      ),
    },
    {
      label: t("reservations:extra_fields_enabled"),
      value: reservation.extraFieldsEnabled ? (
        <Badge variant="default">{t("common:active")}</Badge>
      ) : (
        <Badge variant="secondary">{t("common:disabled")}</Badge>
      ),
    },
    {
      label: t("reservations:secret_token"),
      value: (
        <span className="inline-flex items-center gap-2">
          <span className="font-mono text-xs">{reservation.secretToken}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={copySecretToken}
            aria-label={t("reservations:secret_token")}
            title={t("reservations:secret_token_immutable_tooltip")}
          >
            <Copy className="h-4 w-4" />
          </Button>
          <span title={t("reservations:secret_token_immutable_tooltip")}>
            <Lock className="h-3 w-3 text-muted-foreground" />
          </span>
        </span>
      ),
    },
    {
      label: t("reservations:allowed_origins"),
      value:
        reservation.allowedOrigins && reservation.allowedOrigins.length > 0 ? (
          <ul className="list-disc pl-5 space-y-0.5 text-sm font-mono break-all">
            {reservation.allowedOrigins.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        ) : (
          <span className="text-sm text-muted-foreground">
            {t("reservations:allowed_origins_none")}
          </span>
        ),
    },
    {
      label: t("common:created_at"),
      value: new Date(reservation.createdAt).toLocaleString(),
    },
    {
      label: t("common:updated_at"),
      value: new Date(reservation.updatedAt).toLocaleString(),
    },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Tabs defaultValue="details">
        <TabsList>
          <TabsTrigger value="details">
            {t("reservations:details_tab")}
          </TabsTrigger>
          <TabsTrigger value="bookings">
            {t("reservations:bookings_tab")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="space-y-6">
          <Card>
            <CardHeader className="flex flex-col space-y-4 pb-2">
              <CardTitle className="text-2xl font-bold break-words">
                {t("reservations:reservation_details")}: {reservation.name}
              </CardTitle>
              <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
                <Button
                  variant="outline"
                  onClick={() => navigate("/reservations")}
                  className="w-full sm:w-auto"
                >
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  {t("reservations:back_to_reservations")}
                </Button>
                <Button
                  onClick={() => navigate(`/reservations/edit/${reservation.id}`)}
                  className="w-full sm:w-auto"
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  {t("common:edit")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setIsStatusDialogOpen(true)}
                  disabled={statusMutation.isPending}
                  className="w-full sm:w-auto"
                >
                  {isActive ? (
                    <>
                      <PowerOff className="mr-2 h-4 w-4" />
                      {t("reservations:action_disable")}
                    </>
                  ) : (
                    <>
                      <Power className="mr-2 h-4 w-4" />
                      {t("reservations:action_enable")}
                    </>
                  )}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  disabled={deleteMutation.isPending}
                  className="w-full sm:w-auto"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t("common:delete")}
                </Button>
              </div>
            </CardHeader>
            <Separator />
            <CardContent className="pt-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {details.map((item) => (
                  <div key={item.label} className="space-y-1">
                    <p className="text-sm font-medium text-muted-foreground">
                      {item.label}
                    </p>
                    <div className="text-base font-semibold break-words">
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          <ReservationSnippetPanel
            reservationId={reservation.id}
            allowedOrigins={reservation.allowedOrigins}
          />

          {/* Disable / Enable confirmation */}
          <AlertDialog
            open={isStatusDialogOpen}
            onOpenChange={setIsStatusDialogOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {isActive
                    ? t("reservations:disable_confirm_title")
                    : t("reservations:enable_confirm_title")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {isActive
                    ? t("reservations:disable_confirm_description", {
                      name: reservation.name,
                    })
                    : t("reservations:enable_confirm_description", {
                      name: reservation.name,
                    })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={statusMutation.isPending}>
                  {t("common:cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => statusMutation.mutate()}
                  disabled={statusMutation.isPending}
                >
                  {statusMutation.isPending
                    ? t("common:saving")
                    : isActive
                      ? t("reservations:action_disable")
                      : t("reservations:action_enable")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Delete confirmation */}
          <AlertDialog
            open={isDeleteDialogOpen}
            onOpenChange={setIsDeleteDialogOpen}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("reservations:confirm_delete_title")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("reservations:confirm_delete_description", {
                    name: reservation.name,
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteMutation.isPending}>
                  {t("common:cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="bg-destructive hover:bg-destructive/90"
                >
                  {deleteMutation.isPending
                    ? t("common:deleting")
                    : t("common:delete")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TabsContent>

        <TabsContent value="bookings" className="space-y-6">
          <ReservationBookingsList reservationId={reservation.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
};

export default ReservationViewPage;
