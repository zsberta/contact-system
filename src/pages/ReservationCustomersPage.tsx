// ReservationCustomersPage — project-scoped customer list.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, ExternalLink } from "lucide-react";
import { getReservationCustomers } from "@/lib/reservations";

export default function ReservationCustomersPage() {
  const { t } = useTranslation(["reservations", "common"]);
  const [search, setSearch] = useState("");
  const { projectId: projectIdParam, moduleId: moduleIdParam } = useParams<{
    projectId: string;
    moduleId: string;
  }>();

  const projectId = projectIdParam ? Number(projectIdParam) : undefined;

  const { data, isLoading } = useQuery({
    queryKey: ["reservation-customers", search, projectId],
    queryFn: () =>
      getReservationCustomers({
        search: search || undefined,
        projectId,
        size: 50,
      }),
  });

  const customers = data?.content || [];

  // Build the detail link for each customer — workspace route when available,
  // legacy admin route otherwise.
  const detailPath = (customerId: number) => {
    if (projectIdParam && moduleIdParam) {
      return `/workspace/projects/${projectIdParam}/modules/reservation/${moduleIdParam}/customers/${customerId}`;
    }
    return `/reservations/customers/${customerId}`;
  };

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("reservations:customers")}</h2>

      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("reservations:search_customers")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      {isLoading && <p className="text-muted-foreground">{t("common:loading")}</p>}

      <div className="space-y-2">
        {customers.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="font-medium">{c.lastName} {c.firstName}</div>
              <div className="text-sm text-muted-foreground">{c.email} · {c.phone}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={c.status === "active" ? "default" : "secondary"}>
                {c.status}
              </Badge>
              <Button variant="ghost" size="icon" asChild>
                <Link to={detailPath(c.id)}>
                  <ExternalLink className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        ))}
      </div>

      {customers.length === 0 && !isLoading && (
        <p className="text-center text-muted-foreground py-8">{t("reservations:no_customers")}</p>
      )}
    </div>
  );
}
