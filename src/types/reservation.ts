// ----------------------------------------------------------------------------
// Reservation DTOs (admin + public) — sibling of types/form.ts.
//
// The reservation entity combines an operator-declared date/time window
// (startsAt / endsAt, plus granularity hints) with an OPTIONAL free-form
// `data` JSONB bag for extra context the visitor submits. The `data` field
// is governed by the reservation's `extraFieldsEnabled` flag — when false,
// the public endpoint rejects any `data` field with 400.
// ----------------------------------------------------------------------------

export type ReservationStatus = "active" | "disabled";

// Granularity at which bookings align:
//   - 'day'    — a booking is a full day or multi-day range; no hourly grid
//   - 'hour'   — bookings must start on hour boundaries (or finer, if the
//                reservation declares a slot_duration_minutes)
//   - 'minute' — bookings can land on minute slots; in practice always
//                configured with a slot_duration_minutes (e.g. 15/30/60)
export type ReservationGranularity = "day" | "hour" | "minute";

// Admin: returned by GET /api/reservations, GET /api/reservations/:id,
// POST /api/reservations, PUT /api/reservations/:id.
export interface ReservationDTO {
  id: number;
  // Operator config (mirrors Form fields)
  name: string;
  secretToken: string;
  projectId: number;
  projectName: string;
  allowedOrigins: string[];
  status: ReservationStatus;
  extraFieldsEnabled: boolean;
  disableHungarianHolidays: boolean;
  brandColor: string;
  iframeWidth: string;
  iframeHeight: string;
  privacyPolicyUrl: string | null;
  cookiePolicyUrl: string | null;
  // Booking catalog config
  defaultLocale: string;
  timezone: string;
  // Audit
  createdAt: string;
  updatedAt: string;
}

// POST /api/reservations body. `secretToken` is server-generated and not
// accepted here. `slug` must be unique across all reservations.
export interface ReservationCreateDTO {
  name: string;
  projectId: number;
  allowedOrigins: string[];
  status?: ReservationStatus;
  extraFieldsEnabled?: boolean;
  disableHungarianHolidays?: boolean;
  brandColor?: string;
  iframeWidth?: string;
  iframeHeight?: string;
  privacyPolicyUrl?: string | null;
  cookiePolicyUrl?: string | null;
  defaultLocale?: string;
  timezone?: string;
}

// PUT /api/reservations/:id body. `projectId` and `secretToken` are
// immutable post-create; the BE rejects any payload containing them (see
// routes/reservations.js). `slug` is editable — collision → 409.
export interface ReservationUpdateDTO {
  name?: string;
  allowedOrigins?: string[];
  status?: ReservationStatus;
  extraFieldsEnabled?: boolean;
  disableHungarianHolidays?: boolean;
  brandColor?: string;
  iframeWidth?: string;
  iframeHeight?: string;
  privacyPolicyUrl?: string | null;
  cookiePolicyUrl?: string | null;
  defaultLocale?: string;
  timezone?: string;
}

// Snippet response from GET /api/reservations/:id/snippet.
export interface ReservationSnippetResponse {
  html: string;
  embedUrl: string;
  secretToken: string;
  origin: string;
  granularity: ReservationGranularity;
  slotDurationMinutes: number | null;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  // Endpoints the landing page can hit without further round-trips.
  availabilityEndpoint: string;
  submissionEndpoint: string;
  allowedOrigins: string[];
}

// Single booking, returned by GET /api/reservations/:id/bookings and
// GET /api/reservations/:id/bookings/:bookingId.
// Enriched with service, customer, worker, and status fields from JOINs.
export interface ReservationBookingDTO {
  id: number;
  reservationId: number;
  serviceId: number | null;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
  // Contact
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  comment: string | null;
  // References
  customerId: number | null;
  createdByUserId: number | null;
  workerUserId: number | null;
  // Snapshots
  serviceNameSnapshot: string | null;
  durationMinutesSnapshot: number | null;
  priceAmountSnapshot: number | null;
  currencySnapshot: string | null;
  timezone: string | null;
  // Lifecycle
  status: ReservationBookingStatus;
  source: ReservationBookingSource;
  cancelledAt: string | null;
  cancelledByUserId: number | null;
  cancellationReason: string | null;
  // Audit
  locale: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  // Joined fields
  serviceName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  workerFirstName: string | null;
  workerLastName: string | null;
  createdByFirstName: string | null;
  createdByLastName: string | null;
  reservationName: string | null;
  projectName: string | null;
}

// Public availability response — the headline endpoint the landing page
// uses to grey out already-booked slots before showing the user a date
// picker. We return ONLY the busy ranges, never the metadata, so the FE
// has freedom to render any kind of calendar / time grid / timeline
// while the LE keeps zero leakage of the customer's contact info.
export interface AvailabilityWindowDTO {
  reservationId: number;
  windowStart: string;
  windowEnd: string;
  granularity: ReservationGranularity;
  slotDurationMinutes: number | null;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  booked: Array<{
    startsAt: string;
    endsAt: string;
  }>;
  disabled: Array<{
    startsAt: string;
    endsAt: string;
  }>;
  schedules: Array<{
    frequency: AvailabilityScheduleFrequency;
    dayOfWeek: number | null;
    dayOfMonth: number | null;
    startTime: string;
    endTime: string;
  }>;
}

// Public submission response — mirrors the 201 returned by POST /bookings.
export interface ReservationBookingAck {
  id: number;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
  /** Opaque token for customer self-service manage/delete/modify. */
  bookingToken?: string;
  /** Present when the visitor opted in with "remember me" and the association succeeded. */
  customerProfile?: ReservationCustomerProfileDTO;
}

// Public submission request body — used by the landing page widget.
export interface ReservationBookingRequest {
  startsAt: string;
  endsAt: string;
  locale?: string;
  data?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Customer profiles — opaque browser-saved tokens for "remember me".
// ---------------------------------------------------------------------------

/** A resolved customer profile — raw token paired with current backend data. */
export interface ReservationCustomerProfileDTO {
  profileToken: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Response from POST /customer-profiles/resolve. */
export interface ReservationCustomerProfilesResponse {
  profiles: ReservationCustomerProfileDTO[];
}

// ---------------------------------------------------------------------------
// Disabled ranges — operator-declared blackouts where no bookings are allowed.
// Service-scoped: each range targets specific services via the join table.
// ---------------------------------------------------------------------------

// Single disabled range, returned by GET /api/reservations/:id/disabled-ranges.
export interface ReservationDisabledRangeDTO {
  id: number;
  reservationId: number;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  source: "manual" | "auto_holiday";
  enabled: boolean;
  createdAt: string;
  serviceIds: number[];
}

// POST /api/reservations/:id/disabled-ranges body.
export interface ReservationDisabledRangeCreateDTO {
  startsAt: string;
  endsAt: string;
  reason?: string | null;
  serviceIds?: number[];
}

// ---------------------------------------------------------------------------
// Disable settings — per-service holiday policy + range associations.
// ---------------------------------------------------------------------------

export interface ReservationHolidayRuleDTO {
  key: string;
  enabled: boolean;
}

export interface ReservationServiceDisablePolicyDTO {
  id: number;
  name: string;
  workerUserId: number | null;
  workerFirstName: string | null;
  workerLastName: string | null;
  holidayRules: ReservationHolidayRuleDTO[];
}

export interface ReservationDisableSettingsResponse {
  services: ReservationServiceDisablePolicyDTO[];
  disabledRanges: ReservationDisabledRangeDTO[];
}

export interface ReservationServiceHolidaysUpdateDTO {
  serviceId: number;
  rules: Array<{ key: string; enabled: boolean }>;
}

// ---------------------------------------------------------------------------
// Availability schedules — recurring time-slot templates that define when
// a reservation is open for bookings (the positive counterpart to disabled
// ranges which block specific windows).
// ---------------------------------------------------------------------------

export type AvailabilityScheduleFrequency = "daily" | "weekly" | "monthly";

// Returned by GET /api/reservations/:id/availability-schedules.
export interface AvailabilityScheduleDTO {
  id: number;
  reservationId: number;
  frequency: AvailabilityScheduleFrequency;
  dayOfWeek: number | null;   // 0=Sun..6=Sat, only for weekly
  dayOfMonth: number | null;  // 1..31, only for monthly
  startTime: string;          // HH:MM (PostgreSQL TIME)
  endTime: string;            // HH:MM (PostgreSQL TIME)
  createdAt: string;
}

// POST /api/reservations/:id/availability-schedules body.
export interface AvailabilityScheduleCreateDTO {
  frequency: AvailabilityScheduleFrequency;
  dayOfWeek?: number | null;
  dayOfMonth?: number | null;
  startTime: string;
  endTime: string;
}

// ===========================================================================
// Service catalog types — reservation-owned bookable services
// ===========================================================================

export type ReservationServiceStatus = "active" | "disabled";

export interface ReservationServiceTranslationDTO {
  locale: string;
  name: string | null;
  description: string | null;
}

export interface ReservationServiceFieldDTO {
  id: number;
  fieldKey: string;
  fieldType: "text" | "textarea" | "select" | "checkbox";
  required: boolean;
  sortOrder: number;
  options: string[] | null;
  translations: Array<{
    locale: string;
    label: string;
    placeholder: string | null;
  }>;
}

export interface ReservationServiceDTO {
  id: number;
  reservationId: number;
  status: ReservationServiceStatus;
  sortOrder: number;
  durationMinutes: number;
  priceAmount: number;
  currency: string;
  capacity: number;
  granularity: ReservationGranularity;
  slotDurationMinutes: number | null;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  workerUserId: number | null;
  workerFirstName: string | null;
  workerLastName: string | null;
  name: string | null;
  description: string | null;
  imageUrl: string | null;
  translations?: ReservationServiceTranslationDTO[];
  fields?: ReservationServiceFieldDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface ReservationServiceCreateDTO {
  status?: ReservationServiceStatus;
  sortOrder?: number;
  durationMinutes: number;
  priceAmount?: number;
  currency?: string;
  capacity?: number;
  granularity?: ReservationGranularity;
  slotDurationMinutes?: number | null;
  leadTimeMinutes?: number;
  maxAdvanceDays?: number;
  workerUserId?: number | null;
  translations: Record<string, { name: string; description?: string | null }>;
  fields?: Array<{
    fieldKey: string;
    fieldType?: "text" | "textarea" | "select" | "checkbox";
    required?: boolean;
    sortOrder?: number;
    options?: string[];
    translations?: Record<string, { label: string; placeholder?: string }>;
  }>;
}

export interface ReservationServiceUpdateDTO {
  status?: ReservationServiceStatus;
  sortOrder?: number;
  durationMinutes?: number;
  priceAmount?: number;
  currency?: string;
  capacity?: number;
  granularity?: ReservationGranularity;
  slotDurationMinutes?: number | null;
  leadTimeMinutes?: number;
  maxAdvanceDays?: number;
  workerUserId?: number | null;
  translations?: Record<string, { name?: string; description?: string | null }>;
  fields?: Array<{
    fieldKey: string;
    fieldType?: "text" | "textarea" | "select" | "checkbox";
    required?: boolean;
    sortOrder?: number;
    options?: string[];
    translations?: Record<string, { label: string; placeholder?: string }>;
  }>;
}

// ===========================================================================
// Worker types
// ===========================================================================

export interface ReservationWorkerDTO {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
}

// ===========================================================================
// Customer types — reusable project-scoped contacts
// ===========================================================================

export type ReservationCustomerStatus = "active" | "archived";

export interface ReservationCustomerDTO {
  id: number;
  projectId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  status: ReservationCustomerStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ReservationCustomerCreateDTO {
  projectId: number;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

export interface ReservationCustomerUpdateDTO {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  status?: ReservationCustomerStatus;
}

// ===========================================================================
// Booking lifecycle types
// ===========================================================================

export type ReservationBookingStatus = "confirmed" | "cancelled" | "completed" | "no_show";
export type ReservationBookingSource = "public" | "admin" | "portal" | "import";

// Enriched booking DTO — extends the base with service, customer, status
export interface EnrichedReservationBookingDTO {
  id: number;
  reservationId: number;
  serviceId: number;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
  // Contact
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  comment: string | null;
  // References
  customerId: number | null;
  createdByUserId: number | null;
  workerUserId: number | null;
  // Snapshots
  serviceNameSnapshot: string | null;
  durationMinutesSnapshot: number | null;
  priceAmountSnapshot: number | null;
  currencySnapshot: string | null;
  timezone: string | null;
  // Lifecycle
  status: ReservationBookingStatus;
  source: ReservationBookingSource;
  cancelledAt: string | null;
  cancelledByUserId: number | null;
  cancellationReason: string | null;
  // Audit
  locale: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  // Joined fields
  serviceName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  workerFirstName: string | null;
  workerLastName: string | null;
  createdByFirstName: string | null;
  createdByLastName: string | null;
  reservationName: string | null;
  projectName: string | null;
}

export interface ReservationBookingCreateRequest {
  serviceId: number;
  startsAt: string;
  endsAt: string;
  customerId?: number;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  comment?: string;
  locale?: string;
  fields?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface ReservationBookingUpdateRequest {
  status: ReservationBookingStatus;
  cancellationReason?: string;
}

// ===========================================================================
// Service schedule DTOs
// ===========================================================================

export interface ReservationServiceScheduleDTO {
  id: number;
  serviceId: number;
  frequency: AvailabilityScheduleFrequency;
  dayOfWeek: number | null;
  dayOfMonth: number | null;
  startTime: string;
  endTime: string;
  createdAt: string;
}

// ===========================================================================
// Public catalog and availability
// ===========================================================================

export interface ReservationCatalogDTO {
  reservation: {
    id: number;
    title: string;
    defaultLocale: string;
    timezone: string;
  };
  services: Array<{
    id: number;
    name: string;
    description: string | null;
    durationMinutes: number;
    priceAmount: number;
    currency: string;
    capacity: number;
    workerName: string | null;
    imageUrl: string | null;
    fields: Array<{
      fieldKey: string;
      fieldType: string;
      required: boolean;
      sortOrder: number;
      options: string[] | null;
      label: string;
      placeholder: string | null;
    }>;
  }>;
}

export interface ReservationServiceAvailabilityDTO {
  timezone: string;
  days: Array<{
    date: string;
    available: boolean;
  }>;
  slots: Array<{
    startsAt: string;
    endsAt: string;
    date: string;
    startTime: string;
    endTime: string;
    capacity: number;
    remainingSeats: number;
  }>;
}

// ===========================================================================
// Reservation calendar types — admin calendar summary + day details
// ===========================================================================

export interface CalendarSlotSummary {
  date: string;
  serviceId: number;
  serviceName: string;
  workerUserId: number | null;
  workerInitial: string | null;
  startTime: string;
  endTime: string;
  seatsTaken: number;
  capacity: number;
}

export interface CalendarMonthResponse {
  month: string;
  slots: CalendarSlotSummary[];
}

export interface CalendarBookingCustomer {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export interface CalendarBookingSummary {
  id: number;
  customer: CalendarBookingCustomer;
  status: ReservationBookingStatus;
  cancellationReason: string | null;
}

export interface CalendarSessionSummary {
  workerFirstName: string | null;
  workerLastName: string | null;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  seatsTaken: number;
  capacity: number;
  bookings: CalendarBookingSummary[];
}

export interface CalendarServiceDetails {
  serviceId: number;
  serviceName: string;
  price: number;
  sessions: CalendarSessionSummary[];
}

export interface CalendarDayDetailsResponse {
  date: string;
  services: CalendarServiceDetails[];
}

// Public booking request (new, service-aware)
export interface ReservationPublicBookingRequest {
  serviceId: number;
  startsAt: string;
  endsAt: string;
  locale: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  comment?: string;
  fields?: Record<string, unknown>;
  /** When true, the server associates the profileToken with the customer. */
  rememberCustomer?: boolean;
  /** Opaque UUID token generated client-side for the "remember me" feature. */
  customerProfileToken?: string;
}
