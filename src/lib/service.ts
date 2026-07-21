import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  ServiceItemCreateDTO,
  ServiceItemDTO,
  ServiceItemUpdateDTO,
  PublicServiceResponse,
} from "@/types/service";

export type PageServiceItemDTO = Page<ServiceItemDTO>;

export interface GetAllServiceItemsParams extends QueryParams {
  projectId?: number;
  status?: "draft" | "published";
}

export const getAllServiceItemsPaged = (
  params: GetAllServiceItemsParams = {},
): Promise<PageServiceItemDTO> => {
  return apiFetch<PageServiceItemDTO>(`/service?${buildQueryString(params)}`);
};

export const getServiceItemById = (id: number): Promise<ServiceItemDTO> => {
  return apiFetch<ServiceItemDTO>(`/service/${id}`);
};

export const createServiceItem = (
  data: ServiceItemCreateDTO,
): Promise<ServiceItemDTO> => {
  return apiFetch<ServiceItemDTO>("/service", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateServiceItem = (
  id: number,
  data: ServiceItemUpdateDTO,
): Promise<ServiceItemDTO> => {
  return apiFetch<ServiceItemDTO>(`/service/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteServiceItem = (id: number): Promise<void> => {
  return apiFetch<void>(`/service/${id}`, {
    method: "DELETE",
  });
};

export const publishServiceItem = (id: number): Promise<ServiceItemDTO> => {
  return apiFetch<ServiceItemDTO>(`/service/${id}/publish`, {
    method: "POST",
  });
};

export const unpublishServiceItem = (id: number): Promise<ServiceItemDTO> => {
  return apiFetch<ServiceItemDTO>(`/service/${id}/unpublish`, {
    method: "POST",
  });
};

// Public read endpoint (no auth, mounted under /api/public/service/*).
export async function getPublicService(
  domain: string,
): Promise<PublicServiceResponse> {
  const url = `/api/public/service/by-domain/${encodeURIComponent(domain)}/items`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`public service fetch failed: ${res.status}`);
  }
  return res.json() as Promise<PublicServiceResponse>;
}
