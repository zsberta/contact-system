-- Up Migration
--
-- Backfill reservation_customers from existing booking contact data.
-- Creates one customer per (project_id, lower(email)) using the latest
-- booking's name/phone, then links unlinked bookings.

INSERT INTO reservation_customers (project_id, first_name, last_name, email, phone, created_at, updated_at)
SELECT DISTINCT ON (r.project_id, lower(rb.email))
  r.project_id,
  rb.first_name,
  rb.last_name,
  rb.email,
  rb.phone,
  NOW(),
  NOW()
FROM reservation_bookings rb
JOIN reservations r ON r.id = rb.reservation_id
WHERE rb.first_name IS NOT NULL
  AND rb.last_name IS NOT NULL
  AND rb.email IS NOT NULL
  AND rb.phone IS NOT NULL
  AND rb.email != ''
  AND rb.first_name != ''
  AND rb.last_name != ''
  AND rb.phone != ''
ORDER BY r.project_id, lower(rb.email), rb.starts_at DESC
ON CONFLICT (project_id, email) DO NOTHING;

-- Link existing bookings to their customer (where not already linked)
-- Uses a subquery to avoid PostgreSQL's restriction on referencing the
-- target table from the FROM clause in an UPDATE ... FROM ... WHERE.
UPDATE reservation_bookings
SET customer_id = (
  SELECT rc.id
  FROM reservation_customers rc
  JOIN reservations r ON r.id = reservation_bookings.reservation_id
  WHERE r.project_id = rc.project_id
    AND lower(reservation_bookings.email) = lower(rc.email)
  LIMIT 1
)
WHERE customer_id IS NULL
  AND email IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM reservation_customers rc2
    JOIN reservations r2 ON r2.id = reservation_bookings.reservation_id
    WHERE r2.project_id = rc2.project_id
      AND lower(reservation_bookings.email) = lower(rc2.email)
  );

-- Down Migration (non-destructive: only unlink, do not delete customers or bookings)
UPDATE reservation_bookings SET customer_id = NULL WHERE customer_id IS NOT NULL;
