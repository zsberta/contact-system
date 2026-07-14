// Submission DTOs for the cross-project Submissions Overview page.
// These extend the existing form/reservation DTOs with project context.

import type { Page } from "@/types/common";

// Cross-project form submission — extends FormSubmissionDTO with form + project info.
export interface SubmissionFormDTO {
  id: number;
  formId: number;
  formName: string;
  projectId: number;
  projectName: string;
  submittedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  data: Record<string, unknown>;
  locale: string | null;
  createdAt: string;
}

// Cross-project reservation booking — extends ReservationBookingDTO with reservation + project info.
export interface SubmissionBookingDTO {
  id: number;
  reservationId: number;
  reservationName: string;
  projectId: number;
  projectName: string;
  startsAt: string;
  endsAt: string;
  bookedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  referer: string | null;
  locale: string | null;
  data: Record<string, unknown> | null;
}

// Calendar booking — same as SubmissionBookingDTO plus reservation config fields.
export interface CalendarBookingDTO extends SubmissionBookingDTO {
  granularity: string;
  slotDurationMinutes: number | null;
}

// Active reservation available for custom booking creation.
export interface ActiveReservationDTO {
  id: number;
  name: string;
  projectId: number;
  projectName: string;
  granularity: string;
  slotDurationMinutes: number | null;
  status: string;
}

// Calendar response.
export interface CalendarResponse {
  bookings: CalendarBookingDTO[];
  reservations: ActiveReservationDTO[];
}

// Query params for cross-project submissions list.
export interface SubmissionsQueryParams {
  page?: number;
  size?: number;
  sortField?: string;
  sortOrder?: "asc" | "desc";
  queries?: string[];
  filterType?: "any" | "all";
  projectId?: number;
  signal?: AbortSignal;
}
