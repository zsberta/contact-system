// FE lib for the Analytics module. Mirrors src/lib/forms.ts shape.
// All calls go through apiFetch (apiFetch handles auth, CSRF, and JSON
// encoding); the public /api/public/analytics/* endpoints are NOT
// reached from the FE (the only consumer of those is the JS loader
// running on the customer's landing page).

import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AnalyticsConfigDTO,
  AnalyticsConfigUpdateDTO,
  AnalyticsSnippetResponse,
  AnalyticsStatsResponse,
} from "@/types/analytics";

export type PageAnalyticsConfigDTO = Page<AnalyticsConfigDTO>;

/**
 * Optional project filter — when provided, only configs for that project
 * are returned. Mirrors the `projectId` query param on the BE.
 */
export interface GetAllAnalyticsConfigsParams extends QueryParams {
  projectId?: number;
}

export const getAllAnalyticsConfigsPaged = (
  params: GetAllAnalyticsConfigsParams = {},
): Promise<PageAnalyticsConfigDTO> => {
  return apiFetch<PageAnalyticsConfigDTO>(
    `/analytics?${buildQueryString(params)}`,
  );
};

export const getAnalyticsConfigById = (id: number): Promise<AnalyticsConfigDTO> => {
  return apiFetch<AnalyticsConfigDTO>(`/analytics/${id}`);
};

/**
 * Lazy upsert: returns the existing config for the project, or creates one
 * with sensible defaults. Used by the project view to render the "Enable
 * analytics" card without forcing the operator through a create form.
 */
export const getOrCreateAnalyticsConfigByProject = (
  projectId: number,
): Promise<AnalyticsConfigDTO> => {
  return apiFetch<AnalyticsConfigDTO>(
    `/analytics/by-project/${projectId}`,
  );
};

export const updateAnalyticsConfig = (
  id: number,
  data: AnalyticsConfigUpdateDTO,
): Promise<AnalyticsConfigDTO> => {
  return apiFetch<AnalyticsConfigDTO>(`/analytics/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const getAnalyticsSnippet = (
  id: number,
): Promise<AnalyticsSnippetResponse> => {
  return apiFetch<AnalyticsSnippetResponse>(`/analytics/${id}/snippet`);
};

export const getAnalyticsStats = (
  id: number,
  days = 30,
): Promise<AnalyticsStatsResponse> => {
  return apiFetch<AnalyticsStatsResponse>(
    `/analytics/${id}/stats?days=${days}`,
  );
};

export const deleteAnalyticsConfig = (id: number): Promise<void> => {
  return apiFetch<void>(`/analytics/${id}`, {
    method: "DELETE",
  });
};
