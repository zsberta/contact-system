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
import { useIsMobile } from "@/hooks/use-mobile";

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

// Ultra-compact timestamp for small screens: "11.09 22:15" style, no seconds.
function formatLogDateCompact(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${min}`;
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
    <div className="flex flex-col gap-2 sm:gap-3">
      <dl className="grid grid-cols-[96px_1fr] gap-x-2 gap-y-1 text-xs sm:grid-cols-[140px_1fr] sm:gap-x-3 sm:text-sm">
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
  const { t } = useTranslation(["logs", "common"]);
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();

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
  const [statusCode, setStatusCode] = useState<string>("");
  const [projectId, setProjectId] = useState<string>(
    projectIdFilter !== undefined ? String(projectIdFilter) : "",
  );
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [selected, setSelected] = useState<LogDTO | null>(null);

  const { query, handlers } = useDataTableQuery({
    defaultSize: 100,
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
    ...(statusCode && /^\d+$/.test(statusCode) ? { statusCode: Number(statusCode) } : {}),
    ...(projectId && /^\d+$/.test(projectId) ? { projectId: Number(projectId) } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };

  const { data, isLoading } = useQuery<PageLogDTO>({
    queryKey: ["logs", query, actionType, action, actorType, actorEmail, entityType, statusCode, projectId, dateFrom, dateTo],
    queryFn: () => getLogsPaged(fetchParams),
  });

  const handleSearch = useCallback(
    (q: string) => handlers.onQueriesChange(q ? [q] : []),
    [handlers],
  );

  const filterRow = useMemo(
    () => (
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5 sm:mb-3 sm:gap-2">
        <select
          aria-label={t("logs:filter_action_type")}
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
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
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
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
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
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
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
          placeholder={t("logs:filter_actor_email")}
          value={actorEmail}
          onChange={(e) => setActorEmail(e.target.value)}
        />
        <select
          aria-label={t("logs:filter_entity_type")}
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
        >
          <option value="">{t("logs:all_entities")}</option>
          {(meta?.entityTypes ?? []).map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select
          aria-label={t("logs:filter_status")}
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
          value={statusCode}
          onChange={(e) => setStatusCode(e.target.value)}
        >
          <option value="">{t("logs:all_statuses")}</option>
          {(meta?.statusCodes ?? []).map((v) => (
            <option key={v} value={String(v)}>{v}</option>
          ))}
        </select>
        <input
          aria-label={t("logs:filter_project")}
          className="w-20 rounded border bg-background px-1.5 py-1 text-xs sm:w-28 sm:px-2 sm:text-sm"
          placeholder={t("logs:filter_project")}
          inputMode="numeric"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
        <input
          aria-label={t("logs:filter_date_from")}
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
          type="date"
          value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)}
        />
        <input
          aria-label={t("logs:filter_date_to")}
          className="rounded border bg-background px-1.5 py-1 text-xs sm:px-2 sm:text-sm"
          type="date"
          value={dateTo}
          onChange={(e) => setDateTo(e.target.value)}
        />
      </div>
    ),
    [t, actionType, action, actorType, actorEmail, entityType, statusCode, projectId, dateFrom, dateTo, meta],
  );

  const columns = useMemo(() => {
    // Mobile: 4 narrow columns that fit without horizontal scrolling.
    // Actor / entity / project stay reachable via the detail dialog.
    if (isMobile) {
      return [
        {
          accessorKey: "createdAt",
          header: t("logs:created_at"),
          cell: (row: LogDTO) => (
            <span className="whitespace-nowrap font-mono text-[11px] leading-tight">
              {formatLogDateCompact(row.createdAt)}
            </span>
          ),
          enableSorting: true,
        },
        {
          accessorKey: "action",
          header: t("logs:action"),
          cell: (row: LogDTO) => (
            <span className="flex min-w-0 flex-col items-start gap-0.5">
              <span className="max-w-28 truncate font-mono text-[11px] leading-tight">{row.action}</span>
              <Badge variant={actionTypeBadgeVariant(row.actionType)} className="px-1 py-0 font-mono text-[10px] leading-tight">
                {row.actionType}
              </Badge>
            </span>
          ),
          enableSorting: true,
        },
        {
          accessorKey: "statusCode",
          header: t("logs:status"),
          cell: (row: LogDTO) => (
            <Badge variant={row.ok ? "default" : "destructive"} className="px-1.5 py-0 text-[10px] leading-tight">
              {row.ok ? (row.statusCode ?? "OK") : (row.statusCode ?? "FAIL")}
            </Badge>
          ),
          enableSorting: true,
        },
        {
          id: "actions",
          header: t("common:actions"),
          cell: (row: LogDTO) => (
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setSelected(row)} aria-label={t("logs:view_details")}>
              <Eye className="h-3.5 w-3.5" />
            </Button>
          ),
        },
      ];
    }
    // Compact on all screens: small mono text, truncated cells, tight badges.
    return [
      {
        accessorKey: "createdAt",
        header: t("logs:created_at"),
        cell: (row: LogDTO) => (
          <span className="whitespace-nowrap font-mono text-[11px] leading-tight">
            {formatLogDateCompact(row.createdAt)}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: "actor",
        header: t("logs:actor"),
        cell: (row: LogDTO) => (
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            <span className="block max-w-36 truncate text-[11px] leading-tight" title={row.actorEmail || undefined}>{row.actorEmail || "—"}</span>
            <Badge variant="outline" className="px-1 py-0 font-mono text-[10px] leading-tight">
              {row.actorType}
            </Badge>
          </span>
        ),
      },
      {
        accessorKey: "action",
        header: t("logs:action"),
        cell: (row: LogDTO) => (
          <span className="block max-w-36 truncate font-mono text-[11px] leading-tight" title={row.action}>{row.action}</span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: "actionType",
        header: t("logs:action_type"),
        cell: (row: LogDTO) => (
          <Badge variant={actionTypeBadgeVariant(row.actionType)} className="px-1.5 py-0 text-[10px] leading-tight">
            {row.actionType}
          </Badge>
        ),
        enableSorting: true,
      },
      {
        accessorKey: "entity",
        header: t("logs:entity"),
        cell: (row: LogDTO) => {
          const label = row.entityType
            ? `${row.entityType}${row.entityId !== null ? ` #${row.entityId}` : ""}`
            : "—";
          return (
            <span className="block max-w-28 truncate font-mono text-[11px] leading-tight" title={label}>{label}</span>
          );
        },
      },
      {
        accessorKey: "projectId",
        header: t("logs:project"),
        cell: (row: LogDTO) => (
          <span className="whitespace-nowrap font-mono text-[11px] leading-tight">
            {row.projectId !== null ? `#${row.projectId}` : "—"}
          </span>
        ),
        enableSorting: true,
      },
      {
        accessorKey: "statusCode",
        header: t("logs:status"),
        cell: (row: LogDTO) => (
          <Badge variant={row.ok ? "default" : "destructive"} className="px-1.5 py-0 text-[10px] leading-tight">
            {row.ok ? (row.statusCode ?? "OK") : (row.statusCode ?? "FAIL")}
          </Badge>
        ),
        enableSorting: true,
      },
      {
        id: "actions",
        header: t("common:actions"),
        cell: (row: LogDTO) => (
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setSelected(row)} aria-label={t("logs:view_details")}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
        ),
      },
    ];
  }, [t, isMobile]);

  return (
    <div className="w-full px-0 sm:container sm:mx-auto sm:p-4">
      <Card className="rounded-md sm:rounded-lg">
        <CardHeader className="px-2 py-2.5 sm:p-6">
          <CardTitle className="text-base sm:text-2xl">{t("logs:page_title")}</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2.5 pt-0 sm:p-6 sm:pt-0">
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
            defaultPageSize={100}
            pageSizeOptions={[100, 250, 500, 1000]}
          />
        </CardContent>
      </Card>
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] overflow-y-auto px-3 py-4 sm:max-w-2xl sm:p-6">
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
