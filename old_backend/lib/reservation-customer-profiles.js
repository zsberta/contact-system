// ---------------------------------------------------------------------------
// reservation-customer-profiles — opaque token ↔ customer association.
//
// The browser stores raw UUID tokens in localStorage. The server stores
// only the SHA-256 hash. This module provides:
//   - isValidReservationCustomerProfileToken(v) — UUID-v4 shape check
//   - hashReservationCustomerProfileToken(v)   — SHA-256 hex digest
//   - resolveReservationCustomerProfiles(…)    — token[] → customer data
//   - upsertReservationCustomerProfile(…)      — create/update association
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { pool } from "../db/pool.js";

// ---------------------------------------------------------------------------
// isValidReservationCustomerProfileToken — strict UUID-v4 regex.
// Only tokens matching this pattern reach the hashing layer.
// ---------------------------------------------------------------------------
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidReservationCustomerProfileToken(value) {
  return typeof value === "string" && UUID_V4_RE.test(value);
}

// ---------------------------------------------------------------------------
// hashReservationCustomerProfileToken — deterministic SHA-256 hex digest.
// Used for DB lookups and uniqueness checks.
// ---------------------------------------------------------------------------
export function hashReservationCustomerProfileToken(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

const MAX_PROFILE_TOKENS = 10;

// ---------------------------------------------------------------------------
// resolveReservationCustomerProfiles — given a reservation ID and an array
// of raw UUID tokens, return the matching active customer data paired with
// each raw token. Unknown/stale tokens are silently omitted.
//
// Returns an array in the same order as the input tokens (filtered to
// valid+resolved only).
// ---------------------------------------------------------------------------
export async function resolveReservationCustomerProfiles({
  db = pool,
  reservationId,
  profileTokens,
}) {
  if (!Array.isArray(profileTokens) || profileTokens.length === 0) return [];

  // Cap input and filter to valid UUID-v4 tokens only
  const validTokens = profileTokens
    .slice(0, MAX_PROFILE_TOKENS)
    .filter(isValidReservationCustomerProfileToken);

  if (validTokens.length === 0) return [];

  // Hash all valid tokens for DB lookup
  const tokenHashes = validTokens.map(hashReservationCustomerProfileToken);

  // Single query: find active profiles with their customer data
  const result = await db.query(
    `SELECT rcp.profile_token_hash,
            rc.id AS customer_id,
            rc.first_name,
            rc.last_name,
            rc.email,
            rc.phone,
            rc.status AS customer_status
     FROM reservation_customer_profiles rcp
     JOIN reservation_customers rc ON rc.id = rcp.customer_id
     WHERE rcp.reservation_id = $1
       AND rcp.profile_token_hash = ANY($2::text[])
       AND rc.status = 'active'`,
    [reservationId, tokenHashes],
  );

  // Build a lookup from hash → row
  const byHash = new Map();
  for (const row of result.rows) {
    byHash.set(row.profile_token_hash, row);
  }

  // Return in input order, pairing raw token with customer data
  const profiles = [];
  for (let i = 0; i < validTokens.length; i++) {
    const hash = tokenHashes[i];
    const row = byHash.get(hash);
    if (row) {
      profiles.push({
        profileToken: validTokens[i],
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        phone: row.phone,
      });
    }
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// upsertReservationCustomerProfile — create or update the token→customer
// mapping for a reservation. Uses the raw token (hashed internally).
//
// Returns the profile data on success, null on failure.
// ---------------------------------------------------------------------------
export async function upsertReservationCustomerProfile({
  db = pool,
  reservationId,
  customerId,
  profileToken,
}) {
  if (!isValidReservationCustomerProfileToken(profileToken)) return null;
  if (!reservationId || !customerId) return null;

  const tokenHash = hashReservationCustomerProfileToken(profileToken);

  try {
    const result = await db.query(
      `INSERT INTO reservation_customer_profiles (reservation_id, customer_id, profile_token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (reservation_id, profile_token_hash)
       DO UPDATE SET customer_id = EXCLUDED.customer_id,
                     updated_at = NOW()
       RETURNING id`,
      [reservationId, customerId, tokenHash],
    );

    if (result.rowCount === 0) return null;

    // Fetch the current customer data to return
    const custResult = await db.query(
      `SELECT first_name, last_name, email, phone
       FROM reservation_customers
       WHERE id = $1`,
      [customerId],
    );

    if (custResult.rowCount === 0) return null;

    const c = custResult.rows[0];
    return {
      profileToken,
      firstName: c.first_name,
      lastName: c.last_name,
      email: c.email,
      phone: c.phone,
    };
  } catch {
    // Best-effort — association failure must not break the booking flow
    return null;
  }
}
