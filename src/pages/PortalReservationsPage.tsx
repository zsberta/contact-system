// PortalReservationsPage — reservation bookings for the selected project,
// with a "Disable dates" button that opens a modal for managing blocked ranges.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { CalendarClock, Ban, Loader2, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SubmissionsBookingsTab from "@/components/submissions/SubmissionsBookingsTab";
import { DisabledRangesTab } from "@/components/reservations/DisabledRangesTab";
import { AvailabilityScheduleTab } from "@/components/reservations/AvailabilityScheduleTab";
import { getAllReservationsPaged } from "@/lib/reservations";
import { useProjectContext } from "@/context/ProjectContext";

export default function PortalReservationsPage() {
  const { t } = useTranslation(["submissions", "reservations", "enduser", "common"]);
  const { selectedId: projectId } = useProjectContext();

  const [disableModalOpen, setDisableModalOpen] = useState(false);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);

  const { data: reservations, isLoading: reservationsLoading } = useQuery({
    queryKey: ["portal", "reservations-for-disable", projectId],
    queryFn: () =>
      getAllReservationsPaged({
        projectId: projectId!,
        page: 0,
        size: 500,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  const reservationList = reservations?.content ?? [];

  const handleOpenDisableModal = () => {
    if (reservationList.length === 1) {
      setSelectedReservationId(reservationList[0].id);
    }
    setDisableModalOpen(true);
  };

  const handleOpenScheduleModal = () => {
    if (reservationList.length === 1) {
      setSelectedReservationId(reservationList[0].id);
    }
    setScheduleModalOpen(true);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <CalendarClock className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-2xl font-bold">{t("submissions:bookings_tab")}</h1>
        </div>
        {projectId && reservationList.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={handleOpenScheduleModal} className="flex-1 sm:flex-none">
              <Clock className="mr-1 h-4 w-4" />
              {t("reservations:schedule_add")}
            </Button>
            <Button variant="outline" size="sm" onClick={handleOpenDisableModal} className="flex-1 sm:flex-none">
              <Ban className="mr-1 h-4 w-4" />
              {t("reservations:disabled_range_add")}
            </Button>
          </div>
        )}
      </div>

      <SubmissionsBookingsTab projectId={projectId} />

      {/* Disable dates modal */}
      <Dialog open={disableModalOpen} onOpenChange={setDisableModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("reservations:disabled_ranges_section")}
            </DialogTitle>
          </DialogHeader>

          {reservationList.length > 1 && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                {t("reservations:select_reservation")}
              </label>
              <Select
                value={selectedReservationId ? String(selectedReservationId) : undefined}
                onValueChange={(v) => setSelectedReservationId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("reservations:select_reservation")} />
                </SelectTrigger>
                <SelectContent>
                  {reservationList.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {reservationsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("common:loading")}
            </div>
          ) : selectedReservationId ? (
            <DisabledRangesTab reservationId={selectedReservationId} />
          ) : reservationList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("enduser:no_reservations")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("reservations:select_reservation")}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Schedule modal */}
      <Dialog open={scheduleModalOpen} onOpenChange={setScheduleModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("reservations:schedules_tab")}
            </DialogTitle>
          </DialogHeader>

          {reservationList.length > 1 && (
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                {t("reservations:select_reservation")}
              </label>
              <Select
                value={selectedReservationId ? String(selectedReservationId) : undefined}
                onValueChange={(v) => setSelectedReservationId(Number(v))}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("reservations:select_reservation")} />
                </SelectTrigger>
                <SelectContent>
                  {reservationList.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {reservationsLoading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
              <Loader2 className="h-5 w-5 animate-spin" />
              {t("common:loading")}
            </div>
          ) : selectedReservationId ? (
            <AvailabilityScheduleTab reservationId={selectedReservationId} />
          ) : reservationList.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("enduser:no_reservations")}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("reservations:select_reservation")}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
