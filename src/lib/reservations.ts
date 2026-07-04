import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AvailabilityWindowDTO,
  ReservationBookingAck,
  ReservationBookingDTO,
  ReservationBookingRequest,
  ReservationCreateDTO,
  ReservationDTO,
  ReservationSnippetResponse,
  ReservationUpdateDTO,
} from "@/types/reservation";

export type PageReservationDTO = Page<ReservationDTO>;

/**
 * Optional project filter — when provided, only reservations belonging to
 * that project are returned. Mirrors the `projectId` field on the BE query string.
 */
export interface GetAllReservationsParams extends QueryParams {
  projectId?: number;
}

export const getAllReservationsPaged = (
  params: GetAllReservationsParams = {},
): Promise<PageReservationDTO> => {
  // Strip projectId when undefined so it isn't sent as ?projectId=undefined.
  const cleaned = { ...params };
  if (cleaned.projectId === undefined) delete cleaned.projectId;
  return apiFetch<PageReservationDTO>(
    `/reservations?${buildQueryString(cleaned)}`,
  );
};

export const getReservationById = (id: number): Promise<ReservationDTO> => {
  return apiFetch<ReservationDTO>(`/reservations/${id}`);
};

export const createReservation = (
  data: ReservationCreateDTO,
): Promise<ReservationDTO> => {
  return apiFetch<ReservationDTO>("/reservations", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateReservation = (
  id: number,
  data: ReservationUpdateDTO,
): Promise<ReservationDTO> => {
  return apiFetch<ReservationDTO>(`/reservations/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const getReservationSnippet = (
  id: number,
): Promise<ReservationSnippetResponse> => {
  return apiFetch<ReservationSnippetResponse>(`/reservations/${id}/snippet`);
};

export const deleteReservation = (id: number): Promise<void> => {
  return apiFetch<void>(`/reservations/${id}`, {
    method: "DELETE",
  });
};

// ---------------------------------------------------------------------------
// Bookings (admin)
// ---------------------------------------------------------------------------

export interface BookingsQueryParams {
  page?: number;
  size?: number;
  sortField?:
    | "startsAt"
    | "endsAt"
    | "bookedAt"
    | "ipAddress"
    | "locale";
  sortOrder?: "asc" | "desc";
  queries?: string[];
  filterType?: "any" | "all";
  signal?: AbortSignal;
}

export interface ReservationBookingPage {
  content: ReservationBookingDTO[];
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

export async function getReservationBookings(
  reservationId: number,
  params: BookingsQueryParams = {},
): Promise<ReservationBookingPage> {
  const q = new URLSearchParams();
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.size !== undefined) q.set("size", String(params.size));
  if (params.sortField) q.set("sortField", params.sortField);
  if (params.sortOrder) q.set("sortOrder", params.sortOrder);
  (params.queries ?? []).forEach((qq) => q.append("queries", qq));
  if (params.filterType) q.set("filterType", params.filterType);
  const qs = q.toString();
  return apiFetch<ReservationBookingPage>(
    `/reservations/${reservationId}/bookings${qs ? `?${qs}` : ""}`,
    { signal: params.signal },
  );
}

export async function getReservationBookingById(
  reservationId: number,
  bookingId: number,
): Promise<ReservationBookingDTO> {
  return apiFetch<ReservationBookingDTO>(
    `/reservations/${reservationId}/bookings/${bookingId}`,
  );
}

// ---------------------------------------------------------------------------
// Public endpoints (no CSRF, no auth) — fetch() directly so we bypass the
// apiFetch CSRF injection (the public endpoint is CSRF-exempt; we want
// the secret-token to be the only capability).
// ---------------------------------------------------------------------------

export interface AvailabilityParams {
  from?: string;
  to?: string;
  signal?: AbortSignal;
}

export async function publicGetAvailability(
  secretToken: string,
  params: AvailabilityParams = {},
): Promise<AvailabilityWindowDTO> {
  const q = new URLSearchParams();
  if (params.from) q.set("from", params.from);
  if (params.to) q.set("to", params.to);
  const qs = q.toString();
  const res = await fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/availability${qs ? `?${qs}` : ""}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      credentials: "omit",
      signal: params.signal,
    },
  );
  if (!res.ok) {
    let msg = "Availability request failed";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch { /* ignore parse errors */ }
    throw new Error(msg);
  }
  return res.json();
}

export async function publicSubmitReservation(
  secretToken: string,
  body: ReservationBookingRequest,
): Promise<ReservationBookingAck> {
  const res = await fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/bookings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let msg = "Booking submission failed";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch { /* ignore parse errors */ }
    throw new Error(msg);
  }
  return res.json();
}
