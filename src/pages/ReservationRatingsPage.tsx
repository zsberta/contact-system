// ----------------------------------------------------------------------------
// ReservationRatingsPage — admin list of customer ratings for a reservation,
// with a summary (average, count, per-star distribution).
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { useModuleResolution } from "@/hooks/useModuleResolution";
import {
  deleteReservationRating,
  getReservationRatings,
} from "@/lib/reservations";
import { getReservationById } from "@/lib/reservations";
import { showError, showSuccess } from "@/utils/toast";
import type { ReservationRatingDTO } from "@/types/reservation";

function Stars({ value, size = "h-4 w-4" }: { value: number; size?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} / 5`}>
      {[1, 2, 3, 4, 5].map((s) => (
        <Star
          key={s}
          className={`${size} ${s <= value ? "fill-amber-400 text-amber-400" : "text-muted-foreground/40"}`}
        />
      ))}
    </span>
  );
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale === "hu" ? "hu-HU" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ReservationRatingsPage() {
  const { t, i18n } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<ReservationRatingDTO | null>(null);

  const { data: reservation } = useQuery({
    queryKey: ["reservations", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  const { data, isLoading } = useQuery({
    queryKey: ["reservation-ratings", reservationId],
    queryFn: () => getReservationRatings(reservationId!),
    enabled: !!reservationId,
  });

  const deleteMutation = useMutation({
    mutationFn: (ratingId: number) => deleteReservationRating(reservationId!, ratingId),
    onSuccess: () => {
      showSuccess(t("reservations:rating_deleted"));
      queryClient.invalidateQueries({ queryKey: ["reservation-ratings", reservationId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => showError(err.message),
  });

  if (!reservationId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }

  const summary = data?.summary;
  const ratings = data?.content ?? [];
  const locale = i18n.language?.startsWith("hu") ? "hu" : "en";
  const dist = summary?.distribution;

  return (
    <div className="max-w-5xl mx-auto space-y-6 w-full">
      <div>
        <h2 className="text-base sm:text-lg font-semibold break-words">
          {t("reservations:ratings")}
          {reservation ? ` — ${reservation.name}` : ""}
        </h2>
        <p className="text-sm text-muted-foreground">{t("reservations:ratings_description")}</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      ) : !summary || summary.count === 0 ? (
        <Card>
          <CardContent className="py-12 text-center space-y-2">
            <p className="font-medium">{t("reservations:no_ratings")}</p>
            <p className="text-sm text-muted-foreground">{t("reservations:no_ratings_hint")}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("reservations:average_rating")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <span className="text-3xl font-bold">{summary.average.toFixed(1)}</span>
                  <span className="text-sm text-muted-foreground">/ 5</span>
                </div>
                <div className="mt-1">
                  <Stars value={Math.round(summary.average)} />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {t("reservations:total_ratings")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-3xl font-bold">{summary.count}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{t("reservations:ratings_distribution")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {[5, 4, 3, 2, 1].map((s) => {
                  const key = String(s) as "1" | "2" | "3" | "4" | "5";
                  const n = dist?.[key] ?? 0;
                  const pct = summary.count > 0 ? Math.round((n / summary.count) * 100) : 0;
                  return (
                    <div key={s} className="flex items-center gap-2 text-xs">
                      <span className="w-3 text-right font-medium">{s}</span>
                      <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                      <div className="flex-1 h-2 rounded bg-muted overflow-hidden">
                        <div className="h-full bg-amber-400 rounded" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-8 text-right text-muted-foreground">{n}</span>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          </div>

          <div className="space-y-3">
            {ratings.map((r) => (
              <Card key={r.id}>
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1.5 min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <Stars value={r.rating} />
                        <span className="font-medium">{r.raterName || "—"}</span>
                        {r.serviceName && (
                          <span className="text-sm text-muted-foreground">{r.serviceName}</span>
                        )}
                      </div>
                      {r.comment && (
                        <p className="text-sm whitespace-pre-wrap break-words">{r.comment}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {t("reservations:rating_booking_date")}: {formatDateTime(r.bookingStartsAt, locale)}
                        {" · "}
                        {t("reservations:rating_created")}: {formatDateTime(r.createdAt, locale)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setDeleteTarget(r)}
                      aria-label={t("common:delete")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reservations:rating_delete_title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("reservations:rating_delete_description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (deleteTarget) deleteMutation.mutate(deleteTarget.id); }}
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
