// ----------------------------------------------------------------------------
// LogsPage — admin-only activity log. Read-only paged list: Card shell with
// title, an extra filter row (action type / action / actor / entity /
// project / dates), then the shared DataTable. Row click opens a detail
// Dialog with the full JSON sidecar (diff, email to/subject, url, ip…).
// ----------------------------------------------------------------------------

import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye } from "lucide-react";
import { getLogsPaged, getLogsMeta } from "@/lib/logs";
import type { GetLogsParams, LogActionType, LogDTO, PageLogDTO } from "@/types/log";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";

const ACTION_TYPES: LogActionType[] = ["CREATE", "READ", "UPDATE", "DELETE", "SEND", "ERROR"];

const actionTypeBadgeVariant = (actionType: LogActionType) => {
  switch (actionType) {
    case "CREATE":
      return "default" as const;
    case "UPDATE":
      return "secondary" as const;
    case "DELETE":
    case "ERROR":
      return "destructive" as const;
    case "SEND":
    case "READ":
      return "outline" as const;
    default:
      return "secondary" as const;
  }
};

function DiffTable({ diff }: { diff: Record<string, { from: unknown; to: unknown }> }) {
  const entries = Object.entries(diff);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="py-1 pr-2 font-medium">Field</th>
          <th className="py-1 pr-2 font-medium">From</th>
          <th className="py-1 font-medium">To</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([field, change]) => (
          <tr key={field} className="border-t align-top">
            <td className="py-1 pr-2 font-mono">{field}</td>
            <td className="py-1 pr-2 break-all font-mono text-muted-foreground">
              {String(change?.from ?? "—")}
            </td>
            <td className="py-1 break-all font-mono">{String(change?.to ?? "—")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Locale-aware timestamp; malformed values render "—" instead of "Invalid Date".
function formatLogDate(iso: string | null, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(lang);
}

function LogDetail({ log }: { log: LogDTO }) {
  const { t, i18n } = useTranslation(["logs", "common"]);
  const meta = log.metadata ?? {};
  const diff =
    meta.diff && typeof meta.diff === "object"
      ? (meta.diff as Record<string, { from: unknown; to: unknown }>)
      : null;
  const rows: Array<[string, React.ReactNode]> = [
    [t("logs:id"), <span className="font-mono">{log.id}</span>],
    [t("logs:created_at"), formatLogDate(log.createdAt, i18n.language)],
    [t("logs:actor"), `${log.actorEmail || "—"} (${log.actorType}${log.actorRole ? ` / ${log.actorRole}` : ""})`],
    [t("logs:actor_ip"), <span className="font-mono">{log.actorIp || "—"}</span>],
    [t("logs:method_path"), <span className="font-mono text-xs">{log.method} {log.path}</span>],
    [t("logs:action"), <span className="font-mono text-xs">{log.action}</span>],
    [t("logs:entity"), `${log.entityType || "—"}${log.entityId !== null ? ` #${log.entityId}` : ""}${log.entityLabel ? ` — ${log.entityLabel}` : ""}`],
    [t("logs:project"), log.projectId !== null ? `#${log.projectId}` : "—"],
    [t("logs:status"), `${log.statusCode ?? "—"} ${log.ok ? "OK" : "FAIL"}`],
  ];
  if (typeof meta.url === "string" && meta.url.length > 0) {
    rows.push([t("logs:url"), <span className="break-all font-mono text-xs">{meta.url}</span>]);
  }
  if (typeof meta.to === "string") {
    rows.push([t("logs:email_to"), <span className="break-all font-mono text-xs">{meta.to}</span>]);
  }
  if (typeof meta.subject === "string") {
    rows.push([t("logs:email_subject"), <span className="text-xs">{meta.subject}</span>]);
  }
  if (typeof meta.kind === "string") {
    rows.push([t("logs:kind"), <span className="font-mono text-xs">{meta.kind}</span>]);
  }
  if (meta.error && typeof meta.error === "object") {
    const errObj = meta.error as { code?: unknown; message?: unknown };
    rows.push([
      t("logs:error"),
      <span className="text-xs">
        {typeof errObj.code === "string" && errObj.code ? <span className="font-mono">[{errObj.code}] </span> : null}
        {typeof errObj.message === "string" ? errObj.message : "—"}
      </span>,
    ]);
  }
  if (meta.customer && typeof meta.customer === "object") {
    const cust = meta.customer as { status?: unknown; message?: unknown };
    rows.push([
      t("logs:customer_saw"),
      <span className="text-xs">
        <span className="font-mono">{typeof cust.status === "number" ? cust.status : "—"}</span>
        {" — "}
        {typeof cust.message === "string" ? cust.message : "—"}
      </span>,
    ]);
  }
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map(([label, value]) => (
          <React.Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {diff && (
        <div>
          <h4 className="mb-1 text-sm font-medium">{t("logs:changes")}</h4>
          <DiffTable diff={diff} />
        </div>
      )}
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">
          {t("logs:raw_metadata")}
        </summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
          {JSON.stringify(meta, null, 2)}
        </pre>
      </details>
    </div>
  );
}

const LogsPage: React.FC = () => {
  const { t, i18n } = useTranslation(["logs", "common"]);
  const [searchParams] = useSearchParams();

  const validAction = (v: string | null) => (v && v.length > 0 && v.length <= 120 ? v : undefined);
  const validEnum = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined =>
    v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

  const actionParam = validAction(searchParams.get("action"));
  const actionTypeParam = validEnum(searchParams.get("actionType"), ACTION_TYPES);
  const actorTypeParam = validEnum(searchParams.get("actorType"), ["admin", "enduser", "public", "system", "service"] as const);
  const projectIdParam = searchParams.get("projectId");
  const projectIdFilter =
    projectIdParam && /^\d+$/.test(projectIdParam) ? Number(projectIdParam) : undefined;

  const [actionType, setActionType] = useState<string>(actionTypeParam ?? "");
  const [action, setAction] = useState<string>(actionParam ?? "");
  const [actorType, setActorType] = useState<string>(actorTypeParam ?? "");
  const [actorEmail, setActorEmail] = useState<string>("");
  const [entityType, setEntityType] = useState<string>("");
  const [projectId, setProjectId] = useState<string>(
    projectIdFilter !== undefined ? String(projectIdFilter) : "",
  );
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selected, setSelected] = useState<LogDTO | null>(null);

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "createdAt",
    defaultSortOrder: "desc",
  });

  const { data: meta } = useQuery({
    queryKey: ["logs-meta"],
    queryFn: () => getLogsMeta(),
  });

  const fetchParams: GetLogsParams = {
    page: query.page,
    size: query.size,
    sortField: query.sortField,
    sortOrder: query.sortOrder,
    queries: query.queries,
    filterType: query.filterType,
    ...(actionType ? { actionType } : {}),
    ...(action ? { action } : {}),
    ...(actorType ? { actorType } : {}),
    ...(actorEmail ? { actorEmail } : {}),
    ...(entityType ? { entityType } : {}),
    ...(projectId && /^\d+$/.test(projectId) ? { projectId: Number(projectId) } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };

  const { data, isLoading } = useQuery<PageLogDTO>({
    queryKey: ["logs", query, actionType, action, actorType, actorEmail, entityType, projectId, dateFrom, dateTo],
    queryFn: () => getLogsPaged(fetchParams),
  });

  const handleSearch = useCallback(
    (q: string) => handlers.onQueriesChange(q ? [q] : []),
    [handlers],
  );

  const filterRow = useMemo(
    () => (
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          aria-label={t("logs:filter_action_type")}
          className="rounded border bg-background px-2 py-1 text-sm"
          value={actionType}
          onChange={(e) => setActionType(e.target.value)}
        >
          <option value="">{t("logs:all_action_types")}</option>
          {ACTION_TYPES.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          aria-label={t("logs:filter_action")}
          className="rounded border bg-background px-2 py-1 text-sm"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          <option value="">{t("logs:all_actions")}</option>
          {(meta?.actions ?? []).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          aria-label={t("logs:filter_actor_type")}
          className="rounded border bg-background px-2 py-1 text-sm"
          value={actorType}
          onChange={(e) => setActorType(e.target.value)}
        >
          <option value="">{t("logs:all_actors")}</option>
          {(meta?.actorTypes ?? []).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <input
          aria-label={t("logs:filter_actor_email")}
          className="rounded border bg-background px-2 py-1 text-sm"
          placeholder={t("logs:filter_actor_email")}
          value={actorEmail}
          onChange={(e) => setActorEmail(e.target.value)}
        />
        <select
          aria-label={t("logs:filter_entity_type")}
          className="rounded border bg-background px-2 py-1 text-sm"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
        >
          <option value="">{t("logs:all_entities")}</option>
          {(meta?.entityTypes ?? []).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <input
          aria-label={t("logs:filter_project")}
          className="w-28 rounded border bg-background px-2 py-1 text-sm"
          placeholder={t("logs:filter_project")}
          inputMode="numeric"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <input
          aria-label={t("logs:filter_date_from")}
          className="rounded border bg-background px-2 py-1 text-sm"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <input
          aria-label={t("logs:filter_date_to")}
          className="rounded border bg-background px-2 py-1 text-sm"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
      </div>
    ),
    [t, actionType, action, actorType, actorEmail, entityType, projectId, dateFrom, dateTo, meta],
  );

  const columns = [
    {
      accessorKey: "createdAt",
      header: t("logs:created_at"),
      cell: (row: LogDTO) => formatLogDate(row.createdAt, i18n.language),
      enableSorting: true,
    },
    {
      accessorKey: "actor",
      header: t("logs:actor"),
      cell: (row: LogDTO) => (
        <span className="flex flex-col gap-1">
          <span className="max-w-52 truncate text-xs">{row.actorEmail || "—"}</span>
          <Badge variant="outline" className="w-fit font-mono text-[10px]">
            {row.actorType}
          </Badge>
        </span>
      ),
    },
    {
      accessorKey: "action",
      header: t("logs:action"),
      cell: (row: LogDTO) => (
        <span className="font-mono text-xs">{row.action}</span>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "actionType",
      header: t("logs:action_type"),
      cell: (row: LogDTO) => (
        <Badge variant={actionTypeBadgeVariant(row.actionType)}>
          {row.actionType}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "entity",
      header: t("logs:entity"),
      cell: (row: LogDTO) =>
        row.entityType
          ? `${row.entityType}${row.entityId !== null ? ` #${row.entityId}` : ""}`
          : "—",
    },
    {
      accessorKey: "projectId",
      header: t("logs:project"),
      cell: (row: LogDTO) => (row.projectId !== null ? `#${row.projectId}` : "—"),
      enableSorting: true,
    },
    {
      accessorKey: "ok",
      header: t("logs:status"),
      cell: (row: LogDTO) => (
        <Badge variant={row.ok ? "default" : "destructive"}>
          {row.ok ? (row.statusCode ?? "OK") : (row.statusCode ?? "FAIL")}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: t("common:actions"),
      cell: (row: LogDTO) => (
        <Button variant="ghost" size="sm" onClick={() => setSelected(row)} aria-label={t("logs:view_details")}>
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ];

  return (
    <div className="container mx-auto p-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("logs:page_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {filterRow}
          <DataTable
            columns={columns}
            data={data?.content ?? []}
            isLoading={isLoading}
            pageInfo={data}
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={handleSearch}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField || "createdAt"}
            currentSortOrder={query.sortOrder || "desc"}
            onRowDoubleClick={setSelected}
          />
        </CardContent>
      </Card>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {selected ? `${selected.action} — #${selected.id}` : ""}
            </DialogTitle>
          </DialogHeader>
          {selected && <LogDetail log={selected} />}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default LogsPage;
