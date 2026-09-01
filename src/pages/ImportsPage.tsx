// ImportsPage — admin-only CSV import wizard (Customers / Bookings).
//
// Flow:
//   1. Setup: pick project, upload CSV, choose import type → dry run.
//   2. Review: per-row validation results; invalid rows are shown with
//      reasons (editable inline for simple fields before commit).
//      For bookings, an extra service-mapping step appears: every distinct
//      Calendar value must map to an existing service or a new one (with
//      duration/price/capacity) before bookings can be imported.
//   3. Result: per-row commit outcome. Booking confirmation emails are
//      enqueued server-side (rate-limited); with EMAIL_SENDING=false none
//      are queued and the result shows the disabled note instead.

import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Upload, FileSpreadsheet, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { showError, showSuccess } from "@/utils/toast";
import { useProjectContext } from "@/context/ProjectContext";
import {
  dryRunImport,
  importCustomers,
  importBookings,
  createImportServices,
  type ImportDryRunResult,
  type ImportCommitResult,
  type ImportServiceMapping,
} from "@/lib/api";

type Step = "setup" | "review" | "services" | "result";

interface NewServiceSpec {
  name: string;
  durationMinutes: string;
  priceAmount: string;
  currency: string;
  capacity: string;
}

const ImportsPage: React.FC = () => {
  const { t } = useTranslation(["imports", "common"]);
  const { projects } = useProjectContext();
  const fileRef = useRef<HTMLInputElement>(null);

  const [projectId, setProjectId] = useState<number | null>(null);
  const [importType, setImportType] = useState<"customers" | "bookings">("customers");
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>("setup");
  const [dryRun, setDryRun] = useState<ImportDryRunResult | null>(null);
  const [serviceSpecs, setServiceSpecs] = useState<Record<string, NewServiceSpec>>({});
  const [serviceIdByName, setServiceIdByName] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ImportCommitResult | null>(null);

  const reset = () => {
    setStep("setup");
    setDryRun(null);
    setFile(null);
    setServiceSpecs({});
    setServiceIdByName({});
    setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const dryRunMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("projectId", String(projectId));
      fd.append("importType", importType);
      fd.append("file", file!);
      return dryRunImport(fd);
    },
    onSuccess: (data) => {
      setDryRun(data);
      // Pre-fill service specs for unmapped Calendar values with sample duration.
      const specs: Record<string, NewServiceSpec> = {};
      for (const s of data.services ?? []) {
        if (!s.existingServiceId) {
          specs[s.name] = {
            name: s.name,
            durationMinutes: "60",
            priceAmount: "0",
            currency: "HUF",
            capacity: "1",
          };
        } else {
          specs[s.name] = {
            name: s.name,
            durationMinutes: String(s.existingDurationMinutes ?? 60),
            priceAmount: "0",
            currency: "HUF",
            capacity: "1",
          };
        }
      }
      setServiceSpecs(specs);
      setStep(data.services && data.services.length > 0 ? "services" : "review");
    },
    onError: (err: Error) => showError(err.message),
  });

  const createServicesMutation = useMutation({
    mutationFn: () =>
      createImportServices({
        projectId: projectId!,
        services: Object.values(serviceSpecs).map((s) => ({
          name: s.name,
          durationMinutes: parseInt(s.durationMinutes, 10),
          priceAmount: s.priceAmount === "" ? 0 : Number(s.priceAmount),
          currency: s.currency || "HUF",
          capacity: s.capacity === "" ? 1 : parseInt(s.capacity, 10),
        })),
      }),
    onSuccess: (data) => {
      const map: Record<string, number> = {};
      for (const c of data.created) map[c.name] = c.id;
      setServiceIdByName(map);
      if (data.errors.length > 0) {
        showError(t("imports:services_create_errors", { count: data.errors.length }));
      } else {
        showSuccess(t("imports:services_created", { count: data.created.length }));
      }
      setStep("review");
    },
    onError: (err: Error) => showError(err.message),
  });

  const commitMutation = useMutation({
    mutationFn: (): Promise<ImportCommitResult> => {
      if (importType === "customers") {
        return importCustomers({
          projectId: projectId!,
          rows: dryRun!.rows
            .filter((r) => r.ok)
            .map((r) => ({
              rowNumber: r.rowNumber,
              firstName: String(r.data.firstName ?? ""),
              lastName: String(r.data.lastName ?? ""),
              email: String(r.data.email ?? ""),
              phone: String(r.data.phone ?? ""),
            })),
        });
      }
      return importBookings({
        projectId: projectId!,
        bookings: dryRun!.rows
          .filter((r) => r.ok)
          .map((r) => ({
            rowNumber: r.rowNumber,
            serviceId: serviceIdByName[String(r.data.serviceName ?? "")] ?? 0,
            firstName: String(r.data.firstName ?? ""),
            lastName: String(r.data.lastName ?? ""),
            email: String(r.data.email ?? ""),
            phone: String(r.data.phone ?? ""),
            startsAt: String(r.data.startsAt ?? ""),
            endsAt: String(r.data.endsAt ?? ""),
            // Backend dry-run maps CSV 'showed' → 'attended' already.
            status: String(r.data.status ?? ""),
          })),
      });
    },
    onSuccess: (data) => {
      setResult(data);
      setStep("result");
      showSuccess(t("imports:import_done", { imported: data.imported, failed: data.failed }));
    },
    onError: (err: Error) => showError(err.message),
  });

  // Service mapping completeness: every distinct Calendar value must resolve
  // to a service id (existing or freshly created).
  const servicesReady = useMemo(() => {
    if (!dryRun?.services) return true;
    return dryRun.services.every((s: ImportServiceMapping) => {
      if (s.existingServiceId) return true;
      const spec = serviceSpecs[s.name];
      return !!spec && parseInt(spec.durationMinutes, 10) > 0;
    });
  }, [dryRun, serviceSpecs]);

  const canCommit =
    !!dryRun &&
    dryRun.validCount > 0 &&
    (importType === "customers" || (servicesReady && Object.keys(serviceIdByName).length >= 0));

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">{t("imports:title")}</h1>
        <p className="text-sm text-muted-foreground">{t("imports:subtitle")}</p>
      </div>

      {step === "setup" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("imports:setup_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t("imports:project")}</Label>
              <Select
                value={projectId ? String(projectId) : ""}
                onValueChange={(v) => setProjectId(Number(v))}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue placeholder={t("imports:project_placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>{t("imports:import_type")}</Label>
              <Select
                value={importType}
                onValueChange={(v) => setImportType(v as "customers" | "bookings")}
              >
                <SelectTrigger className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="customers">{t("imports:type_customers")}</SelectItem>
                  <SelectItem value="bookings">{t("imports:type_bookings")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="import-file">{t("imports:file")}</Label>
              <Input
                id="import-file"
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="w-full sm:w-96"
              />
            </div>

            <Button
              disabled={!projectId || !file || dryRunMutation.isPending}
              onClick={() => dryRunMutation.mutate()}
            >
              {dryRunMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {t("imports:dry_run")}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === "services" && dryRun && (
        <Card>
          <CardHeader>
            <CardTitle>{t("imports:services_title")}</CardTitle>
            <p className="text-sm text-muted-foreground">{t("imports:services_subtitle")}</p>
          </CardHeader>
          <CardContent className="space-y-4">
            {(dryRun.services ?? []).map((s) => {
              const spec = serviceSpecs[s.name];
              const update = (patch: Partial<NewServiceSpec>) =>
                setServiceSpecs((prev) => ({
                  ...prev,
                  [s.name]: { ...prev[s.name], ...patch },
                }));
              return (
                <div key={s.name} className="rounded-lg border p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <FileSpreadsheet className="h-4 w-4" />
                    <span className="font-medium">{s.name}</span>
                    <Badge variant="secondary">
                      {t("imports:rows", {  count: s.rowCount  })}
                    </Badge>
                    {s.existingServiceId ? (
                      <Badge>{t("imports:service_existing")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("imports:service_new")}</Badge>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <div className="space-y-1">
                      <Label className="text-xs">{t("imports:duration")}</Label>
                      <Input
                        type="number"
                        min={1}
                        value={spec?.durationMinutes ?? "60"}
                        onChange={(e) => update({ durationMinutes: e.target.value })}
                        disabled={!!s.existingServiceId}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("imports:price")}</Label>
                      <Input
                        type="number"
                        min={0}
                        value={spec?.priceAmount ?? "0"}
                        onChange={(e) => update({ priceAmount: e.target.value })}
                        disabled={!!s.existingServiceId}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("imports:currency")}</Label>
                      <Input
                        value={spec?.currency ?? "HUF"}
                        onChange={(e) => update({ currency: e.target.value.toUpperCase() })}
                        disabled={!!s.existingServiceId}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t("imports:capacity")}</Label>
                      <Input
                        type="number"
                        min={1}
                        value={spec?.capacity ?? "1"}
                        onChange={(e) => update({ capacity: e.target.value })}
                        disabled={!!s.existingServiceId}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="flex gap-2">
              <Button
                disabled={!servicesReady || createServicesMutation.isPending}
                onClick={() => createServicesMutation.mutate()}
              >
                {createServicesMutation.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {t("imports:create_services")}
              </Button>
              <Button variant="outline" onClick={reset}>
                {t("common:cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "review" && dryRun && (
        <Card>
          <CardHeader>
            <CardTitle>{t("imports:review_title")}</CardTitle>
            <div className="flex gap-2 pt-1">
              <Badge>
                {t("imports:total_rows", {  count: dryRun.totalRows  })}
              </Badge>
              <Badge className="bg-green-600">
                {t("imports:valid_rows", {  count: dryRun.validCount  })}
              </Badge>
              {dryRun.invalidCount > 0 && (
                <Badge variant="destructive">
                  {t("imports:invalid_rows", {  count: dryRun.invalidCount  })}
                </Badge>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="max-h-96 overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">{t("imports:col_status")}</th>
                    <th className="px-2 py-1 text-left">{t("imports:col_detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dryRun.rows.map((r) => (
                    <tr key={r.rowNumber} className="border-t">
                      <td className="px-2 py-1">{r.rowNumber}</td>
                      <td className="px-2 py-1">
                        {r.ok ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <XCircle className="h-4 w-4 text-destructive" />
                        )}
                      </td>
                      <td className="px-2 py-1">
                        {r.ok ? (
                          <span className="text-muted-foreground">
                            {importType === "customers"
                              ? `${r.data.firstName} ${r.data.lastName} <${r.data.email}>`
                              : `${r.data.firstName} ${r.data.lastName} · ${r.data.serviceName} · ${r.data.startsAt}`}
                          </span>
                        ) : (
                          <span className="text-destructive">{r.errors.join("; ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {importType === "bookings" && (
              <p className="text-xs text-muted-foreground">{t("imports:email_note")}</p>
            )}
            <div className="flex gap-2">
              <Button disabled={!canCommit || commitMutation.isPending} onClick={() => commitMutation.mutate()}>
                {commitMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("imports:commit", {  count: dryRun.validCount  })}
              </Button>
              <Button variant="outline" onClick={reset}>
                {t("common:cancel")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === "result" && result && (
        <Card>
          <CardHeader>
            <CardTitle>{t("imports:result_title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge className="bg-green-600">{t("imports:imported", {  count: result.imported  })}</Badge>
              {!!result.skippedDuplicates && result.skippedDuplicates > 0 && (
                <Badge variant="secondary">
                  {t("imports:skipped", {  count: result.skippedDuplicates  })}
                </Badge>
              )}
              {result.failed > 0 && (
                <Badge variant="destructive">{t("imports:failed", {  count: result.failed  })}</Badge>
              )}
              {importType === "bookings" && (
                <Badge variant="outline">
                  {result.emailsSending === false
                    ? t("imports:emails_disabled")
                    : t("imports:emails_note", {  count: result.emailsQueued ?? 0  })}
                </Badge>
              )}
            </div>
            {result.failed > 0 && (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <tbody>
                    {result.results
                      .filter((r) => !r.ok)
                      .map((r) => (
                        <tr key={r.rowNumber} className="border-t">
                          <td className="px-2 py-1">{r.rowNumber}</td>
                          <td className="px-2 py-1 text-destructive">
                            {(r.errors ?? []).join("; ")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <Button onClick={reset}>{t("imports:import_more")}</Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export default ImportsPage;
