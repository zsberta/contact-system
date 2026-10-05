// ----------------------------------------------------------------------------
// ServerInfoPage — admin-only monitoring: Docker host (read-only proxy),
// in-app email queue + delivery stats, runtime, and row counts.
// Polls GET /api/server-info every 60s; the Refresh button forces a
// docker re-poll via ?refresh=1 (server floors it at 10s).
// Responsive: KPI grid collapses 4→2→(stacked tables scroll-x on mobile).
// ----------------------------------------------------------------------------

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  Boxes,
  CircleOff,
  Clock,
  Container,
  Cpu,
  Database,
  FileWarning,
  Gauge,
  HardDrive,
  Inbox,
  Layers,
  Mail,
  MemoryStick,
  RefreshCw,
  Send,
  Server,
  Timer,
  WifiOff,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import type { ServerInfoContainer, ServerInfoSnapshot } from "@/types/server-info";

// Full `docker inspect` payload (redacted env). Loosely typed: the Engine
// API adds fields across versions; sections below read defensively and
// fall back to the raw JSON view for anything unmapped.
interface ContainerInspect {
  Id: string;
  Name?: string;
  Created?: string;
  Path?: string;
  Args?: string[];
  Image?: string;
  RestartCount?: number;
  SizeRw?: number;
  SizeRootFs?: number;
  Driver?: string;
  Platform?: string;
  Config?: {
    Hostname?: string;
    User?: string;
    WorkingDir?: string;
    Entrypoint?: string[] | string | null;
    Cmd?: string[] | string | null;
    Image?: string;
    Env?: string[];
    Labels?: Record<string, string>;
  };
  HostConfig?: {
    RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
    Memory?: number;
    NanoCpus?: number;
    LogConfig?: { Type?: string; Config?: Record<string, string> };
    Binds?: string[];
  };
  State?: {
    Status?: string;
    Running?: boolean;
    Paused?: boolean;
    Restarting?: boolean;
    OOMKilled?: boolean;
    Pid?: number;
    ExitCode?: number;
    StartedAt?: string;
    FinishedAt?: string;
    Error?: string;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; Mode?: string; RW?: boolean }>;
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
    Networks?: Record<string, { IPAddress?: string; MacAddress?: string; Gateway?: string }>;
  };
}
function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let x = n;
  let u = -1;
  do {
    x /= 1024;
    u += 1;
  } while (x >= 1024 && u < units.length - 1);
  return `${x.toFixed(x >= 100 ? 0 : 1)} ${units[u]}`;
}

function formatUptime(totalSec: number): string {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDateTime(iso: string | null, lang: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(lang);
}

function containerStateVariant(state: string): "default" | "secondary" | "outline" | "destructive" {
  if (state === "running") return "default";
  if (state === "exited" || state === "created") return "secondary";
  if (state === "paused" || state === "dead" || state === "removing") return "destructive";
  return "outline";
}

function Bar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded bg-muted">
      <div className="h-2 rounded bg-primary" style={{ width: `${clamped}%` }} />
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-medium">{value}</div>
      {sub ? <div className="text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

// Join a docker Entrypoint/Cmd (array or bare string) for display.
function joinCommand(cmd: string[] | string | null | undefined): string {
  if (Array.isArray(cmd)) return cmd.join(" ");
  if (typeof cmd === "string") return cmd;
  return "";
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 text-sm sm:grid-cols-[170px_1fr]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-2 text-sm font-medium">{title}</h4>
      <dl className="flex flex-col gap-1">{children}</dl>
    </div>
  );
}

function ContainerDetail({ detail, t, lang }: { detail: ContainerInspect; t: (k: string) => string; lang: string }) {
  const cfg = detail.Config ?? {};
  const hostCfg = detail.HostConfig ?? {};
  const state = detail.State ?? {};
  const nets = detail.NetworkSettings ?? {};
  const env = Array.isArray(cfg.Env) ? cfg.Env : [];
  const labels = cfg.Labels && typeof cfg.Labels === "object" ? Object.entries(cfg.Labels) : [];
  const mounts = Array.isArray(detail.Mounts) ? detail.Mounts : [];
  const ports = nets.Ports && typeof nets.Ports === "object" ? Object.entries(nets.Ports) : [];
  const networks = nets.Networks && typeof nets.Networks === "object" ? Object.entries(nets.Networks) : [];
  const none = t("server-info:detail_none");
  const bool = (v: boolean | undefined) => (v ? t("server-info:detail_yes") : t("server-info:detail_no"));
  const entrypoint = joinCommand(cfg.Entrypoint);
  const cmd = joinCommand(cfg.Cmd);
  const started = typeof state.StartedAt === "string" && !state.StartedAt.startsWith("0001-01-01") ? state.StartedAt : null;
  const finished = typeof state.FinishedAt === "string" && !state.FinishedAt.startsWith("0001-01-01") ? state.FinishedAt : null;
  return (
    <div className="flex flex-col gap-5">
      <Section title={t("server-info:detail_overview")}>
        <DetailRow label={t("server-info:detail_id")}>
          <span className="break-all font-mono text-xs">{detail.Id}</span>
        </DetailRow>
        <DetailRow label={t("server-info:name")}>
          <span className="font-mono text-xs">{typeof detail.Name === "string" ? detail.Name.replace(/^\//, "") : none}</span>
        </DetailRow>
        <DetailRow label={t("server-info:detail_image")}>
          <span className="break-all font-mono text-xs">{typeof detail.Image === "string" ? detail.Image : (cfg.Image ?? none)}</span>
        </DetailRow>
        <DetailRow label={t("server-info:created")}>{formatDateTime(detail.Created ?? null, lang)}</DetailRow>
        <DetailRow label={t("server-info:detail_restarts")}>{detail.RestartCount ?? 0}</DetailRow>
        <DetailRow label={t("server-info:detail_restart")}>
          {hostCfg.RestartPolicy?.Name ?? none}
          {typeof hostCfg.RestartPolicy?.MaximumRetryCount === "number" && hostCfg.RestartPolicy.MaximumRetryCount > 0
            ? ` (${hostCfg.RestartPolicy.MaximumRetryCount})`
            : null}
        </DetailRow>
        <DetailRow label={t("server-info:detail_log")}>
          <span className="font-mono text-xs">{hostCfg.LogConfig?.Type ?? none}</span>
        </DetailRow>
      </Section>
      <Section title={t("server-info:detail_state")}>
        <DetailRow label={t("server-info:state")}>
          <Badge variant={containerStateVariant(state.Status ?? "")}>{state.Status ?? none}</Badge>
        </DetailRow>
        <DetailRow label={t("server-info:detail_pid")}>{state.Pid ?? none}</DetailRow>
        <DetailRow label={t("server-info:detail_started")}>{formatDateTime(started, lang)}</DetailRow>
        <DetailRow label={t("server-info:detail_finished")}>{formatDateTime(finished, lang)}</DetailRow>
        <DetailRow label={t("server-info:detail_exit")}>{state.ExitCode ?? none}</DetailRow>
        <DetailRow label={t("server-info:detail_oom")}>{bool(state.OOMKilled)}</DetailRow>
        {state.Error ? (
          <DetailRow label={t("server-info:error")}>
            <span className="break-all font-mono text-xs text-red-500">{state.Error}</span>
          </DetailRow>
        ) : null}
      </Section>
      <Section title={t("server-info:detail_config")}>
        <DetailRow label={t("server-info:detail_command")}>
          <span className="break-all font-mono text-xs">{[detail.Path, ...(detail.Args ?? [])].filter(Boolean).join(" ") || cmd || entrypoint || none}</span>
        </DetailRow>
        <DetailRow label={t("server-info:detail_workdir")}>
          <span className="font-mono text-xs">{cfg.WorkingDir || none}</span>
        </DetailRow>
        <DetailRow label={t("server-info:detail_user")}>
          <span className="font-mono text-xs">{cfg.User || none}</span>
        </DetailRow>
        {typeof hostCfg.Memory === "number" && hostCfg.Memory > 0 ? (
          <DetailRow label={t("server-info:memory")}><span className="font-mono text-xs">{formatBytes(hostCfg.Memory)}</span></DetailRow>
        ) : null}
        {typeof hostCfg.NanoCpus === "number" && hostCfg.NanoCpus > 0 ? (
          <DetailRow label={t("server-info:cpu")}><span className="font-mono text-xs">{hostCfg.NanoCpus / 1e9}</span></DetailRow>
        ) : null}
        {labels.length > 0 ? (
          <DetailRow label="Labels">
            <ul className="flex flex-col gap-1">
              {labels.map(([k, v]) => (
                <li key={k} className="break-all font-mono text-xs text-muted-foreground">
                  {k}={v}
                </li>
              ))}
            </ul>
          </DetailRow>
        ) : null}
      </Section>
      <Section title={t("server-info:detail_network")}>
        {ports.length === 0 && networks.length === 0 ? (
          <DetailRow label={t("server-info:detail_ports")}>{none}</DetailRow>
        ) : null}
        {ports.length > 0 ? (
          <DetailRow label={t("server-info:detail_ports")}>
            <ul className="flex flex-col gap-1">
              {ports.map(([containerPort, bindings]) => (
                <li key={containerPort} className="font-mono text-xs">
                  {containerPort} → {Array.isArray(bindings) && bindings.length > 0 ? bindings.map((b) => `${b?.HostIp ?? ""}:${b?.HostPort ?? ""}`).join(", ") : none}
                </li>
              ))}
            </ul>
          </DetailRow>
        ) : null}
        {networks.map(([netName, net]) => (
          <DetailRow key={netName} label={netName}>
            <span className="font-mono text-xs">
              {t("server-info:detail_ip")}: {net?.IPAddress || none} · {t("server-info:detail_mac")}: {net?.MacAddress || none}
            </span>
          </DetailRow>
        ))}
      </Section>
      <Section title={t("server-info:detail_storage")}>
        <DetailRow label={t("server-info:detail_writable")}>
          <span className="font-mono text-xs">{typeof detail.SizeRw === "number" ? formatBytes(detail.SizeRw) : none}</span>
        </DetailRow>
        <DetailRow label={t("server-info:detail_total")}>
          <span className="font-mono text-xs">{typeof detail.SizeRootFs === "number" ? formatBytes(detail.SizeRootFs) : none}</span>
        </DetailRow>
        <DetailRow label={t("server-info:detail_shared")}>
          <span className="font-mono text-xs">
            {typeof detail.SizeRw === "number" && typeof detail.SizeRootFs === "number"
              ? formatBytes(detail.SizeRootFs - detail.SizeRw)
              : none}
          </span>
        </DetailRow>
        <p className="text-xs text-muted-foreground">{t("server-info:detail_storage_hint")}</p>
      </Section>
      <Section title={t("server-info:detail_mounts")}>
        {mounts.length === 0 ? (
          <DetailRow label={t("server-info:detail_mounts")}>{none}</DetailRow>
        ) : (
          mounts.map((m, i) => (
            <DetailRow key={`${m?.Destination}-${i}`} label={m?.Destination || m?.Source || `#${i + 1}`}>
              <span className="break-all font-mono text-xs text-muted-foreground">
                {m?.Source ?? none} ({m?.Mode ?? (m?.RW ? "rw" : "ro")})
              </span>
            </DetailRow>
          ))
        )}
      </Section>
      <Section title={`${t("server-info:detail_env")} — ${t("server-info:detail_redacted")}`}>
        {env.length === 0 ? (
          <DetailRow label={t("server-info:detail_env")}>{none}</DetailRow>
        ) : (
          <ul className="flex max-h-64 flex-col gap-1 overflow-auto rounded bg-muted p-2">
            {env.map((entry, i) => (
              <li key={`${entry.slice(0, 40)}-${i}`} className="break-all font-mono text-xs">
                {entry}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <details>
        <summary className="cursor-pointer text-sm text-muted-foreground">{t("server-info:detail_raw")}</summary>
        <pre className="mt-1 max-h-96 overflow-auto rounded bg-muted p-2 font-mono text-xs">
          {JSON.stringify(detail, null, 2)}
        </pre>
      </details>
    </div>
  );
}

const ServerInfoPage: React.FC = () => {
  const { t, i18n } = useTranslation(["server-info", "common"]);
  const lang = i18n.language || "hu";
  // Nonzero nonce = this query (and later auto-refetches) carry ?refresh=1,
  // forcing a docker re-poll. Server floors re-polls at 10s.
  const [nonce, setNonce] = useState(0);
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["server-info", nonce],
    queryFn: () =>
      apiFetch<ServerInfoSnapshot>(nonce === 0 ? "/server-info" : "/server-info?refresh=1"),
    retry: false,
    refetchInterval: 60_000,
  });

  const emailRaw = data?.email;
  const email = emailRaw && !("error" in emailRaw) ? emailRaw : null;
  const emailError = emailRaw && "error" in emailRaw ? emailRaw.error : null;
  const tablesRaw = data?.tables;
  const tables = tablesRaw && !("error" in tablesRaw) ? tablesRaw : null;
  const docker = data?.docker;
  const running = docker?.containers?.filter((c) => c.state === "running").length ?? null;
  // Clicked container → detail dialog. Full 64-char id preferred, the
  // list only carries the 12-char prefix (enough for the daemon too).
  const [selected, setSelected] = useState<ServerInfoContainer | null>(null);
  const {
    data: inspect,
    isLoading: inspectLoading,
    error: inspectError,
  } = useQuery({
    queryKey: ["server-info", "container", selected?.id],
    queryFn: () => apiFetch<ContainerInspect>(`/server-info/containers/${selected!.id}`),
    enabled: selected !== null,
    retry: false,
    refetchInterval: false,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Server className="h-5 w-5" />
            {t("server-info:page_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("server-info:page_description")}</p>
          {data ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {t("server-info:collected_at")}: {formatDateTime(data.collectedAt, lang)}
            </p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setNonce((n) => n + 1)}
          disabled={isLoading || isFetching}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          {isFetching ? t("server-info:refreshing") : t("server-info:refresh")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t("server-info:auto_note")}</p>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common:loading")}</div>
      ) : error || !data ? (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            {t("server-info:unavailable")}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ===== Overview KPIs ===== */}
          <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  {t("server-info:uptime")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatUptime(data.app.uptimeSec)}</div>
                <p className="text-xs text-muted-foreground">
                  {data.app.env} · {data.app.nodeVersion}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Inbox className="h-4 w-4 text-muted-foreground" />
                  {t("server-info:queue_depth")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {email ? email.queue.pending + email.queue.inFlight : "—"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {email
                    ? t("server-info:sent_24h", { count: email.sent24h })
                    : t("server-info:unavailable")}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <Container className="h-4 w-4 text-muted-foreground" />
                  {t("server-info:containers_running")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {running !== null && docker?.containers ? `${running}/${docker.containers.length}` : "—"}
                </div>
                <p className="text-xs text-muted-foreground">
                  {docker?.engine?.serverVersion
                    ? `Docker ${docker.engine.serverVersion}`
                    : t("server-info:host_unavailable")}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <CircleOff className="h-4 w-4 text-muted-foreground" />
                  {t("server-info:errors_24h")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{tables?.errors24h ?? "—"}</div>
                <p className="text-xs text-muted-foreground">
                  <Link to="/logs" className="underline underline-offset-4">
                    {t("server-info:view_logs")}
                  </Link>
                </p>
              </CardContent>
            </Card>
          </div>

          {/* ===== Docker host ===== */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Container className="h-5 w-5" />
                {t("server-info:docker_host")}
              </CardTitle>
              <CardDescription>
                {docker?.lastPollAt
                  ? `${t("server-info:last_poll")}: ${formatDateTime(docker.lastPollAt, lang)}`
                  : t("server-info:host_unavailable")}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!docker?.configured ? (
                <div className="rounded-md border border-dashed p-4 text-sm">
                  <p className="flex items-center gap-2 font-medium">
                    <WifiOff className="h-4 w-4" />
                    {t("server-info:not_configured_title")}
                  </p>
                  <p className="mt-1 text-muted-foreground">{t("server-info:not_configured_body")}</p>
                </div>
              ) : (
                <>
                  {docker.lastError ? (
                    <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                      {t("server-info:poll_error")}: {docker.lastError}
                    </p>
                  ) : null}
                  {docker.engine ? (
                    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                      <Stat label={t("server-info:engine")} value={docker.engine.serverVersion ?? "—"} sub={docker.engine.operatingSystem ?? undefined} />
                      <Stat label={t("server-info:cpu")} value={docker.engine.ncpu ?? "—"} sub={docker.engine.architecture ?? undefined} />
                      <Stat label={t("server-info:memory")} value={formatBytes(docker.engine.memTotalBytes)} sub={docker.engine.kernelVersion ?? undefined} />
                      <Stat label={t("server-info:images")} value={docker.engine.imagesTotal ?? "—"} sub={docker.engine.containersTotal !== null ? t("server-info:containers_total", { count: docker.engine.containersTotal }) : undefined} />
                    </div>
                  ) : null}
                  {docker.containers ? (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead>
                          <tr className="border-b text-left text-xs text-muted-foreground">
                            <th className="py-2 pr-3 font-medium">{t("server-info:name")}</th>
                            <th className="py-2 pr-3 font-medium">{t("server-info:image")}</th>
                            <th className="py-2 pr-3 font-medium">{t("server-info:state")}</th>
                            <th className="py-2 pr-3 font-medium">{t("server-info:status")}</th>
                            <th className="py-2 pr-3 text-right font-medium">{t("server-info:size")}</th>
                            <th className="py-2 font-medium">{t("server-info:created")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {docker.containers.map((c) => (
                            <tr key={c.id} className="border-b align-top last:border-0">
                              <td className="py-2 pr-3 font-mono text-xs">
                                <button
                                  type="button"
                                  onClick={() => setSelected(c)}
                                  className="text-left text-primary underline underline-offset-4 hover:opacity-80"
                                  title={c.id}
                                >
                                  {c.names.length > 0 ? c.names.join(", ") : c.id}
                                </button>
                              </td>
                              <td className="max-w-[240px] truncate py-2 pr-3 text-xs text-muted-foreground" title={c.image}>
                                {c.image}
                              </td>
                              <td className="py-2 pr-3">
                                <Badge variant={containerStateVariant(c.state)}>{c.state}</Badge>
                              </td>
                              <td className="max-w-[220px] truncate py-2 pr-3 text-xs text-muted-foreground" title={c.status}>
                                {c.status || "—"}
                              </td>
                              <td
                                className="whitespace-nowrap py-2 pr-3 text-right text-xs tabular-nums text-muted-foreground"
                                title={c.sizeRwBytes !== null && c.sizeRootFsBytes !== null ? t("server-info:size_title", { writable: formatBytes(c.sizeRwBytes), total: formatBytes(c.sizeRootFsBytes) }) : undefined}
                              >
                                {c.sizeRwBytes !== null ? formatBytes(c.sizeRwBytes) : "—"}
                              </td>
                              <td className="whitespace-nowrap py-2 text-xs text-muted-foreground">
                                {formatDateTime(c.createdAt, lang)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                  {docker.diskUsage ? (
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      {(
                        [
                          { label: t("server-info:images"), part: docker.diskUsage.images },
                          { label: t("server-info:containers"), part: docker.diskUsage.containers },
                          { label: t("server-info:volumes"), part: docker.diskUsage.volumes },
                          { label: t("server-info:build_cache"), part: docker.diskUsage.buildCache },
                        ] as const
                      ).map(({ label, part }) => (
                        <div key={label} className="rounded-md border p-3">
                          <div className="text-xs text-muted-foreground">{label}</div>
                          <div className="text-lg font-semibold">{formatBytes(part.totalBytes)}</div>
                          <div className="text-xs text-muted-foreground">
                            {t("server-info:items_count", { count: part.count })}
                          </div>
                        </div>
                      ))}
                      <div className="rounded-md border p-3 sm:col-span-2 lg:col-span-4">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{t("server-info:reclaimable")}</span>
                          <span className="text-sm font-semibold">{formatBytes(docker.diskUsage.reclaimableBytes)}</span>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          {/* ===== Email ===== */}
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Mail className="h-5 w-5" />
                {t("server-info:email")}
                {email ? (
                  <Badge variant={email.sendingEnabled ? "default" : "destructive"}>
                    {email.transport === "smtp"
                      ? t("server-info:transport_smtp")
                      : email.transport === "disabled"
                        ? t("server-info:transport_disabled")
                        : t("server-info:transport_dev")}
                  </Badge>
                ) : null}
              </CardTitle>
              {emailError ? (
                <CardDescription>{emailError}</CardDescription>
              ) : (
                <CardDescription>
                  {email
                    ? t("server-info:sent_failed_24h", { sent: email.sent24h, failed: email.failed24h })
                    : null}
                </CardDescription>
              )}
            </CardHeader>
            {email ? (
              <CardContent className="space-y-6">
                <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
                  <Stat label={t("server-info:queue_pending")} value={email.queue.pending} />
                  <Stat label={t("server-info:queue_inflight")} value={email.queue.inFlight} />
                  <Stat label={t("server-info:queue_tokens")} value={`${email.queue.tokensAvailable}/${email.queue.burstCapacity}`} />
                  <Stat label={t("server-info:queue_refill")} value={`${email.queue.refillIntervalMs} ms`} />
                  <Stat label={t("server-info:queue_attempts")} value={email.queue.maxAttempts} />
                  <Stat
                    label={t("server-info:failed_24h")}
                    value={email.failed24h}
                  />
                </div>
                {email.byKind7d.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="border-b text-left text-xs text-muted-foreground">
                          <th className="py-2 pr-3 font-medium">{t("server-info:kind")}</th>
                          <th className="py-2 pr-3 text-right font-medium">{t("server-info:total")}</th>
                          <th className="py-2 pr-3 text-right font-medium">{t("server-info:delivered")}</th>
                          <th className="py-2 pr-3 text-right font-medium">{t("server-info:failed")}</th>
                          <th className="w-[160px] py-2 font-medium">{t("server-info:rate")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {email.byKind7d.map((row) => (
                          <tr key={row.kind} className="border-b last:border-0">
                            <td className="py-2 pr-3 font-mono text-xs">{row.kind}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.total}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.delivered}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{row.failed}</td>
                            <td className="py-2">
                              <Bar pct={row.total > 0 ? (row.delivered / row.total) * 100 : 0} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-xs text-muted-foreground">{t("server-info:by_kind_7d")}</p>
                  </div>
                ) : null}
                <div>
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                    <FileWarning className="h-4 w-4 text-muted-foreground" />
                    {t("server-info:recent_failures")}
                  </h3>
                  {email.recentFailures.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("server-info:no_failures")}</p>
                  ) : (
                    <ul className="space-y-2">
                      {email.recentFailures.map((f, i) => (
                        <li key={`${f.createdAt}-${i}`} className="rounded-md border p-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="break-all font-mono text-xs">{f.recipient ?? "—"}</span>
                            <span className="text-xs text-muted-foreground">
                              {formatDateTime(f.createdAt, lang)}
                            </span>
                          </div>
                          <div className="mt-1 truncate text-xs" title={f.subject ?? undefined}>
                            {f.subject ?? "—"}
                          </div>
                          {f.error ? (
                            <div className="mt-1 break-all font-mono text-xs text-red-500">{f.error}</div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
            ) : null}
          </Card>

          {/* ===== Runtime + data ===== */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" />
                  {t("server-info:runtime")}
                </CardTitle>
                <CardDescription>
                  {data.app.platform}/{data.app.arch} · {data.app.hostname}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <Stat
                    label={t("server-info:cpu")}
                    value={data.app.cpuCount ?? "—"}
                    sub={`${t("server-info:load_avg")}: ${data.app.loadAvg.map((v) => v.toFixed(2)).join(" / ")}`}
                  />
                  <Stat
                    label={t("server-info:event_loop_lag")}
                    value={data.app.eventLoopLagMs !== null ? `${data.app.eventLoopLagMs} ms` : "—"}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <MemoryStick className="h-3 w-3" />
                      {t("server-info:memory")}
                    </span>
                    <span>
                      {formatBytes(data.app.memTotalBytes - data.app.memFreeBytes)} /{" "}
                      {formatBytes(data.app.memTotalBytes)}
                    </span>
                  </div>
                  <Bar pct={((data.app.memTotalBytes - data.app.memFreeBytes) / data.app.memTotalBytes) * 100} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Stat label="RSS" value={formatBytes(data.app.processMemory.rss)} />
                  <Stat label={t("server-info:heap_used")} value={formatBytes(data.app.processMemory.heapUsed)} sub={`${t("server-info:heap_total")}: ${formatBytes(data.app.processMemory.heapTotal)}`} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Stat
                    label={t("server-info:db_status")}
                    value={
                      data.app.db.ok ? (
                        <Badge variant="default">up</Badge>
                      ) : (
                        <Badge variant="destructive">down</Badge>
                      )
                    }
                    sub={
                      data.app.db.ok
                        ? `${t("server-info:db_latency")}: ${data.app.db.latencyMs} ms`
                        : (data.app.db.error ?? undefined)
                    }
                  />
                  <Stat
                    label={t("server-info:db_pool")}
                    value={`${data.app.db.pool.total}/${data.app.db.pool.max}`}
                    sub={`idle ${data.app.db.pool.idle} · wait ${data.app.db.pool.waiting}`}
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <HardDrive className="h-3 w-3" />
                      {t("server-info:disk_root")}
                    </span>
                    <span>
                      {data.app.disk?.root?.error
                        ? t("server-info:unavailable")
                        : `${formatBytes(data.app.disk?.root?.usedBytes)} / ${formatBytes(data.app.disk?.root?.totalBytes)} · ${formatBytes(data.app.disk?.root?.availableBytes)} ${t("server-info:disk_free")}`}
                    </span>
                  </div>
                  <Bar pct={data.app.disk?.root?.usePct ?? 0} />
                  {data.app.disk && data.app.disk.uploadsMount.target !== data.app.disk.root.target ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("server-info:disk_uploads_mount")}: {formatBytes(data.app.disk.uploadsMount.usedBytes)} /{" "}
                      {formatBytes(data.app.disk.uploadsMount.totalBytes)} ·{" "}
                      {formatBytes(data.app.disk.uploadsMount.availableBytes)} {t("server-info:disk_free")}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">{t("server-info:disk_hint")}</p>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <Stat
                    label={t("server-info:uploads")}
                    value={formatBytes(data.app.uploads.totalBytes)}
                    sub={t("server-info:files_count", { count: data.app.uploads.fileCount })}
                  />
                  <Stat
                    label={t("server-info:db_latency")}
                    value={<span className="flex items-center gap-1"><Timer className="h-3 w-3" />{data.app.db.ok ? `${data.app.db.latencyMs} ms` : "—"}</span>}
                    sub={<span className="flex items-center gap-1"><Gauge className="h-3 w-3" />{t("server-info:event_loop_lag")}: {data.app.eventLoopLagMs ?? "—"} ms</span>}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Database className="h-5 w-5" />
                  {t("server-info:row_counts")}
                </CardTitle>
                <CardDescription>{t("server-info:row_counts_hint")}</CardDescription>
              </CardHeader>
              <CardContent>
                {tables ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {(
                      [
                        { label: t("server-info:users"), value: tables.users },
                        { label: t("server-info:projects"), value: tables.projects },
                        { label: t("server-info:forms"), value: tables.forms },
                        { label: t("server-info:submissions"), value: tables.formSubmissions },
                        { label: t("server-info:reservations"), value: tables.reservations },
                        { label: t("server-info:bookings"), value: tables.bookings },
                        { label: t("server-info:upcoming"), value: tables.upcomingBookings },
                        { label: t("server-info:customers"), value: tables.customers },
                        { label: t("server-info:activity_logs"), value: tables.activityLogs },
                        { label: t("server-info:errors"), value: tables.errors24h },
                      ] as const
                    ).map(({ label, value }) => (
                      <div key={label} className="rounded-md border p-3">
                        <div className="truncate text-xs text-muted-foreground" title={label}>{label}</div>
                        <div className="text-lg font-semibold tabular-nums">{value.toLocaleString(lang)}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("server-info:unavailable")}</p>
                )}
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <Send className="h-3 w-3" /> {t("server-info:hint_queue")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Boxes className="h-3 w-3" /> {t("server-info:hint_docker")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Layers className="h-3 w-3" /> {t("server-info:hint_tables")}
                  </span>
                  <span className="flex items-center gap-1">
                    <HardDrive className="h-3 w-3" /> {t("server-info:hint_uploads")}
                  </span>
                  <span className="flex items-center gap-1">
                    <Cpu className="h-3 w-3" /> {t("server-info:hint_runtime")}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
      <Dialog open={selected !== null} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Container className="h-5 w-5" />
              {t("server-info:container_detail")}
              {selected ? (
                <span className="font-mono text-xs text-muted-foreground">
                  {selected.names.length > 0 ? selected.names.join(", ") : selected.id}
                </span>
              ) : null}
            </DialogTitle>
          </DialogHeader>
          {selected === null ? null : inspectLoading ? (
            <p className="text-sm text-muted-foreground">{t("server-info:container_loading")}</p>
          ) : inspectError || !inspect ? (
            <p className="text-sm text-muted-foreground">{t("server-info:container_unavailable")}</p>
          ) : (
            <ContainerDetail detail={inspect} t={(k: string) => t(k)} lang={lang} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default ServerInfoPage;
