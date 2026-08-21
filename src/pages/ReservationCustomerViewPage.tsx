// ReservationCustomerViewPage — customer detail with booking history, edit, delete.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Save, Trash2 } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import {
  getReservationCustomerById,
  updateReservationCustomer,
  deleteReservationCustomer,
  getReservationCustomerBookings,
} from "@/lib/reservations";

const STATUS_VARIANT: Record<string, "default" | "destructive" | "secondary"> = {
  confirmed: "default",
  cancelled: "destructive",
  completed: "secondary",
  no_show: "destructive",
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}. ${m}. ${day}.`;
}

function isSameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate();
}

export default function ReservationCustomerViewPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const { customerId, projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    customerId: string;
    projectId: string;
    moduleId: string;
  }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = parseInt(customerId || "0", 10);

  const backToList = () => {
    if (projectIdParam && moduleIdParam) {
      navigate(`/workspace/projects/${projectIdParam}/modules/reservation/${moduleIdParam}/customers`);
    } else {
      navigate("/reservations/customers");
    }
  };

  const { data: customer, isLoading } = useQuery({
    queryKey: ["reservation-customer", id],
    queryFn: () => getReservationCustomerById(id),
    enabled: id > 0,
  });

  const { data: bookings } = useQuery({
    queryKey: ["reservation-customer-bookings", id],
    queryFn: () => getReservationCustomerBookings(id),
    enabled: id > 0,
  });

  const [editMode, setEditMode] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", phone: "" });

  const updateMutation = useMutation({
    mutationFn: () => updateReservationCustomer(id, form),
    onSuccess: () => {
      showSuccess(t("reservations:customer_updated"));
      queryClient.invalidateQueries({ queryKey: ["reservation-customer", id] });
      queryClient.invalidateQueries({ queryKey: ["reservation-customers"] });
      setEditMode(false);
    },
    onError: (err: Error) => showError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteReservationCustomer(id),
    onSuccess: () => {
      showSuccess(t("reservations:customer_deleted"));
      queryClient.invalidateQueries({ queryKey: ["reservation-customers"] });
      backToList();
    },
    onError: (err: Error) => showError(err.message),
  });

  if (isLoading) return <p className="text-muted-foreground">{t("common:loading")}</p>;
  if (!customer) return <p>{t("reservations:customer_not_found")}</p>;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <Button variant="ghost" onClick={backToList}>
        <ArrowLeft className="mr-2 h-4 w-4" />{t("common:back")}
      </Button>

      <Card className="w-full">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{customer.lastName} {customer.firstName}</CardTitle>
          <div className="flex gap-2">
            {!editMode && (
              <>
                <Button variant="outline" size="sm" onClick={() => {
                  setForm({ firstName: customer.firstName, lastName: customer.lastName, email: customer.email, phone: customer.phone });
                  setEditMode(true);
                }}>{t("common:edit")}</Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(t("reservations:delete_customer_confirm"))) {
                      deleteMutation.mutate();
                    }
                  }}
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="mr-1 h-3 w-3" />{t("common:delete")}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {editMode ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><Label>{t("reservations:first_name")}</Label><Input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></div>
                <div><Label>{t("reservations:last_name")}</Label><Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></div>
                <div><Label>{t("reservations:email")}</Label><Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div><Label>{t("reservations:phone")}</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditMode(false)}>{t("common:cancel")}</Button>
                <Button size="sm" onClick={() => updateMutation.mutate()} disabled={updateMutation.isPending}>
                  <Save className="mr-2 h-4 w-4" />{t("common:save")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><span className="text-muted-foreground">{t("reservations:email")}:</span> {customer.email}</div>
              <div><span className="text-muted-foreground">{t("reservations:phone")}:</span> {customer.phone}</div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="w-full">
        <CardHeader><CardTitle>{t("reservations:booking_history")}</CardTitle></CardHeader>
        <CardContent>
          {bookings && bookings.length > 0 ? (
            <div className="space-y-2">
              {bookings.map((b) => {
                const statusKey = `reservations:booking_status_${b.status}`;
                return (
                  <div key={b.id} className="rounded border p-3 text-sm space-y-1 w-full">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{b.serviceNameSnapshot || b.serviceName || "—"}</span>
                      <Badge variant={STATUS_VARIANT[b.status] ?? "secondary"}>
                        {t(statusKey)}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      {isSameDay(b.startsAt, b.endsAt) ? (
                        <>{formatDate(b.startsAt)} <span className="font-semibold text-foreground text-base">{formatTime(b.startsAt)} – {formatTime(b.endsAt)}</span></>
                      ) : (
                        <>{formatDate(b.startsAt)} <span className="font-semibold text-foreground text-base">{formatTime(b.startsAt)}</span> – {formatDate(b.endsAt)} <span className="font-semibold text-foreground text-base">{formatTime(b.endsAt)}</span></>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">{t("reservations:no_bookings")}</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
