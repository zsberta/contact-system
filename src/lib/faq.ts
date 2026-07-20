import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  FaqItemCreateDTO,
  FaqItemDTO,
  FaqItemUpdateDTO,
  PublicFaqResponse,
} from "@/types/faq";

export type PageFaqItemDTO = Page<FaqItemDTO>;

export interface GetAllFaqItemsParams extends QueryParams {
  projectId?: number;
  status?: "draft" | "published";
}

export const getAllFaqItemsPaged = (
  params: GetAllFaqItemsParams = {},
): Promise<PageFaqItemDTO> => {
  return apiFetch<PageFaqItemDTO>(`/faq?${buildQueryString(params)}`);
};

export const getFaqItemById = (id: number): Promise<FaqItemDTO> => {
  return apiFetch<FaqItemDTO>(`/faq/${id}`);
};

export const createFaqItem = (
  data: FaqItemCreateDTO,
): Promise<FaqItemDTO> => {
  return apiFetch<FaqItemDTO>("/faq", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateFaqItem = (
  id: number,
  data: FaqItemUpdateDTO,
): Promise<FaqItemDTO> => {
  return apiFetch<FaqItemDTO>(`/faq/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteFaqItem = (id: number): Promise<void> => {
  return apiFetch<void>(`/faq/${id}`, {
    method: "DELETE",
  });
};

export const publishFaqItem = (id: number): Promise<FaqItemDTO> => {
  return apiFetch<FaqItemDTO>(`/faq/${id}/publish`, {
    method: "POST",
  });
};

export const unpublishFaqItem = (id: number): Promise<FaqItemDTO> => {
  return apiFetch<FaqItemDTO>(`/faq/${id}/unpublish`, {
    method: "POST",
  });
};

// Public read endpoint (no auth, mounted under /api/public/faq/*).
export async function getPublicFaq(
  domain: string,
): Promise<PublicFaqResponse> {
  const url = `/api/public/faq/by-domain/${encodeURIComponent(domain)}/items`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    credentials: "omit",
  });
  if (!res.ok) {
    throw new Error(`public FAQ fetch failed: ${res.status}`);
  }
  return res.json() as Promise<PublicFaqResponse>;
}
