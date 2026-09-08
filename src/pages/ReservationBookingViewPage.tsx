// ----------------------------------------------------------------------------
// ReservationBookingViewPage — full-page booking detail, reached from the
// bookings list (row double-click or actions menu). Shows service, customer,
// schedule, status, and cancellation info with Back + Delete actions.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useModuleResolution } from "@/hooks/useModuleResolution";
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
import { ArrowLeft, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  deleteReservationBooking,
  getReservationBookingById,
} from "@/lib/reservations";
import { buildWorkspaceModulePath } from "@/lib/workspace-navigation";
import type { ReservationBookingDTO } from "@/types/reservation";

const isSameDay = (a: string, b: string) => {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
};

export default function ReservationBookingViewPage() {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resourceId: reservationId } = useModuleResolution();
  const {
    bookingId: bookingIdParam,
    projectId: projectIdParam,
    moduleId: moduleIdParam,
  } = useParams<{
    bookingId: string;
    projectId: string;
    moduleId: string;
  }>();
  const bookingId = parseInt(bookingIdParam || "0", 10);

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  const fmtDate = (iso: string, tz?: string | null) =>
    new Date(iso).toLocaleDateString(locale, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      ...(tz ? { timeZone: tz } : {}),
    });
  const fmtTime = (iso: string, tz?: string | null) =>
    new Date(iso).toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(tz ? { timeZone: tz } : {}),
    });
  const fmtDateTime = (iso: string, tz?: string | null) =>
    new Date(iso).toLocaleString(locale, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(tz ? { timeZone: tz } : {}),
    });

  const bookingsPath =
    projectIdParam && moduleIdParam
      ? buildWorkspaceModulePath(
          Number(projectIdParam),
          "reservation",
          Number(moduleIdParam),
          "bookings",
        )
      : null;

  const backToList = () => {
    if (bookingsPath) navigate(bookingsPath);
    else navigate(-1);
  };

  const { data: booking, isLoading } = useQuery<ReservationBookingDTO, Error>({
    queryKey: ["reservation-booking", reservationId, bookingId],
    queryFn: () => getReservationBookingById(reservationId!, bookingId),
    enabled: !!reservationId && bookingId > 0,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReservationBooking(reservationId!, bookingId),
    onSuccess: () => {
      showSuccess(t("reservations:booking_deleted"));
      queryClient.invalidateQueries({
        queryKey: ["reservation-bookings", reservationId],
      });
      backToList();
    },
    onError: (err: Error) => {
      showError(err.message || t("reservations:booking_delete_failed"));
    },
  });

  if (isLoading)
    return <p className="text-muted-foreground">{t("common:loading")}</p>;
  if (!booking) return <p>{t("reservations:booking_not_found")}</p>;

  const customerName =
    booking.customerName ||
    [booking.lastName, booking.firstName].filter(Boolean).join(" ");
  const workerName = [booking.workerFirstName, booking.workerLastName]
    .filter(Boolean)
    .join(" ");
  const customerPath =
    projectIdParam && moduleIdParam && booking.customerId
      ? `/workspace/projects/${projectIdParam}/modules/reservation/${moduleIdParam}/customers/${booking.customerId}`
      : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <Button variant="ghost" size="sm" onClick={backToList}>
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("reservations:back_to_bookings")}
          </Button>
          <h2 className="text-lg font-semibold break-words">
            {t("reservations:booking_details")}
          </h2>
          <Badge
            variant={
              booking.status === "confirmed" || booking.status === "attended"
                ? "default"
                : booking.status === "cancelled"
                  ? "destructive"
                  : booking.status === "no_show"
                    ? "outline"
                    : "secondary"
            }
          >
            {t(`reservations:booking_status_${booking.status}`)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setIsDeleteDialogOpen(true)}
            disabled={deleteMutation.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete")}
          </Button>
        </div>
      </div>

      {(booking.serviceName || booking.serviceNameSnapshot) && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-base">
              {t("reservations:booking_service")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-base font-semibold break-words">
              {booking.serviceName || booking.serviceNameSnapshot}
            </p>
            {workerName && (
              <p className="text-sm text-muted-foreground">
                {t("reservations:booking_worker")}: {workerName}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {(customerName || booking.email || booking.phone) && (
        <Card className="w-full">
          <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {t("reservations:booking_customer")}
            </CardTitle>
            {customerPath && (
              <Button variant="outline" size="sm" asChild>
                <Link to={customerPath}>{t("common:view")}</Link>
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-1">
            {customerName && (
              <p className="text-base font-semibold break-words">
                {customerName}
              </p>
            )}
            {booking.email && (
              <p className="text-sm text-muted-foreground break-words">
                {booking.email}
              </p>
            )}
            {booking.phone && (
              <p className="text-sm text-muted-foreground">{booking.phone}</p>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-base">
            {t("reservations:booking_reservation")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div>
            {isSameDay(booking.startsAt, booking.endsAt) ? (
              <>
                {fmtDate(booking.startsAt, booking.timezone)}{" "}
                <span className="font-semibold text-foreground text-base">
                  {fmtTime(booking.startsAt, booking.timezone)} –{" "}
                  {fmtTime(booking.endsAt, booking.timezone)}
                </span>
              </>
            ) : (
              <>
                {fmtDate(booking.startsAt, booking.timezone)}{" "}
                <span className="font-semibold text-foreground text-base">
                  {fmtTime(booking.startsAt, booking.timezone)}
                </span>{" "}
                – {fmtDate(booking.endsAt, booking.timezone)}{" "}
                <span className="font-semibold text-foreground text-base">
                  {fmtTime(booking.endsAt, booking.timezone)}
                </span>
              </>
            )}
          </div>
          <div className="text-muted-foreground">
            {t("reservations:booking_booked_at")}:{" "}
            {fmtDateTime(booking.bookedAt, booking.timezone)}
          </div>
        </CardContent>
      </Card>

      {booking.comment && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-base">
              {t("reservations:comment")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm break-words">{booking.comment}</p>
          </CardContent>
        </Card>
      )}

      {booking.status === "cancelled" && booking.cancellationReason && (
        <Card className="w-full border-destructive/20 bg-destructive/5">
          <CardHeader>
            <CardTitle className="text-base text-destructive">
              {t("reservations:cancellation_reason")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm break-words">{booking.cancellationReason}</p>
          </CardContent>
        </Card>
      )}

      <AlertDialog
        open={isDeleteDialogOpen}
        onOpenChange={setIsDeleteDialogOpen}
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
              onClick={() => deleteMutation.mutate()}
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
    </div>
  );
}
