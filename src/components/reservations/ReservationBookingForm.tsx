// ReservationBookingForm — admin/enduser booking creation form.
// Selects reservation/service, date, time, and customer, then submits
// through the shared admin booking endpoint.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  getReservationServices,
  getReservationById,
  createEnrichedReservationBooking,
  createReservationCustomer,
} from "@/lib/reservations";
import { ReservationCustomerPicker } from "./ReservationCustomerPicker";
import type {
  ReservationDTO,
  ReservationServiceDTO,
  ReservationCustomerDTO,
} from "@/types/reservation";

interface ReservationBookingFormProps {
  reservationId?: number;
  onSuccess?: () => void;
}

export const ReservationBookingForm: React.FC<ReservationBookingFormProps> = ({
  reservationId: initialReservationId,
  onSuccess,
}) => {
  const { t } = useTranslation(["reservations", "common"]);
  const queryClient = useQueryClient();

  const [reservationId, setReservationId] = useState<number | null>(initialReservationId || null);
  const [serviceId, setServiceId] = useState<number | null>(null);
  const [date, setDate] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [customer, setCustomer] = useState<ReservationCustomerDTO | null>(null);
  const [comment, setComment] = useState("");

  // Load reservation details
  const { data: reservation } = useQuery({
    queryKey: ["reservation", reservationId],
    queryFn: () => getReservationById(reservationId!),
    enabled: !!reservationId,
  });

  // Load services for this reservation
  const { data: services } = useQuery({
    queryKey: ["reservation-services", reservationId],
    queryFn: () => getReservationServices(reservationId!),
    enabled: !!reservationId,
  });

  const createMutation = useMutation({
    mutationFn: () => {
      if (!reservationId || !serviceId || !date || !startTime || !endTime || !customer) {
        throw new Error("Missing required fields");
      }
      const startsAt = `${date}T${startTime}:00Z`;
      const endsAt = `${date}T${endTime}:00Z`;
      return createEnrichedReservationBooking(reservationId, {
        serviceId,
        startsAt,
        endsAt,
        customerId: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        email: customer.email,
        phone: customer.phone,
        comment: comment || undefined,
      });
    },
    onSuccess: () => {
      showSuccess(t("reservations:booking_created"));
      queryClient.invalidateQueries({ queryKey: ["reservation-bookings"] });
      onSuccess?.();
      // Reset form
      setServiceId(null);
      setDate("");
      setStartTime("");
      setEndTime("");
      setCustomer(null);
      setComment("");
    },
    onError: (err: Error) => {
      showError(err.message);
    },
  });

  const selectedService = services?.find((s) => s.id === serviceId);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("reservations:create_booking")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Service selection */}
        {services && services.length > 0 && (
          <div>
            <Label>{t("reservations:service")}</Label>
            <Select value={serviceId ? String(serviceId) : ""} onValueChange={(v) => setServiceId(Number(v))}>
              <SelectTrigger>
                <SelectValue placeholder={t("reservations:select_service")} />
              </SelectTrigger>
              <SelectContent>
                {services.map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name} — {s.durationMinutes}min · {s.priceAmount} {s.currency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Date and time */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label>{t("reservations:date")}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <Label>{t("reservations:start_time")}</Label>
            <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
          </div>
          <div>
            <Label>{t("reservations:end_time")}</Label>
            <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
          </div>
        </div>

        {/* Service info */}
        {selectedService && (
          <div className="flex gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{selectedService.durationMinutes}min</Badge>
            <Badge variant="outline">{selectedService.capacity} seats</Badge>
            {selectedService.workerFirstName && (
              <Badge variant="outline">
                {selectedService.workerFirstName} {selectedService.workerLastName}
              </Badge>
            )}
          </div>
        )}

        {/* Customer picker */}
        {reservation && (
          <ReservationCustomerPicker
            projectId={reservation.projectId}
            value={customer}
            onChange={setCustomer}
            onCreateNew={async (data) => {
              try {
                const newCustomer = await createReservationCustomer({
                  projectId: reservation.projectId,
                  ...data,
                });
                setCustomer(newCustomer);
                showSuccess(t("reservations:customer_created"));
              } catch (err) {
                showError(err instanceof Error ? err.message : "Failed to create customer");
              }
            }}
          />
        )}

        {/* Comment */}
        <div>
          <Label>{t("reservations:comment")}</Label>
          <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
        </div>

        <Button
          onClick={() => createMutation.mutate()}
          disabled={!serviceId || !date || !startTime || !endTime || !customer || createMutation.isPending}
        >
          {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {t("reservations:create_booking")}
        </Button>
      </CardContent>
    </Card>
  );
};

export default ReservationBookingForm;
