import type { Page, QueryParams } from "@/types/common";

export type LogActionType = "CREATE" | "READ" | "UPDATE" | "DELETE" | "SEND" | "ERROR";
export type LogActorType = "admin" | "enduser" | "public" | "system" | "service";

export interface LogDTO {
  id: number;
  createdAt: string | null;
  actorType: LogActorType;
  actorUserId: number | null;
  actorEmail: string | null;
  actorRole: string | null;
  actorIp: string | null;
  method: string;
  path: string;
  action: string;
  actionType: LogActionType;
  entityType: string | null;
  entityId: number | null;
  entityLabel: string | null;
  projectId: number | null;
  statusCode: number | null;
  ok: boolean;
  metadata: Record<string, unknown>;
}

export type PageLogDTO = Page<LogDTO>;

export interface LogsMetaDTO {
  actions: string[];
  entityTypes: string[];
  actorTypes: string[];
}

export interface GetLogsParams extends QueryParams {
  actionType?: string;
  action?: string;
  actorType?: string;
  actorEmail?: string;
  entityType?: string;
  entityId?: number;
  projectId?: number;
  method?: string;
  dateFrom?: string;
  dateTo?: string;
}
