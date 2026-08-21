// ---------------------------------------------------------------------------
// reservation-booking — shared transaction helpers for public and admin
// booking creation. Handles customer upsert, capacity enforcement via
// advisory lock, and booking insert in a single transaction.
//
// Replaces the old one-booking EXCLUDE constraint with per-service
// advisory-lock capacity enforcement. This supports multiple-seat
// services safely.
// ---------------------------------------------------------------------------

import { pool } from "../db/pool.js";
import { checkSlotAvailability } from "./reservation-availability.js";

// ---------------------------------------------------------------------------
// upsertReservationCustomer — insert or update a project-scoped customer.
//
// Public submissions always create/update a customer. Admin/enduser calls
// may select an existing customer ID instead.
//
// Returns the customer DTO row.
// ---------------------------------------------------------------------------

export async function upsertReservationCustomer({ db, projectId, contact }) {
  const client = db || pool;
  const { firstName, lastName, email, phone } = contact;

  const result = await client.query(
    `INSERT INTO reservation_customers (project_id, first_name, last_name, email, phone)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, email) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       phone = EXCLUDED.phone,
       updated_at = NOW()
     RETURNING id, project_id, first_name, last_name, email, phone, status, created_at, updated_at`,
    [projectId, firstName, lastName, email, phone],
  );

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// createReservationBooking — transactional booking creation with
// per-service capacity enforcement.
//
// Flow:
//   1. BEGIN
//   2. Advisory lock on service (prevents concurrent capacity races)
//   3. Validate service is active
//   4. Re-check disabled ranges and effective schedules
//   5. Count confirmed overlapping bookings for this service
//   6. Reject with SLOT_FULL when count >= capacity
//   7. Upsert customer
//   8. Insert booking with snapshot fields
//   9. COMMIT
//
// On any error: ROLLBACK and return error.
//
// Returns { booking, customer } or { error, code }.
// ---------------------------------------------------------------------------

export async function createReservationBooking({
  db = pool,
  reservation,
  service,
  startsAtIso,
  endsAtIso,
  contact,
  customerId,
  customData,
  locale,
  createdByUserId,
  source,
  workerUserId,
}) {
  const client = db;
  let booking = null;
  let customer = null;

  try {
    await client.query("BEGIN");

    // 1. Advisory lock on the service — prevents two concurrent bookings
    //    from both seeing the same remaining seats.
    //    Use hashtext on the service ID to get a stable lock key.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('reservation-service:' || $1::text, 0))`,
      [String(service.id)],
    );

    // 2. Validate service is active
    const svcResult = await client.query(
      `SELECT id, status, duration_minutes, capacity, worker_user_id
       FROM reservation_services
       WHERE id = $1 AND reservation_id = $2
       FOR UPDATE`,
      [service.id, reservation.id],
    );
    if (svcResult.rowCount === 0 || svcResult.rows[0].status !== "active") {
      await client.query("ROLLBACK");
      return { error: "Service is not available", code: "SERVICE_UNAVAILABLE" };
    }
    const svc = svcResult.rows[0];

    // 3. Re-check disabled ranges (service-scoped)
    const disabledCheck = await checkSlotAvailability(
      reservation.id,
      service.id,
      startsAtIso,
      endsAtIso,
      client,
    );
    if (!disabledCheck.available) {
      await client.query("ROLLBACK");
      return { error: disabledCheck.reason, code: "SLOT_UNAVAILABLE" };
    }

    // 4. Count confirmed overlapping bookings for this service
    const overlapResult = await client.query(
      `SELECT COUNT(*)::int AS cnt
       FROM reservation_bookings
       WHERE service_id = $1
         AND status = 'confirmed'
         AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')`,
      [service.id, startsAtIso, endsAtIso],
    );
    const overlapCount = overlapResult.rows[0]?.cnt || 0;

    // Duplicate booking check — same customer (email or phone) for same slot
    if (contact?.email || contact?.phone) {
      const dupResult = await client.query(
        `SELECT 1
         FROM reservation_bookings
         WHERE service_id = $1
           AND status = 'confirmed'
           AND tstzrange(starts_at, ends_at, '[)') && tstzrange($2, $3, '[)')
           AND (email = $4 OR phone = $5)
         LIMIT 1`,
        [service.id, startsAtIso, endsAtIso, contact?.email || null, contact?.phone || null],
      );
      if (dupResult.rowCount > 0) {
        await client.query("ROLLBACK");
        return { error: "Erre az időpontra már van foglalásod.", code: "DUPLICATE_BOOKING" };
      }
    }

    if (overlapCount >= svc.capacity) {
      await client.query("ROLLBACK");
      return { error: "Slot already booked", code: "SLOT_FULL" };
    }

    // 5. Upsert or use existing customer
    let resolvedCustomerId = customerId || null;
    if (contact) {
      const cust = await upsertReservationCustomer({
        db: client,
        projectId: reservation.project_id,
        contact,
      });
      resolvedCustomerId = cust.id;
      customer = cust;
    }

    // 6. Insert the booking
    const insertResult = await client.query(
      `INSERT INTO reservation_bookings (
         reservation_id, service_id, starts_at, ends_at,
         first_name, last_name, email, phone, comment,
         customer_id, created_by_user_id, worker_user_id,
         service_name_snapshot, duration_minutes_snapshot,
         price_amount_snapshot, currency_snapshot, timezone,
         status, source, locale, data
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12,
         $13, $14,
         $15, $16, $17,
         'confirmed', $18, $19, $20::jsonb
       )
       RETURNING id, reservation_id, service_id, starts_at, ends_at,
                 first_name, last_name, email, phone, comment,
                 customer_id, created_by_user_id, worker_user_id,
                 service_name_snapshot, duration_minutes_snapshot,
                 price_amount_snapshot, currency_snapshot, timezone,
                 status, source, locale`,
      [
        reservation.id,
        service.id,
        startsAtIso,
        endsAtIso,
        contact?.firstName || null,
        contact?.lastName || null,
        contact?.email || null,
        contact?.phone || null,
        contact?.comment || null,
        resolvedCustomerId,
        createdByUserId || null,
        workerUserId || svc.worker_user_id || null,
        service.name || null,
        svc.duration_minutes,
        service.price_amount || 0,
        service.currency || "HUF",
        reservation.timezone || "UTC",
        source || "public",
        locale || "hu",
        customData ? JSON.stringify(customData) : null,
      ],
    );

    booking = insertResult.rows[0];

    await client.query("COMMIT");
    return { booking, customer };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

// ---------------------------------------------------------------------------
// rowToReservationCustomerDTO — snake_case DB row → camelCase API DTO.
// ---------------------------------------------------------------------------

export function rowToReservationCustomerDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// rowToReservationBookingDTO — snake_case DB row → camelCase API DTO.
// Enriched with service, customer, worker, and status fields.
// ---------------------------------------------------------------------------

export function rowToReservationBookingDTO(row) {
  if (!row) return null;
  return {
    id: row.id,
    reservationId: row.reservation_id,
    serviceId: row.service_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bookedAt: row.booked_at,
    // Contact fields
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    comment: row.comment,
    // References
    customerId: row.customer_id,
    createdByUserId: row.created_by_user_id,
    workerUserId: row.worker_user_id,
    // Snapshots
    serviceNameSnapshot: row.service_name_snapshot,
    durationMinutesSnapshot: row.duration_minutes_snapshot,
    priceAmountSnapshot: row.price_amount_snapshot != null
      ? Number(row.price_amount_snapshot)
      : null,
    currencySnapshot: row.currency_snapshot,
    timezone: row.timezone,
    // Lifecycle
    status: row.status,
    source: row.source,
    cancelledAt: row.cancelled_at,
    cancelledByUserId: row.cancelled_by_user_id,
    cancellationReason: row.cancellation_reason,
    // Audit
    locale: row.locale,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    referer: row.referer,
    data: row.data,
    createdAt: row.booked_at,
    // Joined fields (when present)
    serviceName: row.service_name || row.service_name_snapshot || null,
    customerName: row.customer_first_name
      ? `${row.customer_last_name} ${row.customer_first_name}`
      : null,
    customerEmail: row.customer_email || null,
    customerPhone: row.customer_phone || null,
    workerFirstName: row.worker_first_name || null,
    workerLastName: row.worker_last_name || null,
    createdByFirstName: row.created_by_first_name || null,
    createdByLastName: row.created_by_last_name || null,
    reservationName: row.reservation_name || null,
    projectName: row.project_name || null,
  };
}
