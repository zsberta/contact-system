// ----------------------------------------------------------------------------
// ReservationActions — row-level dropdown menu for the Reservation list page
// (view/edit/disable-enable/delete). Mirrors FormActions structurally.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MoreVertical, Eye, Edit, Trash2, Power, PowerOff } from "lucide-react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
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
import type { ReservationDTO } from "@/types/reservation";
import { deleteReservation, updateReservation } from "@/lib/reservations";
import { showError, showSuccess } from "@/utils/toast";

interface ReservationActionsProps {
  reservation: ReservationDTO;
}

const ReservationActions = ({ reservation }: ReservationActionsProps) => {
  const { t } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isStatusDialogOpen, setIsStatusDialogOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: () => deleteReservation(reservation.id),
    onSuccess: () => {
      showSuccess(
        t("common:delete_success", { item: t("reservations:reservation") }),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const isActive = reservation.status === "active";
  const statusMutation = useMutation({
    mutationFn: () =>
      updateReservation(reservation.id, {
        status: isActive ? "disabled" : "active",
      }),
    onSuccess: () => {
      showSuccess(
        isActive
          ? t("reservations:action_disable")
          : t("reservations:action_enable"),
      );
      queryClient.invalidateQueries({ queryKey: ["reservations"] });
      queryClient.invalidateQueries({ queryKey: ["reservations", reservation.id] });
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleConfirmDelete = async () => {
    await deleteMutation.mutateAsync();
    setIsDeleteDialogOpen(false);
  };

  const handleConfirmStatusChange = async () => {
    await statusMutation.mutateAsync();
    setIsStatusDialogOpen(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-8 p-0"
            disabled={deleteMutation.isPending || statusMutation.isPending}
          >
            <span className="sr-only">{t("common:actions")}</span>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
          <DropdownMenuItem asChild>
            <Link to={`/reservations/view/${reservation.id}`}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={`/reservations/edit/${reservation.id}`}>
              <Edit className="mr-2 h-4 w-4" />
              {t("common:edit")}
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setIsStatusDialogOpen(true)}>
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
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setIsDeleteDialogOpen(true)}
            className="text-red-600 focus:text-red-600"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t("common:delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

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
              onClick={handleConfirmStatusChange}
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
              onClick={handleConfirmDelete}
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
    </>
  );
};

export default ReservationActions;
