// Admin-only CSV import module — fully isolated from the reservation
// endpoints. Reads the export CSVs from import_example/ shape:
//
//   Customers: "Contact Id","First Name","Last Name","Phone","Email",
//              "Business Name","Created","Last Activity","Tags"
//   Bookings:  Appointment ID,Calendar,First Name,Last Name,Email,Phone,
//              Start Time,End Time,Status
//
// Contract:
//   - Email is the unique customer key (reservation_customers already has
//     UNIQUE (project_id, email)); phone is a plain updatable field.
//   - Every import is dry-run first: POST /dry-run parses + validates and
//     returns per-row errors without writing anything.
//   - Bookings import is two-phase: services found in the Calendar column
//     are created first (POST /bookings/services), then bookings are
//   - Confirmed bookings get a customer auto-reply via notifySubmitter,
//     which funnels into the rate-limited lib/email-queue.js queue. With
//     the global EMAIL_SENDING=false kill switch nothing is enqueued at
//     all — the response reports emailsSending: false and 0 queued emails.
//   - Only future bookings (calendar date >= today in the reservation's
//     timezone) are emailed. Past bookings are imported silently.
//   - CSV timestamps carry explicit Budapest offsets (+02:00); they are
//     parsed to UTC instants and stored as TIMESTAMPTZ.

import express from "express";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { upsertReservationCustomer } from "../lib/reservation-booking.js";
import { notifySubmitter } from "../lib/email.js";

export const router = express.Router();
router.use(requireAuth);

// Admin-only gate for every import endpoint.
router.use((req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ errorMessage: "Admin access required" });
  }
  next();
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// CSV parsing — small RFC4180 parser (quotes, escaped quotes, BOM, CRLF).
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
  }
  return rows;
}

function rowsToRecords(rows) {
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = rows.slice(1).map((r, idx) => {
    const rec = { __row: idx + 2 }; // 1-based CSV line number (header = line 1)
    headers.forEach((h, i) => {
      rec[h] = (r[i] ?? "").trim();
    });
    return rec;
  });
  return { headers, records };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CUSTOMER_REQUIRED_HEADERS = ["First Name", "Last Name", "Email"];
const BOOKING_REQUIRED_HEADERS = [
  "Calendar",
  "First Name",
  "Last Name",
  "Email",
  "Start Time",
  "End Time",
  "Status",
];

// CSV status → reservation_bookings.status ('showed' = customer attended).
const BOOKING_STATUS_MAP = {
  confirmed: "confirmed",
  cancelled: "cancelled",
  showed: "attended",
};

function validateCustomerRecord(rec) {
  const errors = [];
  const firstName = rec["First Name"] || "";
  const lastName = rec["Last Name"] || "";
  const email = (rec["Email"] || "").toLowerCase();
  const phone = rec["Phone"] || "";

  if (!firstName) errors.push("First Name is required");
  if (!lastName) errors.push("Last Name is required");
  if (!email) errors.push("Email is required (email is the unique key)");
  else if (!EMAIL_RE.test(email)) errors.push(`Invalid email: ${email}`);

  return { ok: errors.length === 0, errors, data: { firstName, lastName, email, phone } };
}

function parseCsvTimestamp(value, label, errors) {
  if (!value) {
    errors.push(`${label} is required`);
    return null;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    errors.push(`Invalid ${label}: ${value}`);
    return null;
  }
  return d.toISOString();
}

function validateBookingRecord(rec) {
  const errors = [];
  const firstName = rec["First Name"] || "";
  const lastName = rec["Last Name"] || "";
  const email = (rec["Email"] || "").toLowerCase();
  const phone = rec["Phone"] || "";
  const serviceName = rec["Calendar"] || "";
  const rawStatus = (rec["Status"] || "").toLowerCase();

  if (!serviceName) errors.push("Calendar (service name) is required");
  if (!firstName) errors.push("First Name is required");
  if (!lastName) errors.push("Last Name is required");
  if (!email) errors.push("Email is required");
  else if (!EMAIL_RE.test(email)) errors.push(`Invalid email: ${email}`);

  const startsAt = parseCsvTimestamp(rec["Start Time"], "Start Time", errors);
  const endsAt = parseCsvTimestamp(rec["End Time"], "End Time", errors);
  if (startsAt && endsAt && !(new Date(endsAt) > new Date(startsAt))) {
    errors.push("End Time must be after Start Time");
  }

  if (!rawStatus) errors.push("Status is required");
  else if (!BOOKING_STATUS_MAP[rawStatus]) {
    errors.push(`Unknown status: ${rawStatus} (expected confirmed | cancelled | showed)`);
  }

  return {
    ok: errors.length === 0,
    errors,
    data: {
      firstName,
      lastName,
      email,
      phone,
      serviceName,
      startsAt,
      endsAt,
      status: BOOKING_STATUS_MAP[rawStatus] || null,
    },
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function resolveReservation(projectId) {
  const result = await pool.query(
    `SELECT id, project_id, secret_token, timezone, default_locale
     FROM reservations
     WHERE project_id = $1
     ORDER BY (status = 'active') DESC, id
     LIMIT 1`,
    [projectId],
  );
  return result.rows[0] || null;
}

async function assertProjectExists(projectId) {
  const result = await pool.query(`SELECT id FROM projects WHERE id = $1`, [projectId]);
  return result.rowCount > 0;
}

// Existing services for the project's reservation, matched by translated
// name (any locale) so Calendar values like "Reformer pilates - Évi" map.
async function listProjectServices(reservationId) {
  const result = await pool.query(
    `SELECT rs.id, rs.duration_minutes, rs.price_amount, rs.currency, rs.capacity, rs.status,
            COALESCE(rst.name, rst_any.name) AS name
     FROM reservation_services rs
     LEFT JOIN reservation_service_translations rst
       ON rst.service_id = rs.id AND rst.name IS NOT NULL
     LEFT JOIN LATERAL (
       SELECT t.name FROM reservation_service_translations t
       WHERE t.service_id = rs.id AND t.name IS NOT NULL
       LIMIT 1
     ) rst_any ON rst.name IS NULL
     WHERE rs.reservation_id = $1
     ORDER BY rs.sort_order, rs.id`,
    [reservationId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// POST /api/imports/dry-run  (multipart: file, projectId, importType)
// Parses + validates the CSV, returns per-row errors. No writes.
// ---------------------------------------------------------------------------

router.post("/dry-run", upload.single("file"), async (req, res) => {
  try {
    const projectId = parseInt(req.body?.projectId, 10);
    const importType = req.body?.importType;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    if (!["customers", "bookings"].includes(importType)) {
      return res.status(400).json({ errorMessage: "importType must be 'customers' or 'bookings'" });
    }
    if (!req.file) return res.status(400).json({ errorMessage: "CSV file is required" });
    if (!(await assertProjectExists(projectId))) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }

    const text = req.file.buffer.toString("utf-8");
    const { headers, records } = rowsToRecords(parseCsv(text));

    const requiredHeaders =
      importType === "customers" ? CUSTOMER_REQUIRED_HEADERS : BOOKING_REQUIRED_HEADERS;
    const missingHeaders = requiredHeaders.filter((h) => !headers.includes(h));
    if (missingHeaders.length > 0) {
      return res.status(400).json({
        errorMessage: `Missing required columns: ${missingHeaders.join(", ")}`,
        headers,
      });
    }

    const validate =
      importType === "customers" ? validateCustomerRecord : validateBookingRecord;
    const rows = records.map((rec) => {
      const v = validate(rec);
      return { rowNumber: rec.__row, ok: v.ok, errors: v.errors, data: v.data };
    });
    const validRows = rows.filter((r) => r.ok);
    const invalidRows = rows.filter((r) => !r.ok);

    const result = {
      importType,
      headers,
      totalRows: rows.length,
      validCount: validRows.length,
      invalidCount: invalidRows.length,
      rows,
    };

    if (importType === "bookings") {
      const reservation = await resolveReservation(projectId);
      if (!reservation) {
        return res.status(400).json({
          errorMessage: "No reservation module found for this project. Create one first.",
        });
      }
      const existingServices = await listProjectServices(reservation.id);
      // Distinct Calendar values with row counts + whether they already match.
      const byName = new Map();
      for (const r of validRows) {
        const name = r.data.serviceName;
        if (!byName.has(name)) byName.set(name, { name, rowCount: 0, sampleStart: r.data.startsAt, sampleEnd: r.data.endsAt });
        byName.get(name).rowCount++;
      }
      const services = [...byName.values()].map((s) => {
        const match = existingServices.find((e) => e.name === s.name);
        return {
          ...s,
          existingServiceId: match ? match.id : null,
          existingDurationMinutes: match ? match.duration_minutes : null,
        };
      });
      result.reservationId = reservation.id;
      result.timezone = reservation.timezone;
      result.existingServices = existingServices.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.duration_minutes,
        capacity: s.capacity,
      }));
      result.services = services;
    }

    return res.json(result);
  } catch (err) {
    console.error("[imports/dry-run]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/imports/services?projectId=N — existing services for mapping UI.
// ---------------------------------------------------------------------------

router.get("/services", async (req, res) => {
  try {
    const projectId = parseInt(req.query.projectId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    const reservation = await resolveReservation(projectId);
    if (!reservation) {
      return res.status(400).json({ errorMessage: "No reservation module found for this project" });
    }
    const services = await listProjectServices(reservation.id);
    return res.json({
      reservationId: reservation.id,
      timezone: reservation.timezone,
      services: services.map((s) => ({
        id: s.id,
        name: s.name,
        durationMinutes: s.duration_minutes,
        priceAmount: Number(s.price_amount),
        currency: s.currency,
        capacity: s.capacity,
        status: s.status,
      })),
    });
  } catch (err) {
    console.error("[imports/services/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/imports/bookings/services — create services from the Calendar
// column before importing bookings. Body: { projectId, services:
// [{ name, durationMinutes, priceAmount?, currency?, capacity? }] }.
// ---------------------------------------------------------------------------

router.post("/bookings/services", async (req, res) => {
  try {
    const projectId = parseInt(req.body?.projectId, 10);
    const services = req.body?.services;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    if (!Array.isArray(services) || services.length === 0) {
      return res.status(400).json({ errorMessage: "services array is required" });
    }
    const reservation = await resolveReservation(projectId);
    if (!reservation) {
      return res.status(400).json({ errorMessage: "No reservation module found for this project" });
    }

    const created = [];
    const errors = [];
    for (const [i, svc] of services.entries()) {
      const name = (svc.name || "").trim();
      const durationMinutes = parseInt(svc.durationMinutes, 10);
      const priceAmount = svc.priceAmount === undefined || svc.priceAmount === "" ? 0 : Number(svc.priceAmount);
      const currency = (svc.currency || "HUF").toUpperCase();
      const capacity = svc.capacity === undefined || svc.capacity === "" ? 1 : parseInt(svc.capacity, 10);

      if (!name) {
        errors.push({ index: i, name, error: "Service name is required" });
        continue;
      }
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        errors.push({ index: i, name, error: "durationMinutes must be > 0" });
        continue;
      }
      if (!Number.isFinite(priceAmount) || priceAmount < 0) {
        errors.push({ index: i, name, error: "priceAmount must be >= 0" });
        continue;
      }
      if (!/^[A-Z]{3}$/.test(currency)) {
        errors.push({ index: i, name, error: "currency must be 3 uppercase letters" });
        continue;
      }
      if (!Number.isFinite(capacity) || capacity < 1) {
        errors.push({ index: i, name, error: "capacity must be >= 1" });
        continue;
      }

      // Idempotency: skip if a service with the same translated name exists.
      const existing = await listProjectServices(reservation.id);
      const match = existing.find((e) => e.name === name);
      if (match) {
        created.push({ id: match.id, name, existing: true });
        continue;
      }

      const insertResult = await pool.query(
        `INSERT INTO reservation_services
           (reservation_id, status, sort_order, duration_minutes, price_amount, currency, capacity,
            granularity, lead_time_minutes, max_advance_days)
         VALUES ($1, 'active', $2, $3, $4, $5, $6, 'hour', 0, 365)
         RETURNING id`,
        [reservation.id, existing.length + i, durationMinutes, priceAmount, currency, capacity],
      );
      const serviceId = insertResult.rows[0].id;
      await pool.query(
        `INSERT INTO reservation_service_translations (service_id, locale, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (service_id, locale) DO UPDATE SET name = EXCLUDED.name`,
        [serviceId, reservation.default_locale || "hu", name],
      );
      created.push({ id: serviceId, name, existing: false });
    }

    return res.status(201).json({ created, errors });
  } catch (err) {
    console.error("[imports/bookings/services]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/imports/customers — upsert customers by (project_id, email).
// Body: { projectId, rows: [{ firstName, lastName, email, phone? }] }.
// ---------------------------------------------------------------------------

router.post("/customers", async (req, res) => {
  try {
    const projectId = parseInt(req.body?.projectId, 10);
    const rows = req.body?.rows;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ errorMessage: "rows array is required" });
    }
    if (!(await assertProjectExists(projectId))) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }

    const results = [];
    for (const [i, row] of rows.entries()) {
      const v = validateCustomerRecord({
        "First Name": row.firstName,
        "Last Name": row.lastName,
        Email: row.email,
        Phone: row.phone,
      });
      if (!v.ok) {
        results.push({ rowNumber: row.rowNumber ?? i + 2, ok: false, errors: v.errors });
        continue;
      }
      try {
        const customer = await upsertReservationCustomer({
          projectId,
          contact: { ...v.data, phone: v.data.phone || "" }, // phone column is NOT NULL
        });
        results.push({ rowNumber: row.rowNumber ?? i + 2, ok: true, customerId: customer.id });
      } catch (err) {
        results.push({ rowNumber: row.rowNumber ?? i + 2, ok: false, errors: [err.message] });
      }
    }

    return res.json({
      imported: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err) {
    console.error("[imports/customers]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/imports/bookings — import bookings after services exist.
// Body: { projectId, bookings: [{ serviceId, firstName, lastName, email,
//         phone?, startsAt, endsAt, status }] }.
// Confirmed bookings get a customer confirmation email via notifySubmitter
// (rate-limited queue). Only future bookings (calendar date >= today in the
// reservation's timezone) are emailed. While EMAIL_SENDING=false nothing is
// enqueued and the response reports emailsSending: false.
// ---------------------------------------------------------------------------

router.post("/bookings", async (req, res) => {
  const client = await pool.connect();
  try {
    const projectId = parseInt(req.body?.projectId, 10);
    const bookings = req.body?.bookings;
    if (!Number.isFinite(projectId) || projectId <= 0) {
      client.release();
      return res.status(400).json({ errorMessage: "Invalid projectId" });
    }
    if (!Array.isArray(bookings) || bookings.length === 0) {
      client.release();
      return res.status(400).json({ errorMessage: "bookings array is required" });
    }
    const reservation = await resolveReservation(projectId);
    if (!reservation) {
      client.release();
      return res.status(400).json({ errorMessage: "No reservation module found for this project" });
    }
    const services = await listProjectServices(reservation.id);

    const results = [];
    const emailedBookings = [];
    // Kill switch: with EMAIL_SENDING=false nothing may enter the email
    // queue. emailedBookings stays empty, so no notifySubmitter call runs
    // and the response reports emailsSending: false.
    const sending = process.env.EMAIL_SENDING !== "false";

    // Date formatter for the reservation's timezone — used to compare
    // calendar dates (YYYY-MM-DD) so a booking at 23:00 Budapest and
    // the current time 01:00 Budapest the next day are compared as
    // dates, not shifted by the UTC offset.
    const tz = reservation.timezone || "Europe/Budapest";
    const dateFmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    for (const [i, b] of bookings.entries()) {
      const rowNumber = b.rowNumber ?? i + 2;
      try {
        // pg returns BIGSERIAL ids as strings — compare numerically on both sides.
        const service = services.find((s) => parseInt(s.id, 10) === parseInt(b.serviceId, 10));
        if (!service) {
          results.push({ rowNumber, ok: false, errors: [`Unknown serviceId: ${b.serviceId}`] });
          continue;
        }
        if (!b.email || !EMAIL_RE.test(b.email)) {
          results.push({ rowNumber, ok: false, errors: ["Valid email is required"] });
          continue;
        }
        const startsAt = b.startsAt ? new Date(b.startsAt).toISOString() : null;
        const endsAt = b.endsAt ? new Date(b.endsAt).toISOString() : null;
        if (!startsAt || !endsAt || !(new Date(endsAt) > new Date(startsAt))) {
          results.push({ rowNumber, ok: false, errors: ["Invalid time range"] });
          continue;
        }
        if (!["confirmed", "cancelled", "attended", "completed", "no_show"].includes(b.status)) {
          results.push({ rowNumber, ok: false, errors: [`Invalid status: ${b.status}`] });
          continue;
        }

        // Duplicate guard — same email already booked into this exact slot.
        const dup = await client.query(
          `SELECT 1 FROM reservation_bookings
           WHERE service_id = $1 AND starts_at = $2 AND email = $3 LIMIT 1`,
          [service.id, startsAt, b.email.toLowerCase()],
        );
        if (dup.rowCount > 0) {
          results.push({ rowNumber, ok: true, skipped: "duplicate" });
          continue;
        }

        // Upsert customer by (project_id, email); phone is a plain field.
        const customer = await upsertReservationCustomer({
          db: client,
          projectId,
          contact: {
            firstName: b.firstName || "",
            lastName: b.lastName || "",
            email: b.email.toLowerCase(),
            phone: b.phone || "",
          },
        });

        const insertResult = await client.query(
          `INSERT INTO reservation_bookings (
             reservation_id, service_id, starts_at, ends_at,
             first_name, last_name, email, phone,
             customer_id, service_name_snapshot, duration_minutes_snapshot,
             price_amount_snapshot, currency_snapshot, timezone,
             status, source, locale
           ) VALUES (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'import', 'hu'
           )
           RETURNING id, booking_token`,
          [
            reservation.id,
            service.id,
            startsAt,
            endsAt,
            b.firstName || null,
            b.lastName || null,
            b.email.toLowerCase(),
            b.phone || null,
            customer.id,
            service.name || null,
            service.duration_minutes,
            service.price_amount || 0,
            service.currency || "HUF",
            reservation.timezone || "UTC",
            b.status,
          ],
        );

        const booking = insertResult.rows[0];
        results.push({ rowNumber, ok: true, bookingId: booking.id });
        // Only confirmed future bookings get a confirmation email.
        // "Future" = the booking's calendar date (in the reservation's
        // timezone) is today or later. Past bookings are imported silently.
        // Skipped entirely while EMAIL_SENDING=false.
        const bookingDate = dateFmt.format(new Date(startsAt));
        const todayDate = dateFmt.format(new Date());
        if (sending && b.status === "confirmed" && bookingDate >= todayDate) {
          emailedBookings.push({
            bookingId: booking.id,
            bookingToken: booking.booking_token,
            email: b.email.toLowerCase(),
            firstName: b.firstName,
            lastName: b.lastName,
            serviceName: service.name,
            startsAt,
            endsAt,
          });
        }
      } catch (err) {
        results.push({ rowNumber, ok: false, errors: [err.message] });
      }
    }

    client.release();

    // Rate-limited queue: notifySubmitter → enqueueMail per confirmed
    // booking. emailedBookings is empty when EMAIL_SENDING=false, so
    // nothing is enqueued.
    for (const e of emailedBookings) {
      notifySubmitter({
        kind: "reservation",
        projectId,
        formName: e.serviceName || "Reservation",
        data: null,
        locale: "hu",
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        bookingId: e.bookingId,
        serviceName: e.serviceName,
        email: e.email,
        bookingToken: e.bookingToken,
        secretToken: reservation.secret_token,
        timezone: reservation.timezone || "UTC",
      }).catch(() => {});
    }

    return res.json({
      imported: results.filter((r) => r.ok && !r.skipped).length,
      skippedDuplicates: results.filter((r) => r.skipped === "duplicate").length,
      failed: results.filter((r) => !r.ok).length,
      emailsQueued: emailedBookings.length,
      emailsSending: sending,
      results,
    });
  } catch (err) {
    client.release();
    console.error("[imports/bookings]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
