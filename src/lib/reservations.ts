import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AvailabilityScheduleCreateDTO,
  AvailabilityScheduleDTO,
  AvailabilityWindowDTO,
  ReservationBookingAck,
  ReservationBookingDTO,
  ReservationBookingRequest,
  ReservationCreateDTO,
  ReservationDisabledRangeCreateDTO,
  ReservationDisabledRangeDTO,
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

export interface ReservationBookingItemInput {
  startsAt: string;
  endsAt: string;
  data?: Record<string, unknown> | null;
}

// Admin-only booking creation — skips lead_time / max_advance_days.
// `data` is optional; when present it MUST pass the same bounded-bag check
// as the public endpoint, and the reservation must have
// `extraFieldsEnabled = true`.
export async function createReservationBooking(
  reservationId: number,
  startsAt: string,
  endsAt: string,
  options?: {
    data?: Record<string, unknown> | null;
    locale?: string | null;
    /**
     * When "import", the create request is tagged so the BE inserts
     * `user_agent = "admin-import"` instead of "admin-panel", letting the
     * calendar badge distinguish migration-imported rows from manually
     * created ones.
     */
    source?: "calendar" | "import";
  },
): Promise<ReservationBookingDTO> {
  const body: Record<string, unknown> = { startsAt, endsAt };
  if (options?.data !== undefined && options?.data !== null) {
    body.data = options.data;
  }
  if (options?.locale) {
    body.locale = options.locale;
  }
  if (options?.source === "import") {
    body._source = "import";
  }
  return apiFetch<ReservationBookingDTO>(
    `/reservations/${reservationId}/bookings`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

// Bulk dry-run for the booking-import feature — runs the EXACT same
// validation as createReservationBooking, but for a list of items, without
// inserting anything. The FE uses this for "Verify".
export interface BookingImportDryRunRow {
  index: number; // 1-based
  ok: boolean;
  // Present iff ok:
  startsAt?: string;
  endsAt?: string;
  hasData?: boolean;
  // Present iff !ok:
  error?: string;
}

export interface BookingImportDryRunResponse {
  results: BookingImportDryRunRow[];
}

export async function dryRunBookingImport(
  reservationId: number,
  items: ReservationBookingItemInput[],
): Promise<BookingImportDryRunResponse> {
  return apiFetch<BookingImportDryRunResponse>(
    `/reservations/${reservationId}/bookings/dry-run`,
    {
      method: "POST",
      body: JSON.stringify({ items }),
    },
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

// ---------------------------------------------------------------------------
// Disabled ranges (admin + enduser read; admin-only create/delete)
// ---------------------------------------------------------------------------

export async function getDisabledRanges(
  reservationId: number,
): Promise<ReservationDisabledRangeDTO[]> {
  return apiFetch<ReservationDisabledRangeDTO[]>(
    `/reservations/${reservationId}/disabled-ranges`,
  );
}

export async function createDisabledRange(
  reservationId: number,
  data: ReservationDisabledRangeCreateDTO,
): Promise<ReservationDisabledRangeDTO> {
  return apiFetch<ReservationDisabledRangeDTO>(
    `/reservations/${reservationId}/disabled-ranges`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
}

export async function deleteDisabledRange(
  reservationId: number,
  rangeId: number,
): Promise<void> {
  return apiFetch<void>(
    `/reservations/${reservationId}/disabled-ranges/${rangeId}`,
    { method: "DELETE" },
  );
}

export async function toggleDisabledRange(
  reservationId: number,
  rangeId: number,
): Promise<{ id: number; enabled: boolean }> {
  return apiFetch<{ id: number; enabled: boolean }>(
    `/reservations/${reservationId}/disabled-ranges/${rangeId}/toggle`,
    { method: "PATCH" },
  );
}

export async function updateDisabledRange(
  reservationId: number,
  rangeId: number,
  data: ReservationDisabledRangeCreateDTO,
): Promise<ReservationDisabledRangeDTO> {
  return apiFetch<ReservationDisabledRangeDTO>(
    `/reservations/${reservationId}/disabled-ranges/${rangeId}`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

// ---------------------------------------------------------------------------
// Availability schedules (admin + enduser read; admin create/delete)
// ---------------------------------------------------------------------------

export async function getAvailabilitySchedules(
  reservationId: number,
): Promise<AvailabilityScheduleDTO[]> {
  return apiFetch<AvailabilityScheduleDTO[]>(
    `/reservations/${reservationId}/availability-schedules`,
  );
}

export async function createAvailabilitySchedule(
  reservationId: number,
  data: AvailabilityScheduleCreateDTO,
): Promise<AvailabilityScheduleDTO> {
  return apiFetch<AvailabilityScheduleDTO>(
    `/reservations/${reservationId}/availability-schedules`,
    {
      method: "POST",
      body: JSON.stringify(data),
    },
  );
}

export async function deleteAvailabilitySchedule(
  reservationId: number,
  scheduleId: number,
): Promise<void> {
  return apiFetch<void>(
    `/reservations/${reservationId}/availability-schedules/${scheduleId}`,
    { method: "DELETE" },
  );
}

export async function updateAvailabilitySchedule(
  reservationId: number,
  scheduleId: number,
  data: AvailabilityScheduleCreateDTO,
): Promise<AvailabilityScheduleDTO> {
  return apiFetch<AvailabilityScheduleDTO>(
    `/reservations/${reservationId}/availability-schedules/${scheduleId}`,
    {
      method: "PUT",
      body: JSON.stringify(data),
    },
  );
}
