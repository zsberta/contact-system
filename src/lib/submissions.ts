// API client for the cross-project Submissions Overview page.
// All endpoints live under /api/submissions.

import { apiFetch } from "@/lib/api";
import type { Page } from "@/types/common";
import type {
  CalendarResponse,
  SubmissionBookingDTO,
  SubmissionFormDTO,
  SubmissionsQueryParams,
} from "@/types/submissions";

// ---------------------------------------------------------------------------
// Form submissions (cross-project)
// ---------------------------------------------------------------------------

export type SubmissionFormPage = Page<SubmissionFormDTO>;

export async function getSubmissionForms(
  params: SubmissionsQueryParams = {},
): Promise<SubmissionFormPage> {
  const q = new URLSearchParams();
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.size !== undefined) q.set("size", String(params.size));
  if (params.sortField) q.set("sortField", params.sortField);
  if (params.sortOrder) q.set("sortOrder", params.sortOrder);
  if (params.projectId !== undefined) q.set("projectId", String(params.projectId));
  (params.queries ?? []).forEach((qq) => q.append("queries", qq));
  if (params.filterType) q.set("filterType", params.filterType);
  const qs = q.toString();
  return apiFetch<SubmissionFormPage>(
    `/submissions/forms${qs ? `?${qs}` : ""}`,
    { signal: params.signal },
  );
}

// ---------------------------------------------------------------------------
// Reservation bookings (cross-project)
// ---------------------------------------------------------------------------

export type SubmissionBookingPage = Page<SubmissionBookingDTO>;

export async function getSubmissionBookings(
  params: SubmissionsQueryParams = {},
): Promise<SubmissionBookingPage> {
  const q = new URLSearchParams();
  if (params.page !== undefined) q.set("page", String(params.page));
  if (params.size !== undefined) q.set("size", String(params.size));
  if (params.sortField) q.set("sortField", params.sortField);
  if (params.sortOrder) q.set("sortOrder", params.sortOrder);
  if (params.projectId !== undefined) q.set("projectId", String(params.projectId));
  (params.queries ?? []).forEach((qq) => q.append("queries", qq));
  if (params.filterType) q.set("filterType", params.filterType);
  const qs = q.toString();
  return apiFetch<SubmissionBookingPage>(
    `/submissions/bookings${qs ? `?${qs}` : ""}`,
    { signal: params.signal },
  );
}

// ---------------------------------------------------------------------------
// Calendar (cross-project)
// ---------------------------------------------------------------------------

export async function getSubmissionsCalendar(
  from: string,
  to: string,
  projectId?: number,
): Promise<CalendarResponse> {
  const q = new URLSearchParams();
  q.set("from", from);
  q.set("to", to);
  if (projectId !== undefined) q.set("projectId", String(projectId));
  return apiFetch<CalendarResponse>(
    `/submissions/bookings/calendar?${q.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Custom booking creation (admin-only)
// ---------------------------------------------------------------------------

export async function createSubmissionBooking(
  reservationId: number,
  startsAt: string,
  endsAt: string,
  comment?: string,
): Promise<SubmissionBookingDTO> {
  const body: Record<string, unknown> = { reservationId, startsAt, endsAt };
  if (comment && comment.trim()) {
    body.data = { comment: comment.trim() };
  }
  return apiFetch<SubmissionBookingDTO>("/submissions/bookings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
