// ----------------------------------------------------------------------------
// ReservationDisabledRangeCreatePage — manage disabled dates and holidays.
// Select a service, then toggle holiday rules or add a custom date range.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, CalendarOff } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { useModuleResolution } from "@/hooks/useModuleResolution";
import { buildWorkspaceModuleChildPath } from "@/lib/workspace-navigation";
import {
  getDisableSettings,
  createDisabledRange,
  updateServiceHolidays,
} from "@/lib/reservations";

export default function ReservationDisabledRangeCreatePage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { resourceId: reservationId } = useModuleResolution();
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();
  const projectId = Number(projectIdParam);
  const moduleId = Number(moduleIdParam);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ["reservation-disable-settings", reservationId],
    queryFn: () => getDisableSettings(reservationId!),
    enabled: !!reservationId,
  });

  const services = settings?.services ?? [];
  const [selectedServiceId, setSelectedServiceId] = useState<number | null>(null);

  // Custom date range state
  const [startDate, setStartDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endDate, setEndDate] = useState("");
  const [endTime, setEndTime] = useState("");
  const [reason, setReason] = useState("");

  const selectedService = services.find((s) => s.id === selectedServiceId);

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedServiceId || !startDate || !endDate) {
        throw new Error(t("reservations:disabled_range_dates_required"));
      }
      const startIso = startTime
        ? new Date(`${startDate}T${startTime}:00`).toISOString()
        : new Date(`${startDate}T00:00:00`).toISOString();
      const endIso = endTime
        ? new Date(`${endDate}T${endTime}:00`).toISOString()
        : new Date(`${endDate}T23:59:00`).toISOString();
      return createDisabledRange(reservationId!, {
        startsAt: startIso,
        endsAt: endIso,
        reason: reason.trim() || null,
        serviceIds: [selectedServiceId],
      });
    },
    onSuccess: () => {
      showSuccess(t("reservations:disabled_range_created"));
      queryClient.invalidateQueries({ queryKey: ["reservation-disable-settings", reservationId] });
      goBack();
    },
    onError: (err: Error) => showError(err.message),
  });

  const holidayMutation = useMutation({
    mutationFn: ({ rules }: { rules: Array<{ key: string; enabled: boolean }> }) =>
      updateServiceHolidays(reservationId!, { serviceId: selectedServiceId!, rules }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["reservation-disable-settings", reservationId] });
    },
    onError: (err: Error) => showError(err.message),
  });

  const goBack = () => {
    navigate(buildWorkspaceModuleChildPath(projectId, "reservation", moduleId, "blocked"));
  };

  const getHolidayName = (key: string) => t(`reservations:holiday_${key}`, key);

  if (settingsLoading) {
    return (
      <div className="max-w-2xl mx-auto space-y-6 w-full">
        <div className="flex items-center justify-center py-8 text-muted-foreground gap-2">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("common:loading")}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6 w-full">
      {/* Service selector */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{t("reservations:disabled_range_add")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm font-medium">{t("reservations:range_services")}</Label>
            <div className="flex flex-wrap gap-2">
              {services.map((svc) => (
                <button
                  key={svc.id}
                  type="button"
                  className={`px-3 py-1.5 rounded-md text-sm border transition-colors ${
                    selectedServiceId === svc.id
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-background hover:bg-accent border-border"
                  }`}
                  onClick={() => setSelectedServiceId(svc.id)}
                >
                  {svc.name}
                  {svc.workerFirstName && (
                    <span className="text-xs ml-1 opacity-70">
                      ({svc.workerFirstName})
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Holiday rules — only shown when a service is selected */}
      {selectedService && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarOff className="h-4 w-4" />
              {t("reservations:holidays_auto_section")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {selectedService.holidayRules.map((rule) => (
                <div
                  key={rule.key}
                  className="flex items-center justify-between gap-3 py-1.5 px-2 rounded hover:bg-accent/20"
                >
                  <span className="text-sm">{getHolidayName(rule.key)}</span>
                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={() =>
                      holidayMutation.mutate({
                        rules: [{ key: rule.key, enabled: !rule.enabled }],
                      })
                    }
                    disabled={holidayMutation.isPending}
                    aria-label={getHolidayName(rule.key)}
                  />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Custom date range — only shown when a service is selected */}
      {selectedService && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("reservations:manual_ranges_section")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t("reservations:disabled_range_start_date")}</Label>
                <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t("reservations:disabled_range_start_time")}</Label>
                <Input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  placeholder={t("reservations:disabled_range_time_optional")}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("reservations:disabled_range_end_date")}</Label>
                <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t("reservations:disabled_range_end_time")}</Label>
                <Input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  placeholder={t("reservations:disabled_range_time_optional")}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("reservations:disabled_range_reason")}</Label>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reservations:disabled_range_reason_placeholder")}
                maxLength={500}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !startDate || !endDate}
              >
                {createMutation.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {t("reservations:disabled_range_create_confirm")}
              </Button>
              <Button variant="ghost" onClick={goBack}>
                {t("common:cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
