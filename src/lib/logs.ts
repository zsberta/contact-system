import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page } from "@/types/common";
import type { GetLogsParams, LogDTO, LogsMetaDTO, PageLogDTO } from "@/types/log";

export const getLogsPaged = (params: GetLogsParams = {}): Promise<PageLogDTO> => {
  return apiFetch<PageLogDTO>(`/logs?${buildQueryString(params)}`);
};

export const getLogById = (id: number): Promise<LogDTO> => {
  return apiFetch<LogDTO>(`/logs/${id}`);
};

export const getLogsMeta = (): Promise<LogsMetaDTO> => {
  return apiFetch<LogsMetaDTO>("/logs/meta");
};

export type { GetLogsParams, LogDTO, LogsMetaDTO, PageLogDTO };
