// ----------------------------------------------------------------------------
// ReservationDisabledRangesPage — simple list of custom disabled ranges.
// Holiday rules are managed on the create/edit page, not here.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
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
import { Loader2, Plus, Trash2, Ban } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import { getDisableSettings, deleteDisabledRange } from "@/lib/reservations";
import type { ReservationDisabledRangeDTO } from "@/types/reservation";

export default function ReservationDisabledRangesPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();
  const projectId = Number(projectIdParam);
  const moduleId = Number(moduleIdParam);
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["reservation-disable-settings", reservationId],
    queryFn: () => getDisableSettings(reservationId!),
    enabled: !!reservationId,
  });

  const services = settings?.services ?? [];
  const manualRanges = settings?.disabledRanges ?? [];

  const [deleteTarget, setDeleteTarget] = useState<ReservationDisabledRangeDTO | null>(null);

  const deleteMutation = useMutation({
    mutationFn: () => deleteDisabledRange(reservationId!, deleteTarget!.id),
    onSuccess: () => {
      showSuccess(t("reservations:disabled_range_deleted"));
      queryClient.invalidateQueries({ queryKey: ["reservation-disable-settings", reservationId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => showError(err.message),
  });

  const locale = navigator.language || "en";

  const formatRange = (range: ReservationDisabledRangeDTO) => {
    const start = new Date(range.startsAt);
    const end = new Date(range.endsAt);
    const startLocal = start.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const endLocal = end.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
    const isFullDayStart = startLocal === "00:00";
    const isFullDayEnd = endLocal === "23:59" || endLocal === "00:00";
    const sameDay = start.toDateString() === end.toDateString();
    const dateStr = start.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
    const endDateStr = end.toLocaleDateString(locale, { year: "numeric", month: "2-digit", day: "2-digit" });
    if (isFullDayStart && isFullDayEnd) return `${dateStr} – ${endDateStr}`;
    if (sameDay) return `${dateStr} ${isFullDayStart ? "00:00" : startLocal} – ${isFullDayEnd ? "23:59" : endLocal}`;
    return `${dateStr} ${isFullDayStart ? "" : startLocal} – ${endDateStr} ${isFullDayEnd ? "" : endLocal}`;
  };

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6 w-full">
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t("reservations:disabled_ranges_section")}</h2>
        <Button asChild size="sm">
          <Link to={buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "blocked", "new")}>
            <Plus className="mr-1 h-4 w-4" />
            {t("reservations:disabled_range_add")}
          </Link>
        </Button>
      </div>

      {manualRanges.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Ban className="h-10 w-10 mx-auto mb-3" />
          <p className="text-sm">{t("reservations:no_disabled_ranges")}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {manualRanges.map((range) => (
            <div
              key={range.id}
              className="flex items-center justify-between gap-3 p-3 border rounded-md hover:bg-accent/30 transition-colors"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Ban className="h-4 w-4 text-destructive shrink-0" />
                  <span className="text-sm font-medium truncate">{formatRange(range)}</span>
                </div>
                {range.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5 ml-6 truncate">{range.reason}</p>
                )}
                {range.serviceIds.length > 0 && (
                  <p className="text-xs text-muted-foreground mt-0.5 ml-6">
                    {range.serviceIds.map((id) => services.find((s) => s.id === id)?.name ?? `#${id}`).join(", ")}
                  </p>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteTarget(range)}
                aria-label={t("reservations:disabled_range_delete")}
                title={t("reservations:disabled_range_delete")}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reservations:disabled_range_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reservations:disabled_range_delete_description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              className="bg-destructive hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? t("common:deleting") : t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
