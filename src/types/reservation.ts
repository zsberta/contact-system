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
  slug: string;
  secretToken: string;
  projectId: number;
  projectName: string;
  allowedOrigins: string[];
  status: ReservationStatus;
  // Reservation-specific config
  granularity: ReservationGranularity;
  slotDurationMinutes: number | null;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  extraFieldsEnabled: boolean;
  disableHungarianHolidays: boolean;
  // Audit
  createdAt: string;
  updatedAt: string;
}

// POST /api/reservations body. `secretToken` is server-generated and not
// accepted here. `slug` must be unique across all reservations.
export interface ReservationCreateDTO {
  name: string;
  slug: string;
  projectId: number;
  allowedOrigins: string[];
  status?: ReservationStatus;
  granularity: ReservationGranularity;
  slotDurationMinutes?: number | null;
  leadTimeMinutes?: number;
  maxAdvanceDays?: number;
  extraFieldsEnabled?: boolean;
  disableHungarianHolidays?: boolean;
}

// PUT /api/reservations/:id body. `projectId` and `secretToken` are
// immutable post-create; the BE rejects any payload containing them (see
// routes/reservations.js). `slug` is editable — collision → 409.
export interface ReservationUpdateDTO {
  name?: string;
  slug?: string;
  allowedOrigins?: string[];
  status?: ReservationStatus;
  granularity?: ReservationGranularity;
  slotDurationMinutes?: number | null;
  leadTimeMinutes?: number;
  maxAdvanceDays?: number;
  extraFieldsEnabled?: boolean;
  disableHungarianHolidays?: boolean;
}

// Snippet response from GET /api/reservations/:id/snippet.
export interface ReservationSnippetResponse {
  html: string;
  secretToken: string;
  slug: string;
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
export interface ReservationBookingDTO {
  id: number;
  reservationId: number;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  locale: string | null;
  // Validated bag — plain JSONB. Only populated when the reservation has
  // `extraFieldsEnabled` true AND the visitor supplied it.
  data: Record<string, unknown> | null;
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
}

// Public submission request body — used by the landing page widget.
export interface ReservationBookingRequest {
  startsAt: string;
  endsAt: string;
  locale?: string;
  data?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Disabled ranges — operator-declared blackouts where no bookings are allowed.
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
}

// POST /api/reservations/:id/disabled-ranges body.
export interface ReservationDisabledRangeCreateDTO {
  startsAt: string;
  endsAt: string;
  reason?: string | null;
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
