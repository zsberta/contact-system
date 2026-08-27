import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AvailabilityScheduleCreateDTO,
  AvailabilityScheduleDTO,
  AvailabilityWindowDTO,
  CalendarDayDetailsResponse,
  CalendarMonthResponse,
  EnrichedReservationBookingDTO,
  ReservationBookingAck,
  ReservationBookingCreateRequest,
  ReservationBookingDTO,
  ReservationBookingRequest,
  ReservationBookingUpdateRequest,
  ReservationCatalogDTO,
  ReservationCreateDTO,
  ReservationCustomerCreateDTO,
  ReservationCustomerDTO,
  ReservationCustomerProfileDTO,
  ReservationCustomerProfilesResponse,
  ReservationCustomerUpdateDTO,
  ReservationDisableSettingsResponse,
  ReservationDisabledRangeCreateDTO,
  ReservationDisabledRangeDTO,
  ReservationDTO,
  ReservationPublicBookingRequest,
  ReservationServiceAvailabilityDTO,
  ReservationServiceCreateDTO,
  ReservationServiceDTO,
  ReservationServiceHolidaysUpdateDTO,
  ReservationServiceScheduleDTO,
  ReservationServiceUpdateDTO,
  ReservationSnippetResponse,
  ReservationUpdateDTO,
  ReservationWorkerDTO,
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

export async function deleteReservationBooking(
  reservationId: number,
  bookingId: number,
): Promise<{ success: true }> {
  return apiFetch<{ success: true }>(
    `/reservations/${reservationId}/bookings/${bookingId}`,
    { method: "DELETE" },
  );
}

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
    | "serviceName"
    | "customerName"
    | "workerFirstName"
    | "status";
  sortOrder?: "asc" | "desc";
  queries?: string[];
  searchText?: string;
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
  if (params.searchText) q.set("searchText", params.searchText);
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
// Disable settings — per-service holiday policies + range associations
// ---------------------------------------------------------------------------

export async function getDisableSettings(
  reservationId: number,
): Promise<ReservationDisableSettingsResponse> {
  return apiFetch<ReservationDisableSettingsResponse>(
    `/reservations/${reservationId}/disable-settings`,
  );
}

export async function updateServiceHolidays(
  reservationId: number,
  data: ReservationServiceHolidaysUpdateDTO,
): Promise<{ serviceId: number; rules: Array<{ key: string; enabled: boolean }> }> {
  return apiFetch(
    `/reservations/${reservationId}/disable-settings/holidays`,
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

// ===========================================================================
// Service CRUD
// ===========================================================================

export async function getReservationServices(
  reservationId: number,
): Promise<ReservationServiceDTO[]> {
  return apiFetch<ReservationServiceDTO[]>(
    `/reservations/${reservationId}/services`,
  );
}

export async function getReservationServiceById(
  reservationId: number,
  serviceId: number,
): Promise<ReservationServiceDTO> {
  return apiFetch<ReservationServiceDTO>(
    `/reservations/${reservationId}/services/${serviceId}`,
  );
}

export async function createReservationService(
  reservationId: number,
  data: ReservationServiceCreateDTO,
): Promise<ReservationServiceDTO> {
  return apiFetch<ReservationServiceDTO>(
    `/reservations/${reservationId}/services`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export async function updateReservationService(
  reservationId: number,
  serviceId: number,
  data: ReservationServiceUpdateDTO,
): Promise<ReservationServiceDTO> {
  return apiFetch<ReservationServiceDTO>(
    `/reservations/${reservationId}/services/${serviceId}`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

export async function deleteReservationService(
  reservationId: number,
  serviceId: number,
): Promise<void> {
  return apiFetch<void>(
    `/reservations/${reservationId}/services/${serviceId}`,
    { method: "DELETE" },
  );
}

// ===========================================================================
// Workers
// ===========================================================================

export async function getReservationWorkers(
  reservationId: number,
): Promise<ReservationWorkerDTO[]> {
  return apiFetch<ReservationWorkerDTO[]>(
    `/reservations/${reservationId}/workers`,
  );
}

// ===========================================================================
// Service image upload/delete
// ===========================================================================

export async function uploadServiceImage(
  serviceId: number,
  file: File,
): Promise<{ imageUrl: string; id: number; storedFilename: string; mimeType: string; sizeBytes: number }> {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch(`/reservations/services/${serviceId}/image`, {
    method: "POST",
    body: formData,
    headers: {}, // Let browser set Content-Type for multipart
  });
}

export async function deleteServiceImage(serviceId: number): Promise<void> {
  return apiFetch<void>(
    `/reservations/services/${serviceId}/image`,
    { method: "DELETE" },
  );
}

// ===========================================================================
// Service availability schedules
// ===========================================================================

export async function getAdminServiceAvailability(
  reservationId: number,
  serviceId: number,
  from: string,
  to: string,
): Promise<ReservationServiceAvailabilityDTO> {
  return apiFetch<ReservationServiceAvailabilityDTO>(
    `/reservations/${reservationId}/services/${serviceId}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
}

export async function getServiceAvailabilitySchedules(
  reservationId: number,
  serviceId: number,
): Promise<ReservationServiceScheduleDTO[]> {
  return apiFetch<ReservationServiceScheduleDTO[]>(
    `/reservations/${reservationId}/services/${serviceId}/availability-schedules`,
  );
}

export async function createServiceAvailabilitySchedule(
  reservationId: number,
  serviceId: number,
  data: AvailabilityScheduleCreateDTO,
): Promise<ReservationServiceScheduleDTO> {
  return apiFetch<ReservationServiceScheduleDTO>(
    `/reservations/${reservationId}/services/${serviceId}/availability-schedules`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export async function deleteServiceAvailabilitySchedule(
  reservationId: number,
  serviceId: number,
  scheduleId: number,
): Promise<void> {
  return apiFetch<void>(
    `/reservations/${reservationId}/services/${serviceId}/availability-schedules/${scheduleId}`,
    { method: "DELETE" },
  );
}

export async function updateServiceAvailabilitySchedule(
  reservationId: number,
  serviceId: number,
  scheduleId: number,
  data: AvailabilityScheduleCreateDTO,
): Promise<ReservationServiceScheduleDTO> {
  return apiFetch<ReservationServiceScheduleDTO>(
    `/reservations/${reservationId}/services/${serviceId}/availability-schedules/${scheduleId}`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

// ===========================================================================
// Calendar (admin month summary + lazy day details)
// ===========================================================================

export async function getReservationCalendarMonth(
  reservationId: number,
  month: string,
  params?: { hideEmpty?: boolean; workerId?: number | null },
): Promise<CalendarMonthResponse> {
  const q = new URLSearchParams({ month });
  if (params?.hideEmpty) q.set("hideEmpty", "true");
  if (params?.workerId) q.set("workerId", String(params.workerId));
  return apiFetch<CalendarMonthResponse>(
    `/reservations/${reservationId}/calendar?${q.toString()}`,
  );
}

export async function getReservationCalendarDay(
  reservationId: number,
  date: string,
): Promise<CalendarDayDetailsResponse> {
  return apiFetch<CalendarDayDetailsResponse>(
    `/reservations/${reservationId}/calendar/${encodeURIComponent(date)}`,
  );
}

// ===========================================================================
// Customers
// ===========================================================================

export interface CustomersQueryParams extends QueryParams {
  projectId?: number;
  search?: string;
}

export async function getReservationCustomers(
  params: CustomersQueryParams = {},
): Promise<Page<ReservationCustomerDTO>> {
  return apiFetch<Page<ReservationCustomerDTO>>(
    `/reservations/customers?${buildQueryString(params)}`,
  );
}

export async function getReservationCustomerById(
  customerId: number,
): Promise<ReservationCustomerDTO> {
  return apiFetch<ReservationCustomerDTO>(
    `/reservations/customers/${customerId}`,
  );
}

export async function createReservationCustomer(
  data: ReservationCustomerCreateDTO,
): Promise<ReservationCustomerDTO> {
  return apiFetch<ReservationCustomerDTO>(
    "/reservations/customers",
    { method: "POST", body: JSON.stringify(data) },
  );
}

export async function updateReservationCustomer(
  customerId: number,
  data: ReservationCustomerUpdateDTO,
): Promise<ReservationCustomerDTO> {
  return apiFetch<ReservationCustomerDTO>(
    `/reservations/customers/${customerId}`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

export async function deleteReservationCustomer(
  customerId: number,
): Promise<void> {
  return apiFetch<void>(
    `/reservations/customers/${customerId}`,
    { method: "DELETE" },
  );
}

export async function getReservationCustomerBookings(
  customerId: number,
): Promise<EnrichedReservationBookingDTO[]> {
  return apiFetch<EnrichedReservationBookingDTO[]>(
    `/reservations/customers/${customerId}/bookings`,
  );
}

// ===========================================================================
// Enriched booking create/update (admin)
// ===========================================================================

export async function createEnrichedReservationBooking(
  reservationId: number,
  data: ReservationBookingCreateRequest,
): Promise<EnrichedReservationBookingDTO> {
  return apiFetch<EnrichedReservationBookingDTO>(
    `/reservations/${reservationId}/bookings`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export async function updateReservationBookingStatus(
  reservationId: number,
  bookingId: number,
  data: ReservationBookingUpdateRequest,
): Promise<EnrichedReservationBookingDTO> {
  return apiFetch<EnrichedReservationBookingDTO>(
    `/reservations/${reservationId}/bookings/${bookingId}`,
    { method: "PATCH", body: JSON.stringify(data) },
  );
}

// ===========================================================================
// Public catalog and availability (no auth, no CSRF)
// ===========================================================================

export async function publicGetCatalog(
  secretToken: string,
  locale?: string,
): Promise<ReservationCatalogDTO> {
  const params = locale ? `?locale=${encodeURIComponent(locale)}` : "";
  return fetch(`/api/public/reservations/${secretToken}/catalog${params}`).then(
    (r) => r.json(),
  );
}

export async function publicGetServiceAvailability(
  secretToken: string,
  serviceId: number,
  from: string,
  to: string,
): Promise<ReservationServiceAvailabilityDTO> {
  return fetch(
    `/api/public/reservations/${secretToken}/services/${serviceId}/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  ).then((r) => r.json());
}

export async function publicSubmitServiceBooking(
  secretToken: string,
  body: ReservationPublicBookingRequest,
): Promise<ReservationBookingAck> {
  const res = await fetch(`/api/public/reservations/${secretToken}/bookings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "omit",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = "Booking failed";
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
// Public profile resolution — resolve opaque browser tokens to customer data.
// POST /api/public/reservations/:secret_token/customer-profiles/resolve
// ---------------------------------------------------------------------------

export async function publicResolveReservationCustomerProfiles(
  secretToken: string,
  profileTokens: string[],
): Promise<ReservationCustomerProfilesResponse> {
  return fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/customer-profiles/resolve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify({ profileTokens }),
    },
  ).then((r) => r.json());
}


// ---------------------------------------------------------------------------
// Public booking management — customer self-service via booking token.
// ---------------------------------------------------------------------------

export interface PublicBookingDetails {
  id: number;
  startsAt: string;
  endsAt: string;
  status: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  comment: string | null;
  serviceId: number;
  serviceName: string;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  locale: string;
}

/**
 * GET /api/public/reservations/:secret_token/bookings/by-token/:bookingToken
 * Fetch booking details for the customer self-service manage page.
 */
export async function publicGetBookingByToken(
  secretToken: string,
  bookingToken: string,
): Promise<PublicBookingDetails> {
  const res = await fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/bookings/by-token/${encodeURIComponent(bookingToken)}`,
    { method: "GET", credentials: "omit" },
  );
  if (!res.ok) {
    let msg = "Booking not found";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

/**
 * DELETE /api/public/reservations/:secret_token/bookings/by-token/:bookingToken
 * Cancel a booking via the customer self-service endpoint.
 */
export async function publicCancelBookingByToken(
  secretToken: string,
  bookingToken: string,
  reason?: string,
): Promise<{ success: true }> {
  const res = await fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/bookings/by-token/${encodeURIComponent(bookingToken)}`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: reason ? JSON.stringify({ reason }) : undefined,
    },
  );
  if (!res.ok) {
    let msg = "Cancellation failed";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export interface RescheduleRequest {
  startsAt: string;
  endsAt: string;
}

export interface RescheduleResponse {
  id: number;
  bookingToken: string;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
}

/**
 * PATCH /api/public/reservations/:secret_token/bookings/by-token/:bookingToken/reschedule
 * Reschedule a booking: cancels the old one and creates a new one in the
 * requested slot. Returns the new booking details on success.
 */
export async function publicRescheduleBookingByToken(
  secretToken: string,
  bookingToken: string,
  body: RescheduleRequest,
): Promise<RescheduleResponse> {
  const res = await fetch(
    `/api/public/reservations/${encodeURIComponent(secretToken)}/bookings/by-token/${encodeURIComponent(bookingToken)}/reschedule`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "omit",
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    let msg = "Reschedule failed";
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody === "object" && errBody.errorMessage) {
        msg = errBody.errorMessage;
      }
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}
