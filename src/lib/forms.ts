import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  FormCreateDTO,
  FormDTO,
  FormSnippetResponse,
  FormSubmissionDTO,
  FormUpdateDTO,
} from "@/types/form";

export type PageFormDTO = Page<FormDTO>;

/**
 * Optional project filter — when provided, only forms belonging to that
 * project are returned. Mirrors the `projectId` field on the BE query string.
 */
export interface GetAllFormsParams extends QueryParams {
  projectId?: number;
}

export const getAllFormsPaged = (
  params: GetAllFormsParams = {},
): Promise<PageFormDTO> => {
  return apiFetch<PageFormDTO>(`/forms?${buildQueryString(params)}`);
};

export const getFormById = (id: number): Promise<FormDTO> => {
  return apiFetch<FormDTO>(`/forms/${id}`);
};

export const createForm = (data: FormCreateDTO): Promise<FormDTO> => {
  return apiFetch<FormDTO>("/forms", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateForm = (
  id: number,
  data: FormUpdateDTO,
): Promise<FormDTO> => {
  return apiFetch<FormDTO>(`/forms/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const getFormSnippet = (
  id: number,
): Promise<FormSnippetResponse> => {
  return apiFetch<FormSnippetResponse>(`/forms/${id}/snippet`);
};

export const deleteForm = (id: number): Promise<void> => {
  return apiFetch<void>(`/forms/${id}`, {
    method: "DELETE",
  });
};

// ---------------------------------------------------------------------------
// Submissions (lists, detail, public POST helper)
// ---------------------------------------------------------------------------

export interface SubmissionsQueryParams {
  page?: number;
  size?: number;
  sortField?: "submittedAt" | "ipAddress" | "locale" | "createdAt";
  sortOrder?: "asc" | "desc";
  queries?: string[];
  filterType?: "any" | "all";
  signal?: AbortSignal;
}

export interface FormSubmissionPage {
  content: FormSubmissionDTO[];
  totalElements: number;
  totalPages: number;
  number: number;
  size: number;
  first: boolean;
  last: boolean;
  numberOfElements: number;
  empty: boolean;
  pageable?: {
    paged: boolean;
    pageSize: number;
    pageNumber: number;
    unpaged: boolean;
    offset: number;
    sort: { sorted: boolean; unsorted: boolean; empty: boolean };
  };
  sort?: { sorted: boolean; unsorted: boolean; empty: boolean };
}

export async function getFormSubmissions(
  formId: number,
  params: SubmissionsQueryParams = {},
): Promise<FormSubmissionPage> {
  const q = new URLSearchParams();
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.size !== undefined) q.set("size", String(params.size));
  if (params.sortField) q.set("sortField", params.sortField);
  if (params.sortOrder) q.set("sortOrder", params.sortOrder);
  (params.queries ?? []).forEach((qq) => q.append("queries", qq));
  if (params.filterType) q.set("filterType", params.filterType);
  const qs = q.toString();
  return apiFetch<FormSubmissionPage>(
    `/forms/${formId}/submissions${qs ? `?${qs}` : ""}`,
    { signal: params.signal },
  );
}

export async function getFormSubmissionById(
  formId: number,
  submissionId: number,
): Promise<FormSubmissionDTO> {
  return apiFetch<FormSubmissionDTO>(
    `/forms/${formId}/submissions/${submissionId}`,
  );
}

// Raw fetch for the public POST endpoint. No apiFetch because the public
// endpoint must NOT carry the CSRF header (it's exempt by prefix-match in
// middleware/csrf.js) and uses application/json without the auth pipeline.
export async function publicSubmitForm(
  secretToken: string,
  body: {
    data: Record<string, unknown>;
    locale?: string;
  },
): Promise<{ id: number; submittedAt: string }> {
  const res = await fetch(
    `/api/public/forms/${encodeURIComponent(secretToken)}/submissions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // credentials omitted — public endpoint, no session, no cookies.
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let msg = "Submission failed";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch {
      /* swallow JSON-parse errors and fall back to the default msg */
    }
    throw new Error(msg);
  }
  return res.json();
}
