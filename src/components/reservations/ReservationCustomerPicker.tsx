// ReservationCustomerPicker — search, select, or create a project customer
// for booking creation. Shows booking history where permitted.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Check, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { getReservationCustomers } from "@/lib/reservations";
import type { ReservationCustomerDTO } from "@/types/reservation";

interface ReservationCustomerPickerProps {
  projectId: number;
  value: ReservationCustomerDTO | null;
  onChange: (customer: ReservationCustomerDTO | null) => void;
  onCreateNew: (data: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string;
  }) => void;
  disabled?: boolean;
}

export const ReservationCustomerPicker: React.FC<ReservationCustomerPickerProps> = ({
  projectId,
  value,
  onChange,
  onCreateNew,
  disabled = false,
}) => {
  const { t } = useTranslation(["reservations", "common"]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [newFirstName, setNewFirstName] = useState("");
  const [newLastName, setNewLastName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newPhone, setNewPhone] = useState("");

  const { data: customersData } = useQuery({
    queryKey: ["reservation-customers", projectId, search],
    queryFn: () =>
      getReservationCustomers({ projectId, search: search || undefined, size: 20 }),
    enabled: open && projectId > 0,
  });

  const customers = customersData?.content || [];

  function handleCreateNew() {
    if (newFirstName && newLastName && newEmail && newPhone) {
      onCreateNew({
        firstName: newFirstName,
        lastName: newLastName,
        email: newEmail,
        phone: newPhone,
      });
      setShowNew(false);
      setNewFirstName("");
      setNewLastName("");
      setNewEmail("");
      setNewPhone("");
      setOpen(false);
    }
  }

  return (
    <div className="space-y-2">
      <Label>{t("reservations:customer")}</Label>

      {value && !open ? (
        <div className="flex items-center justify-between rounded-md border p-2">
          <div>
            <span className="font-medium">{value.lastName} {value.firstName}</span>
            <span className="ml-2 text-sm text-muted-foreground">({value.email})</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { onChange(null); }}>
            {t("common:cancel")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("reservations:search_customers")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
              onFocus={() => setOpen(true)}
            />
          </div>

          {open && customers.length > 0 && (
            <Card className="max-h-48 overflow-y-auto">
              <CardContent className="p-0">
                {customers.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      onChange(c);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check className={cn("h-4 w-4", value?.id === c.id ? "opacity-100" : "opacity-0")} />
                    <div>
                      <div className="font-medium">{c.lastName} {c.firstName}</div>
                      <div className="text-xs text-muted-foreground">{c.email} · {c.phone}</div>
                    </div>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}

          {open && customers.length === 0 && search.length > 0 && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <span className="text-sm text-muted-foreground">{t("reservations:no_customers_found")}</span>
              <Button variant="outline" size="sm" onClick={() => setShowNew(true)}>
                <Plus className="mr-1 h-3 w-3" />{t("reservations:create_customer")}
              </Button>
            </div>
          )}

          {!showNew && (
            <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" />{t("reservations:create_new_customer")}
            </Button>
          )}
        </div>
      )}

      {showNew && (
        <div className="rounded-lg border p-4 space-y-3">
          <p className="text-sm font-medium">{t("reservations:new_customer")}</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{t("reservations:first_name")} *</Label>
              <Input value={newFirstName} onChange={(e) => setNewFirstName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">{t("reservations:last_name")} *</Label>
              <Input value={newLastName} onChange={(e) => setNewLastName(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">{t("reservations:email")} *</Label>
              <Input type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">{t("reservations:phone")} *</Label>
              <Input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
            </div>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowNew(false)}>
              {t("common:cancel")}
            </Button>
            <Button
              size="sm"
              onClick={handleCreateNew}
              disabled={!newFirstName || !newLastName || !newEmail || !newPhone}
            >
              {t("reservations:create_customer")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReservationCustomerPicker;
