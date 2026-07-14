// /portal/projects/:id — Read-only view of a single project assigned to
// the current enduser. Renders the project details plus its forms,
// reservations and payments (all read-only). The BE already enforces
// that this id is in the enduser's projectIds — if the user navigates
// to a project they can't access, GET /api/projects/:id returns 404
// and we render a friendly empty state.

import React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, FileText, CalendarClock, Wallet } from "lucide-react";
import {
  getAllFormsPaged,
} from "@/lib/forms";
import { getAllReservationsPaged } from "@/lib/reservations";
import { getProjectById, getAllPaymentsPaged } from "@/lib/api";
import type { ProjectDTO } from "@/types/project";
import type { FormDTO } from "@/types/form";
import type { ReservationDTO } from "@/types/reservation";
import type { PaymentDTO } from "@/types/payment";

const formatPrice = (price: number | null): string => {
  if (price === null || price === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "HUF",
    maximumFractionDigits: 0,
  }).format(price);
};

const statusBadgeVariant = (
  status: ProjectDTO["status"],
): "default" | "secondary" | "destructive" => {
  if (status === "cancelled") return "destructive";
  if (status === "under_construction") return "secondary";
  return "default";
};

const paymentBadgeVariant = (
  status: PaymentDTO["status"],
): "default" | "secondary" | "destructive" => {
  if (status === "paid") return "default";
  if (status === "overdue") return "destructive";
  if (status === "cancelled") return "secondary";
  return "secondary";
};

const reservationBadgeVariant = (
  status: ReservationDTO["status"],
): "default" | "destructive" => {
  return status === "disabled" ? "destructive" : "default";
};

const EnduserProjectView: React.FC = () => {
  const { t } = useTranslation(["enduser", "projects", "forms", "reservations", "payments", "common"]);
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const projectId = id ? Number.parseInt(id) : null;

  const { data: project, isLoading: projectLoading } = useQuery<ProjectDTO, Error>({
    queryKey: ["portal", "project", projectId],
    queryFn: () => getProjectById(projectId!),
    enabled: !!projectId,
  });

  const { data: forms } = useQuery({
    queryKey: ["portal", "project", projectId, "forms"],
    queryFn: () =>
      getAllFormsPaged({
        projectId: projectId!,
        page: 0,
        size: 100,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  const { data: reservations } = useQuery({
    queryKey: ["portal", "project", projectId, "reservations"],
    queryFn: () =>
      getAllReservationsPaged({
        projectId: projectId!,
        page: 0,
        size: 100,
        sortField: "name",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  const { data: payments } = useQuery({
    queryKey: ["portal", "project", projectId, "payments"],
    queryFn: () =>
      getAllPaymentsPaged({
        projectId: projectId!,
        page: 0,
        size: 100,
        sortField: "dueDate",
        sortOrder: "asc",
      }),
    enabled: !!projectId,
  });

  if (!projectId) {
    return <div className="text-center p-8">{t("common:invalid_id")}</div>;
  }
  if (projectLoading) {
    return <div className="text-center p-8">{t("common:loading")}</div>;
  }
  if (!project) {
    return (
      <div className="text-center p-8 space-y-4">
        <p>{t("projects:project_not_found")}</p>
        <Button variant="outline" onClick={() => navigate("/portal")}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("enduser:back_to_my_projects")}
        </Button>
      </div>
    );
  }

  const details: Array<{ label: string; value: React.ReactNode }> = [
    { label: t("common:id"), value: project.id },
    { label: t("projects:name"), value: project.name },
    { label: t("projects:customer_name"), value: project.customerName || "—" },
    { label: t("projects:domain_address"), value: project.domainAddress || "—" },
    { label: t("projects:price"), value: formatPrice(project.price) },
    {
      label: t("common:status"),
      value: (
        <Badge variant={statusBadgeVariant(project.status)}>
          {t(`projects:status_${project.status}`)}
        </Badge>
      ),
    },
    {
      label: t("projects:customer_email"),
      value: project.customerEmail || "—",
    },
    { label: t("projects:comment"), value: project.comment || "—" },
  ];

  return (
    <div className="max-w-3xl mx-auto space-y-6 w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-2xl font-bold break-words">
              {project.name}
            </CardTitle>
            <Button
              variant="outline"
              onClick={() => navigate("/portal")}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              {t("enduser:back_to_my_projects")}
            </Button>
          </div>
        </CardHeader>
        <Separator />
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {details.map((item) => (
              <div key={item.label} className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">
                  {item.label}
                </p>
                <div className="text-base font-semibold break-words">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Forms */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t("enduser:project_forms")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!forms || forms.content.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("enduser:no_forms")}
            </p>
          ) : (
            <ul className="space-y-2">
              {forms.content.map((form) => (
                <li
                  key={form.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">{form.name}</p>
                    <p className="text-xs font-mono text-muted-foreground truncate">
                      {form.slug}
                    </p>
                  </div>
                  <Badge variant={form.status === "disabled" ? "destructive" : "default"}>
                    {t(`forms:status_${form.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Reservations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <CalendarClock className="h-5 w-5" />
            {t("enduser:project_reservations")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!reservations || reservations.content.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("enduser:no_reservations")}
            </p>
          ) : (
            <ul className="space-y-2">
              {reservations.content.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate">
                      <Link
                        to={`/reservations/view/${r.id}`}
                        className="hover:underline"
                      >
                        {r.name}
                      </Link>
                    </p>
                    <p className="text-xs font-mono text-muted-foreground truncate">
                      {r.slug}
                    </p>
                  </div>
                  <Badge variant={reservationBadgeVariant(r.status)}>
                    {t(`forms:status_${r.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Payments */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Wallet className="h-5 w-5" />
            {t("enduser:project_payments")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!payments || payments.content.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              {t("enduser:no_payments")}
            </p>
          ) : (
            <ul className="space-y-2">
              {payments.content.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center justify-between p-3 border rounded-md"
                >
                  <div className="min-w-0">
                    <p className="font-medium">
                      {formatPrice(p.amount)}{" "}
                      <span className="text-xs text-muted-foreground">
                        {p.dueDate ? `· ${p.dueDate}` : ""}
                      </span>
                    </p>
                    {p.note && (
                      <p className="text-xs text-muted-foreground truncate">
                        {p.note}
                      </p>
                    )}
                  </div>
                  <Badge variant={paymentBadgeVariant(p.status)}>
                    {t(`common:${p.status}`)}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default EnduserProjectView;
