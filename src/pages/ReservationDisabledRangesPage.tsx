// ----------------------------------------------------------------------------
// ReservationDisabledRangesPage — simple list of custom disabled ranges.
// Holiday rules are managed on the create/edit page, not here.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Loader2, Plus, Trash2, Ban, MoreVertical, Pencil } from "lucide-react";
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
  const navigate = useNavigate();
  const editPath = (rangeId: number) =>
    buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "blocked", `edit/${rangeId}`);
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

  // Forced Hungarian date/time display — the app is Hungarian-only
  // (i18n pins `hu`), so rendered dates never follow the browser locale.
  const locale = "hu";
  const dateOpts = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
  const timeOpts = { hour: "2-digit", minute: "2-digit", hour12: false } as const;

  const isMidnight = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0;
  const isEndOfDay = (d: Date) => (d.getHours() === 23 && d.getMinutes() === 59) || isMidnight(d);

  const formatRange = (range: ReservationDisabledRangeDTO) => {
    const start = new Date(range.startsAt);
    const end = new Date(range.endsAt);
    const startTime = start.toLocaleTimeString(locale, timeOpts);
    const endTime = end.toLocaleTimeString(locale, timeOpts);
    const sameDay = start.toDateString() === end.toDateString();
    const dateStr = start.toLocaleDateString(locale, dateOpts);
    const endDateStr = end.toLocaleDateString(locale, dateOpts);
    if (isMidnight(start) && isEndOfDay(end)) return `${dateStr} – ${endDateStr}`;
    if (sameDay) return `${dateStr} ${isMidnight(start) ? "00:00" : startTime} – ${isEndOfDay(end) ? "23:59" : endTime}`;
    return `${dateStr} ${isMidnight(start) ? "" : startTime} – ${endDateStr} ${isEndOfDay(end) ? "" : endTime}`;
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
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold break-words">{t("reservations:disabled_ranges_section")}</h2>
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
              className="flex flex-wrap items-center justify-between gap-3 p-3 border rounded-md hover:bg-accent/30 transition-colors cursor-pointer"
              onDoubleClick={() => navigate(editPath(range.id))}
              title={t("common:edit")}
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
                    {range.serviceIds.map((id) => services.find((s) => s.id === Number(id))?.name ?? `#${id}`).join(", ")}
                  </p>
                )}
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" className="h-8 w-8 p-0 shrink-0">
                    <span className="sr-only">{t("common:actions")}</span>
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{t("common:actions")}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => navigate(editPath(range.id))}>
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("common:edit")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => setDeleteTarget(range)}
                    className="text-red-600 focus:text-red-600"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    {t("common:delete")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
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
