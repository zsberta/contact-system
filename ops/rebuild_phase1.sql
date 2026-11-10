-- ============================================================================
-- REBUILD reservations + services wiped by the 2026-11-10 migration
-- transition (recovery DROP TABLEs re-ran on live data).
--
-- TWO PHASES, each run separately in ONE transaction (psql with
-- ON_ERROR_STOP=1; any verification failure rolls everything back):
--
--   PHASE 1 (LIVE below): guards, reservation discovery, human-locked
--     project mapping, embed secrets, slugs, best-effort config,
--     recreation of log-referenced-but-missing services, then INSERTs of
--     project_modules + reservations (original ids), sequences, report,
--     COMMIT. Small on purpose: eyeball the result before proceeding.
--
--   PHASE 2 (COMMENTED OUT at the bottom of this file): booking staging
--     from logs (creates/updates/cancels/reschedules/emails), status
--     replay, loud skips, booking INSERTs with original ids,
--     rating_sent_at stamps, sequences, verification, COMMIT.
--     Uncomment + run ONLY after Phase 1 output is verified on the target.
--
-- TARGET FILL-INS (restore_input below): exact display names, optional
-- live embed secrets (NULL = auto-recover unanimous logged secret, else
-- fresh UUID-style token), project overrides (NULL = customer-vote
-- unanimity; contradiction with votes aborts loudly).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Guards: Phase-1 targets must be empty (never run twice / on live data)
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  IF (SELECT count(*) FROM reservations) > 0 THEN
    RAISE EXCEPTION 'refusing to run: reservations table is not empty';
  END IF;
  IF (SELECT count(*) FROM project_modules) > 0 THEN
    RAISE EXCEPTION 'refusing to run: project_modules table is not empty';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1. Human inputs: exact display names (+ optional secret / project override)
--    PROD values: res 1 -> project 5 (Berta Zsolt E.V.),
--                 res 2 -> project 10 (Orokmmozgo Centrum).
--    Adjust per target clone before test runs.
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE restore_input (
  id               bigint PRIMARY KEY,
  name             text NOT NULL,
  secret           text,    -- exact 22-char embed secret to keep; NULL = auto-recover
  project_override bigint   -- exact projects.id to force; NULL = auto-map
) ON COMMIT DROP;

INSERT INTO restore_input (id, name, secret, project_override) VALUES
  (1, 'Időpontfoglaló', NULL, 5),
  (2, 'Időpontfoglaló', NULL, 10);

CREATE TEMP TABLE restore_reservations (
  id            bigint PRIMARY KEY,
  project_id    bigint, -- derived in 1c (NULL = unmapped -> abort)
  name          text NOT NULL,
  slug          text,   -- derived in 1e
  secret_token  text,   -- derived in 1d (NULL = undecided)
  granularity   text NOT NULL DEFAULT 'hour',
  timezone      text NOT NULL DEFAULT 'Europe/Budapest',
  status        text NOT NULL DEFAULT 'active',
  default_locale text NOT NULL DEFAULT 'hu'
) ON COMMIT DROP;

-- 1a. id set: creates + surviving services + reservation logs
INSERT INTO restore_reservations (id, name)
SELECT DISTINCT v.reservation_id, 'TMP'
FROM (
  SELECT (metadata->'created'->>'reservationId')::bigint AS reservation_id
  FROM activity_logs WHERE action IN ('booking.create_public','booking.create_manual')
    AND (metadata->'created'->>'reservationId') ~ '^\d+$'
  UNION
  SELECT DISTINCT reservation_id FROM reservation_services
  UNION
  SELECT DISTINCT entity_id FROM activity_logs WHERE action LIKE 'reservation.%' AND entity_id IS NOT NULL
) v
WHERE v.reservation_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;

-- 1b. names from human input (exact match on id required, both directions)
UPDATE restore_reservations r SET name = i.name
FROM restore_input i WHERE i.id = r.id;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM restore_reservations r LEFT JOIN restore_input i ON i.id = r.id WHERE i.name IS NULL) THEN
    RAISE EXCEPTION 'restore mapping incomplete: discovered reservations missing from restore_input (%)', (SELECT string_agg(id::text, ', ') FROM restore_reservations r LEFT JOIN restore_input i ON i.id = r.id WHERE i.name IS NULL);
  END IF;
  IF EXISTS (SELECT 1 FROM restore_input i LEFT JOIN restore_reservations r ON r.id = i.id WHERE r.id IS NULL) THEN
    RAISE EXCEPTION 'restore_input references undiscovered reservations (%) — typo?', (SELECT string_agg(i.id::text, ', ') FROM restore_input i LEFT JOIN restore_reservations r ON r.id = i.id WHERE r.id IS NULL);
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1c. Project mapping: human override wins, else customer-vote unanimity.
--      Overrides contradicting unanimous votes abort (typo protection).
-- ----------------------------------------------------------------------------
UPDATE restore_reservations r SET project_id = i.project_override
FROM restore_input i WHERE i.id = r.id AND i.project_override IS NOT NULL;

UPDATE restore_reservations r SET project_id = v.project_id
FROM (
  SELECT res_id, min(project_id) AS project_id
  FROM (
    SELECT (b.metadata->'created'->>'reservationId')::bigint AS res_id, c.project_id
    FROM activity_logs b
    JOIN reservation_customers c
      ON lower(c.email) = lower(NULLIF(COALESCE(b.metadata->'created'->>'email', b.actor_email), ''))
    WHERE b.action IN ('booking.create_public', 'booking.create_manual')
      AND (b.metadata->'created'->>'reservationId') ~ '^\d+$'
  ) q
  WHERE res_id IS NOT NULL
  GROUP BY res_id HAVING count(DISTINCT project_id) = 1
) v
WHERE v.res_id = r.id AND r.project_id IS NULL;

-- every reservation must be mapped exactly once
DO $$ DECLARE rec RECORD; BEGIN
  FOR rec IN
    SELECT r.id,
           (SELECT string_agg(DISTINCT c.project_id::text, ', ')
            FROM activity_logs b
            JOIN reservation_customers c
              ON lower(c.email) = lower(NULLIF(COALESCE(b.metadata->'created'->>'email', b.actor_email), ''))
            WHERE b.action IN ('booking.create_public', 'booking.create_manual')
              AND (b.metadata->'created'->>'reservationId') ~ '^\d+$'
              AND (b.metadata->'created'->>'reservationId')::bigint = r.id) AS candidates
    FROM restore_reservations r WHERE r.project_id IS NULL
  LOOP
    RAISE EXCEPTION 'cannot map reservation % to a project (customer votes: %) — set project_override in restore_input', rec.id, COALESCE(rec.candidates, 'none');
  END LOOP;
END $$;

-- overrides must not contradict unanimous votes (typo protection)
DO $$ DECLARE rec RECORD; BEGIN
  FOR rec IN
    SELECT r.id, r.project_id AS forced, v.project_id AS voted
    FROM restore_reservations r
    JOIN restore_input i ON i.id = r.id AND i.project_override IS NOT NULL
    LEFT JOIN (
      SELECT res_id, min(project_id) AS project_id
      FROM (
        SELECT (b.metadata->'created'->>'reservationId')::bigint AS res_id, c.project_id
        FROM activity_logs b
        JOIN reservation_customers c
          ON lower(c.email) = lower(NULLIF(COALESCE(b.metadata->'created'->>'email', b.actor_email), ''))
        WHERE b.action IN ('booking.create_public', 'booking.create_manual')
          AND (b.metadata->'created'->>'reservationId') ~ '^\d+$'
      ) q
      WHERE res_id IS NOT NULL
      GROUP BY res_id HAVING count(DISTINCT project_id) = 1
    ) v ON v.res_id = r.id
  LOOP
    IF rec.voted IS NOT NULL AND rec.voted <> rec.forced THEN
      RAISE EXCEPTION 'project override % for reservation % contradicts customer votes (%)', rec.forced, rec.id, rec.voted;
    END IF;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 1d. Secrets: human value wins, else unanimous logged secret, else fresh
-- ----------------------------------------------------------------------------
UPDATE restore_reservations r SET secret_token = i.secret
FROM restore_input i WHERE i.id = r.id AND NULLIF(i.secret,'') IS NOT NULL;

-- secrets must be unanimous per reservation (else: rotated key — ask human)
DO $$ DECLARE rec RECORD; BEGIN
  FOR rec IN
    SELECT r.id, string_agg(DISTINCT sec.s, ' | ') AS secrets
    FROM restore_reservations r
    JOIN LATERAL (
      SELECT DISTINCT substring(a.metadata->>'url' from '/api/public/reservations/([^/]+)/bookings') AS s
      FROM activity_logs a
      JOIN reservation_services v ON v.id = (a.metadata->'created'->>'serviceId')::bigint
      WHERE a.action = 'booking.create_public' AND v.reservation_id = r.id
    ) sec ON true
    WHERE r.secret_token IS NULL
    GROUP BY r.id HAVING count(*) > 1
  LOOP
    RAISE EXCEPTION 'reservation % saw multiple embed secrets (%) — set the live one in restore_input.secret', rec.id, rec.secrets;
  END LOOP;
END $$;

UPDATE restore_reservations r SET secret_token = (
  SELECT DISTINCT substring(a.metadata->>'url' from '/api/public/reservations/([^/]+)/bookings')
  FROM activity_logs a
  JOIN reservation_services v ON v.id = (a.metadata->'created'->>'serviceId')::bigint
  WHERE a.action = 'booking.create_public' AND v.reservation_id = r.id
)
WHERE r.secret_token IS NULL;

UPDATE restore_reservations
SET secret_token = substring(translate(encode(gen_random_bytes(16), 'base64'), '+/=', '-_') from 1 for 22)
WHERE secret_token IS NULL;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM restore_reservations WHERE secret_token IS NULL OR length(secret_token) <> 22) THEN
    RAISE EXCEPTION 'unresolved embed secret remains';
  END IF;
  IF EXISTS (SELECT secret_token FROM restore_reservations GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate embed secrets generated';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1e. Slugs: unaccent + kebab-case; busiest reservation keeps the base slug
-- ----------------------------------------------------------------------------
UPDATE restore_reservations r SET slug = s.slug
FROM (
  SELECT id,
         CASE WHEN rn = 1 THEN base ELSE (left(base, 47) || '-' || rn::text) END AS slug
  FROM (
    SELECT id, base, row_number() OVER (ORDER BY nb DESC, id) AS rn
    FROM (
      SELECT r2.id,
             NULLIF(regexp_replace(regexp_replace(translate(lower(r2.name), 'áéíóöőúüű ', 'aeiooouuu-'), '[^a-z0-9-]+', '-', 'g'), '(^-+|-+$)', '', 'g'), '') AS base,
             (SELECT count(*) FROM activity_logs b
              WHERE b.action IN ('booking.create_public','booking.create_manual')
                AND (b.metadata->'created'->>'reservationId') ~ '^\d+$'
                AND (b.metadata->'created'->>'reservationId')::bigint = r2.id) AS nb
      FROM restore_reservations r2
    ) q
  ) q2
) s
WHERE s.id = r.id;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM restore_reservations WHERE slug IS NULL OR slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR length(slug) > 50) THEN
    RAISE EXCEPTION 'could not derive a valid slug';
  END IF;
  IF EXISTS (SELECT slug FROM restore_reservations GROUP BY 1 HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'duplicate slugs derived';
  END IF;
END $$;

-- ----------------------------------------------------------------------------
-- 1f. Config best-effort: latest reservation.update diff wins per column.
--      "null" strings and invalid values fall back to safe defaults.
-- ----------------------------------------------------------------------------
UPDATE restore_reservations r SET
  granularity = COALESCE(NULLIF(u.g, ''), 'hour'),
  timezone = COALESCE(NULLIF(u.tz, ''), 'Europe/Budapest'),
  status = COALESCE(NULLIF(u.st, ''), 'active'),
  default_locale = COALESCE(NULLIF(u.loc, ''), 'hu')
FROM (
  SELECT DISTINCT ON (entity_id) entity_id,
    CASE WHEN NULLIF(metadata->'diff'->'granularity'->>'to', 'null') IN ('day','hour','minute')
         THEN metadata->'diff'->'granularity'->>'to' END AS g,
    NULLIF(metadata->'diff'->'timezone'->>'to', 'null') AS tz,
    CASE WHEN NULLIF(metadata->'diff'->'status'->>'to', 'null') IN ('active','disabled')
         THEN metadata->'diff'->'status'->>'to' END AS st,
    NULLIF(metadata->'diff'->'default_locale'->>'to', 'null') AS loc
  FROM activity_logs
  WHERE action = 'reservation.update' AND entity_id IS NOT NULL
  ORDER BY entity_id, id DESC
) u
WHERE u.entity_id = r.id;

DO $$ DECLARE rec RECORD; BEGIN
  FOR rec IN SELECT id, granularity, timezone, status FROM restore_reservations LOOP
    RAISE NOTICE 'reservation % config: granularity=%, timezone=%, status=%', rec.id, rec.granularity, rec.timezone, rec.status;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 2. Missing services: ids referenced by booking creates that no longer
--    exist. Recreated with original id under the create's reservation,
--    duration = most common logged slot length, name = best-effort guess
--    from confirmation email subjects (else obvious placeholder).
-- ----------------------------------------------------------------------------
CREATE TEMP TABLE missing_services (
  service_id       bigint PRIMARY KEY,
  reservation_id   bigint NOT NULL,
  duration_minutes int NOT NULL DEFAULT 60,
  name_guess       text NOT NULL DEFAULT ''
) ON COMMIT DROP;

INSERT INTO missing_services (service_id, reservation_id)
SELECT DISTINCT
  (b.metadata->'created'->>'serviceId')::bigint,
  (b.metadata->'created'->>'reservationId')::bigint
FROM activity_logs b
WHERE b.action IN ('booking.create_public', 'booking.create_manual')
  AND (b.metadata->'created'->>'serviceId') ~ '^\d+$'
  AND (b.metadata->'created'->>'reservationId') ~ '^\d+$'
  AND NOT EXISTS (SELECT 1 FROM reservation_services v
                  WHERE v.id = (b.metadata->'created'->>'serviceId')::bigint)
ON CONFLICT (service_id) DO NOTHING;

-- reservation must be unambiguous per missing service (else: human decides)
DO $$ DECLARE rec RECORD; BEGIN
  FOR rec IN
    SELECT service_id, string_agg(DISTINCT reservation_id::text, ', ') AS cands
    FROM missing_services GROUP BY 1 HAVING count(DISTINCT reservation_id) > 1
  LOOP
    RAISE EXCEPTION 'service % referenced under multiple reservations (%) — map it manually', rec.service_id, rec.cands;
  END LOOP;
  FOR rec IN
    SELECT m.service_id FROM missing_services m
    WHERE NOT EXISTS (SELECT 1 FROM restore_reservations r WHERE r.id = m.reservation_id)
  LOOP
    RAISE EXCEPTION 'service % belongs to unrestored reservation — extend restore_input first', rec.service_id;
  END LOOP;
END $$;

-- duration: most common logged (ends-starts) for that service, else 60
UPDATE missing_services m SET duration_minutes = COALESCE((
  SELECT mins FROM (
    SELECT ((EXTRACT(EPOCH FROM ((b.metadata->'created'->>'endsAt')::timestamptz - (b.metadata->'created'->>'startsAt')::timestamptz)) / 60))::int AS mins,
           count(*) AS n
    FROM activity_logs b
    WHERE b.action IN ('booking.create_public', 'booking.create_manual')
      AND (b.metadata->'created'->>'serviceId') ~ '^\d+$'
      AND (b.metadata->'created'->>'serviceId')::bigint = m.service_id
      AND (b.metadata->'created'->>'startsAt') IS NOT NULL
      AND (b.metadata->'created'->>'endsAt') IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  ) q WHERE q.mins > 0), 60);

-- name: most common confirmation-subject prefix for that service's bookings
UPDATE missing_services m SET name_guess = COALESCE((
  SELECT nm FROM (
    SELECT nm, count(*) AS n FROM (
      SELECT CASE
        WHEN e.metadata->>'subject' LIKE 'Új foglalás: %'
          THEN regexp_replace(substring(e.metadata->>'subject' from 13), ' - \d{4}\..*$', '')
        ELSE regexp_replace(e.metadata->>'subject', ' - \d{4}\..*$', '')
      END AS nm
      FROM activity_logs e
      JOIN activity_logs b
        ON b.entity_id = e.entity_id
       AND b.action IN ('booking.create_public', 'booking.create_manual')
       AND (b.metadata->'created'->>'serviceId') ~ '^\d+$'
       AND (b.metadata->'created'->>'serviceId')::bigint = m.service_id
      WHERE e.action = 'email.send'
        AND (e.metadata->>'kind') = 'confirmation'
        AND NULLIF(e.metadata->>'subject', '') IS NOT NULL
    ) q WHERE NULLIF(trim(nm), '') IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1
  ) r), '');

UPDATE missing_services
SET name_guess = 'Visszaállított szolgáltatás ' || service_id
WHERE NULLIF(trim(name_guess), '') IS NULL;

DO $$ DECLARE rec RECORD; BEGIN
  IF NOT EXISTS (SELECT 1 FROM missing_services) THEN
    RAISE NOTICE 'no missing services — every log-referenced service still exists';
  END IF;
  FOR rec IN SELECT service_id, reservation_id, duration_minutes, name_guess FROM missing_services ORDER BY 1 LOOP
    RAISE NOTICE 'restoring missing service % (reservation %, % min, name: %)', rec.service_id, rec.reservation_id, rec.duration_minutes, rec.name_guess;
  END LOOP;
END $$;

INSERT INTO reservation_services (id, reservation_id, status, duration_minutes, price_amount, currency)
SELECT service_id, reservation_id, 'active', duration_minutes, 0, 'HUF'
FROM missing_services;

INSERT INTO reservation_service_translations (service_id, locale, name)
SELECT service_id, 'hu', name_guess FROM missing_services;

-- ----------------------------------------------------------------------------
-- 3. Orphaned services (pointing at unrestored reservations): report only
-- ----------------------------------------------------------------------------
DO $$ DECLARE o RECORD; BEGIN
  FOR o IN SELECT DISTINCT v.id, v.reservation_id FROM reservation_services v
           WHERE NOT EXISTS (SELECT 1 FROM restore_reservations rr WHERE rr.id = v.reservation_id)
           ORDER BY 1 LOOP
    RAISE NOTICE 'service % references unrestored reservation % (left orphaned, as before)', o.id, o.reservation_id;
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- 4. PHASE 1 WRITE: modules + reservations (original ids)
-- ----------------------------------------------------------------------------
INSERT INTO project_modules (project_id, module_type)
SELECT DISTINCT r.project_id, 'reservation'
FROM restore_reservations r
ON CONFLICT (project_id, module_type) DO NOTHING;

INSERT INTO reservations (
  id, project_id, name, slug, secret_token,
  module_id, status, granularity, timezone, default_locale
)
SELECT
  r.id, r.project_id, r.name, r.slug, r.secret_token,
  pm.id, r.status, r.granularity, r.timezone, r.default_locale
FROM restore_reservations r
JOIN project_modules pm
  ON pm.project_id = r.project_id AND pm.module_type = 'reservation';

-- sequences continue after restored ids
SELECT setval(pg_get_serial_sequence('reservations','id'), (SELECT max(id) FROM reservations));
SELECT setval(pg_get_serial_sequence('project_modules','id'), (SELECT max(id) FROM project_modules));
SELECT setval(pg_get_serial_sequence('reservation_services','id'), (SELECT max(id) FROM reservation_services));

-- ----------------------------------------------------------------------------
-- 5. PHASE 1 REPORT (read before COMMIT decision)
-- ----------------------------------------------------------------------------
SELECT 'phase1_reservations' AS metric, count(*)::text AS value FROM reservations
UNION ALL SELECT 'phase1_modules', count(*)::text FROM project_modules
UNION ALL SELECT 'phase1_services_total', count(*)::text FROM reservation_services
UNION ALL SELECT 'phase1_services_restored', count(*)::text FROM missing_services
UNION ALL SELECT 'phase1_bad_secrets', count(*)::text FROM reservations WHERE secret_token IS NULL OR length(secret_token) <> 22;

COMMIT;

/* ============================================================================
-- PHASE 2 (BOOKINGS) — COMMENTED OUT. Uncomment + run only after the Phase 1
-- report above is verified on the target (right projects, slugs, secrets,
-- services). Reads the RESTORED reservations rows (no temp tables survive
-- the Phase-1 COMMIT). Wraps everything in its own transaction.
--
-- NOTE: service_name_snapshot comes from reservation_service_translations
-- (hu preferred); reservation_services has no name column.
-- ============================================================================

-- BEGIN;

-- -- ----------------------------------------------------------------------------
-- -- 6. Guards: bookings must still be empty; Phase-1 rows must exist
-- -- ----------------------------------------------------------------------------
-- DO $$ BEGIN
--   IF (SELECT count(*) FROM reservation_bookings) > 0 THEN
--     RAISE EXCEPTION 'refusing phase 2: reservation_bookings is not empty';
--   END IF;
--   IF (SELECT count(*) FROM reservations) = 0 THEN
--     RAISE EXCEPTION 'refusing phase 2: run phase 1 first (no reservations)';
--   END IF;
--   IF (SELECT count(*) FROM reservation_ratings) > 0 THEN
--     RAISE EXCEPTION 'refusing phase 2: reservation_ratings is not empty (would orphan ratings)';
--   END IF;
-- END $$;

-- -- ----------------------------------------------------------------------------
-- -- 7. Stage bookings from logs (temp table, verified INSERT later)
-- -- ----------------------------------------------------------------------------
-- CREATE TEMP TABLE stage_bookings (
--   id                bigint PRIMARY KEY,
--   reservation_id    bigint, -- filled by fallbacks below; leftovers reported + skipped
--   service_id        bigint,
--   starts_at         timestamptz,
--   ends_at           timestamptz,
--   email             text,
--   first_name        text,
--   last_name         text,
--   phone             text,
--   status            text NOT NULL DEFAULT 'confirmed',
--   cancelled_at      timestamptz,
--   cancelled_by      bigint,
--   created_by        bigint,
--   worker_id         bigint,
--   user_agent        text,
--   source            text NOT NULL DEFAULT 'public',
--   booked_at         timestamptz
-- ) ON COMMIT DROP;

-- -- 7a. Base rows: every logged creation (full fidelity where present)
-- INSERT INTO stage_bookings (
--   id, reservation_id, service_id, starts_at, ends_at,
--   email, source, booked_at, user_agent
-- )
-- SELECT DISTINCT ON (b.entity_id)
--   b.entity_id,
--   NULLIF(b.metadata->'created'->>'reservationId', '')::bigint,
--   NULLIF(b.metadata->'created'->>'serviceId', '')::bigint,
--   NULLIF(b.metadata->'created'->>'startsAt', '')::timestamptz,
--   NULLIF(b.metadata->'created'->>'endsAt', '')::timestamptz,
--   NULLIF(COALESCE(b.metadata->'created'->>'email', b.actor_email), ''),
--   CASE WHEN b.action = 'booking.create_manual' THEN 'admin' ELSE 'public' END,
--   b.created_at,
--   b.metadata->>'userAgent'
-- FROM activity_logs b
-- WHERE b.action IN ('booking.create_public', 'booking.create_manual')
--   AND b.entity_id IS NOT NULL
-- ORDER BY b.entity_id, b.id;

-- -- 7b. reservation_id fallbacks: manual-create URL, then the service's link
-- UPDATE stage_bookings s SET reservation_id = (
--   SELECT NULLIF(substring(a.metadata->>'url' from '/api/reservations/([0-9]+)/bookings'), '')::bigint
--   FROM activity_logs a
--   WHERE a.action = 'booking.create_manual' AND a.entity_id = s.id
--   ORDER BY a.id LIMIT 1)
-- WHERE s.reservation_id IS NULL;

-- UPDATE stage_bookings s SET reservation_id = v.reservation_id
-- FROM reservation_services v
-- WHERE v.id = s.service_id AND s.reservation_id IS NULL;

-- -- 7c. guest identity: latest known name/email per booking
-- UPDATE stage_bookings s SET
--   email = COALESCE(NULLIF((SELECT d.metadata->'diff'->'customer_email'->>'to' FROM activity_logs d WHERE d.action IN ('booking.update','booking.cancel','booking.cancel_public') AND d.entity_id = s.id AND NULLIF(d.metadata->'diff'->'customer_email'->>'to','null') IS NOT NULL ORDER BY d.id DESC LIMIT 1), ''), s.email),
--   first_name = (SELECT NULLIF(d.metadata->'diff'->'customer_first_name'->>'to','null') FROM activity_logs d WHERE d.action IN ('booking.update','booking.cancel','booking.cancel_public') AND d.entity_id = s.id AND NULLIF(d.metadata->'diff'->'customer_first_name'->>'to','null') IS NOT NULL ORDER BY d.id DESC LIMIT 1),
--   last_name = (SELECT NULLIF(d.metadata->'diff'->'customer_last_name'->>'to','null') FROM activity_logs d WHERE d.action IN ('booking.update','booking.cancel','booking.cancel_public') AND d.entity_id = s.id AND NULLIF(d.metadata->'diff'->'customer_last_name'->>'to','null') IS NOT NULL ORDER BY d.id DESC LIMIT 1);

-- -- 7d. endsAt fallback: service duration (some creates logged startsAt only)
-- UPDATE stage_bookings s SET ends_at = s.starts_at + (v.duration_minutes || ' minutes')::interval
-- FROM reservation_services v
-- WHERE v.id = s.service_id AND s.ends_at IS NULL AND s.starts_at IS NOT NULL;

-- -- 7e. names/phone fallback: surviving customers matched by email (1:1 only)
-- UPDATE stage_bookings s SET
--   first_name = COALESCE(s.first_name, c.first_name),
--   last_name = COALESCE(s.last_name, c.last_name),
--   phone = COALESCE(s.phone, c.phone)
-- FROM reservation_customers c
-- WHERE lower(c.email) = lower(s.email) AND s.email IS NOT NULL
--   AND (SELECT count(*) FROM reservation_customers c2 WHERE lower(c2.email) = lower(s.email)) = 1;

-- -- 7f. email fallback: public booking confirmation recipient
-- UPDATE stage_bookings s SET email = (
--   SELECT e.metadata->>'to' FROM activity_logs e
--   WHERE e.action = 'email.send' AND (e.metadata->>'kind') = 'confirmation'
--     AND e.entity_id = s.id AND NULLIF(e.metadata->>'to','') IS NOT NULL
--   ORDER BY e.id LIMIT 1)
-- WHERE s.email IS NULL;

-- -- ----------------------------------------------------------------------------
-- -- 8. Cross-check: staged customer projects must match restored reservations.
-- --    (Mapping itself was locked in Phase 1; this only catches log drift.)
-- -- ----------------------------------------------------------------------------
-- DO $$ DECLARE rec RECORD; BEGIN
--   FOR rec IN
--     SELECT s.reservation_id,
--            string_agg(DISTINCT c.project_id::text, ', ') AS votes,
--            (SELECT project_id::text FROM reservations r WHERE r.id = s.reservation_id) AS restored
--     FROM stage_bookings s
--     JOIN reservation_customers c
--       ON lower(c.email) = lower(s.email)
--     WHERE s.email IS NOT NULL AND s.reservation_id IS NOT NULL
--       AND EXISTS (SELECT 1 FROM reservations r WHERE r.id = s.reservation_id)
--     GROUP BY s.reservation_id
--     HAVING count(DISTINCT c.project_id) > 1
--        OR min(c.project_id) <> (SELECT project_id FROM reservations r WHERE r.id = s.reservation_id)
--   LOOP
--     RAISE EXCEPTION 'phase 2: bookings for reservation % vote for projects (%) but it was restored under %', rec.reservation_id, rec.votes, rec.restored;
--   END LOOP;
-- END $$;

-- -- ----------------------------------------------------------------------------
-- -- 9. Reschedules: new rows were created for moved visits (no create log).
-- --    Pair each reschedule with its new booking: same guest + confirmation
-- --    email within 10 minutes. Unpairable reschedules only affect their own
-- --    old booking (left cancelled); they never block the restore.
-- -- ----------------------------------------------------------------------------
-- CREATE TEMP TABLE reschedule_pairs AS
-- SELECT r.entity_id AS old_id,
--        (SELECT e.entity_id FROM activity_logs e
--         WHERE e.action = 'email.send' AND (e.metadata->>'kind') = 'confirmation'
--           AND e.metadata->>'to' = COALESCE(NULLIF(r.actor_email,''),
--               (SELECT s.email FROM stage_bookings s WHERE s.id = r.entity_id))
--           AND e.created_at BETWEEN r.created_at AND r.created_at + interval '10 minutes'
--           AND e.entity_id IS NOT NULL
--           AND e.entity_id <> r.entity_id
--           AND NOT EXISTS (SELECT 1 FROM stage_bookings s2 WHERE s2.id = e.entity_id)
--         ORDER BY e.created_at LIMIT 1) AS new_id,
--        (r.metadata->'diff'->>'starts_at'->>'to') AS new_starts_raw,
--        r.created_at AS rescheduled_at,
--        (SELECT e.metadata->>'subject' FROM activity_logs e
--         WHERE e.action = 'email.send' AND (e.metadata->>'kind') = 'confirmation'
--           AND e.metadata->>'to' = COALESCE(NULLIF(r.actor_email,''),
--               (SELECT s.email FROM stage_bookings s WHERE s.id = r.entity_id))
--           AND e.created_at BETWEEN r.created_at AND r.created_at + interval '10 minutes'
--           AND e.entity_id IS NOT NULL
--           AND e.entity_id <> r.entity_id
--           AND NOT EXISTS (SELECT 1 FROM stage_bookings s2 WHERE s2.id = e.entity_id)
--         ORDER BY e.created_at LIMIT 1) AS new_subject
-- FROM activity_logs r WHERE r.action = 'booking.reschedule_public';

-- -- parse the JS date ("Tue Sep 22 2026 09:00:00 GMT+0000 (...)") locale-free (UTC)
-- ALTER TABLE reschedule_pairs ADD COLUMN new_starts_at timestamptz;
-- UPDATE reschedule_pairs SET new_starts_at = make_timestamptz(
--   parts[4]::int,
--   CASE parts[2] WHEN 'Jan' THEN 1 WHEN 'Feb' THEN 2 WHEN 'Mar' THEN 3 WHEN 'Apr' THEN 4
--     WHEN 'May' THEN 5 WHEN 'Jun' THEN 6 WHEN 'Jul' THEN 7 WHEN 'Aug' THEN 8
--     WHEN 'Sep' THEN 9 WHEN 'Oct' THEN 10 WHEN 'Nov' THEN 11 WHEN 'Dec' THEN 12 END,
--   parts[3]::int, parts[5]::int, parts[6]::int, 0, 'UTC')
-- FROM (SELECT old_id, regexp_match(new_starts_raw, '^(\w+) (\w+) (\d+) (\d+) (\d+):(\d+):(\d+)') AS parts
--       FROM reschedule_pairs WHERE new_id IS NOT NULL AND new_starts_raw IS NOT NULL) q
-- WHERE reschedule_pairs.old_id = q.old_id;

-- -- cross-check against the email subject where available; mismatch unlinks
-- UPDATE reschedule_pairs n SET new_id = NULL
-- WHERE n.new_id IS NOT NULL AND n.new_starts_at IS NOT NULL AND n.new_subject ~ '\d{4}\. \d{2}\. \d{2}\. \d{2}:\d{2}'
--   AND make_timestamptz(
--         (regexp_match(n.new_subject, '(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}):(\d{2})'))[1]::int,
--         (regexp_match(n.new_subject, '(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}):(\d{2})'))[2]::int,
--         (regexp_match(n.new_subject, '(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}):(\d{2})'))[3]::int,
--         (regexp_match(n.new_subject, '(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}):(\d{2})'))[4]::int,
--         (regexp_match(n.new_subject, '(\d{4})\. (\d{2})\. (\d{2})\. (\d{2}):(\d{2})'))[5]::int,
--         0, 'Europe/Budapest')
--       IS DISTINCT FROM n.new_starts_at;

-- -- duplicate new-ids would collide on insert: unlink with a loud notice
-- UPDATE reschedule_pairs SET new_id = NULL WHERE new_id IN (
--   SELECT new_id FROM reschedule_pairs WHERE new_id IS NOT NULL GROUP BY 1 HAVING count(*) > 1);
-- DO $$ DECLARE r RECORD; BEGIN
--   FOR r IN SELECT old_id, new_id FROM reschedule_pairs LOOP
--     IF r.new_id IS NULL THEN
--       RAISE NOTICE 'reschedule of booking % has no linkable new booking — old row restored as cancelled, no new row', r.old_id;
--     ELSE
--       RAISE NOTICE 'reschedule: old booking % -> new booking %', r.old_id, r.new_id;
--     END IF;
--   END LOOP;
-- END $$;

-- -- new row = the moved visit (service/guest/timeslot from the old row + to-times)
-- INSERT INTO stage_bookings (
--   id, reservation_id, service_id, starts_at, ends_at,
--   email, first_name, last_name, status, booked_at, source, user_agent
-- )
-- SELECT l.new_id, s.reservation_id, s.service_id, l.new_starts_at,
--   l.new_starts_at + (s.ends_at - s.starts_at),
--   s.email, s.first_name, s.last_name, 'confirmed', l.rescheduled_at, s.source, s.user_agent
-- FROM reschedule_pairs l
-- JOIN stage_bookings s ON s.id = l.old_id
-- WHERE l.new_id IS NOT NULL AND l.new_starts_at IS NOT NULL;

-- -- ----------------------------------------------------------------------------
-- -- 10. Status lifecycle replay: latest event wins (updates, cancels, reschedules)
-- -- ----------------------------------------------------------------------------
-- WITH ranked AS (
--   SELECT DISTINCT ON (id) id, status, cancelled_at, cancelled_by
--   FROM (
--     SELECT entity_id AS id, id AS log_id, created_at,
--            metadata->'diff'->'status'->>'to' AS status,
--            NULL::timestamptz AS cancelled_at, NULL::bigint AS cancelled_by
--     FROM activity_logs WHERE action = 'booking.update'
--       AND NULLIF(metadata->'diff'->'status'->>'to','null') IS NOT NULL
--       AND (metadata->'diff'->'status'->>'to') <> ''
--     UNION ALL
--     SELECT entity_id, id, created_at, 'cancelled',
--            CASE WHEN trim(both '"' FROM COALESCE(metadata->'diff'->'cancelled_at'->>'to','')) ~ '^\d{4}-\d{2}-\d{2}T'
--                 THEN (trim(both '"' FROM (metadata->'diff'->'cancelled_at'->>'to')))::timestamptz
--                 ELSE created_at END,
--            CASE WHEN (metadata->'diff'->>'cancelled_by_user_id') ~ '^\d+$'
--                 THEN (metadata->'diff'->'cancelled_by_user_id')::bigint END
--     FROM activity_logs WHERE action IN ('booking.cancel','booking.cancel_public')
--     UNION ALL
--     SELECT entity_id, id, created_at, 'cancelled', created_at, NULL::bigint
--     FROM activity_logs WHERE action = 'booking.reschedule_public'
--   ) events
--   ORDER BY id, created_at DESC, log_id DESC
-- )
-- UPDATE stage_bookings s SET status = r.status,
--   cancelled_at = r.cancelled_at,
--   cancelled_by = r.cancelled_by
-- FROM ranked r WHERE r.id = s.id;

-- -- 10b. Deleted bookings stay deleted (logged deletes = intentional).
-- DELETE FROM stage_bookings s
-- WHERE EXISTS (SELECT 1 FROM activity_logs d WHERE d.action = 'booking.delete' AND d.entity_id = s.id);

-- -- 10c. Bookings known only from non-create rows (no times/service to copy)
-- DO $$ DECLARE r RECORD; BEGIN
--   FOR r IN
--     WITH known AS (SELECT id FROM stage_bookings)
--     SELECT DISTINCT a.entity_id AS id, string_agg(DISTINCT a.action, ', ') AS actions
--     FROM activity_logs a
--     WHERE a.action LIKE 'booking.%'
--       AND a.action NOT IN ('booking.create_public','booking.create_manual','booking.public_error')
--       AND a.entity_id IS NOT NULL
--       AND NOT EXISTS (SELECT 1 FROM known k WHERE k.id = a.entity_id)
--     GROUP BY 1 ORDER BY 1
--   LOOP
--     RAISE NOTICE 'booking % has no create row (actions: %) — skipped, needs manual review', r.id, r.actions;
--   END LOOP;
-- END $$;

-- -- ----------------------------------------------------------------------------
-- -- 11. Drop unrestorable rows LOUDLY (reported, never guessed)
-- -- ----------------------------------------------------------------------------
-- DO $$ DECLARE r RECORD; BEGIN
--   FOR r IN SELECT id FROM stage_bookings WHERE reservation_id IS NULL LOOP
--     RAISE NOTICE 'booking % skipped: no reservation mapping', r.id;
--   END LOOP;
--   DELETE FROM stage_bookings WHERE reservation_id IS NULL;

--   FOR r IN SELECT id FROM stage_bookings WHERE service_id IS NULL LOOP
--     RAISE NOTICE 'booking % skipped: no service mapping', r.id;
--   END LOOP;
--   DELETE FROM stage_bookings WHERE service_id IS NULL;

--   FOR r IN SELECT id, service_id FROM stage_bookings s
--            WHERE NOT EXISTS (SELECT 1 FROM reservation_services v WHERE v.id = s.service_id) LOOP
--     RAISE NOTICE 'booking % skipped: service % no longer exists', r.id, r.service_id;
--   END LOOP;
--   DELETE FROM stage_bookings s
--   WHERE NOT EXISTS (SELECT 1 FROM reservation_services v WHERE v.id = s.service_id);

--   FOR r IN SELECT id FROM stage_bookings WHERE starts_at IS NULL OR ends_at IS NULL LOOP
--     RAISE NOTICE 'booking % skipped: incomplete time slot', r.id;
--   END LOOP;
--   DELETE FROM stage_bookings WHERE starts_at IS NULL OR ends_at IS NULL;

--   FOR r IN SELECT id, email FROM stage_bookings WHERE email IS NULL LOOP
--     RAISE NOTICE 'booking % restored WITHOUT email (guest unreachable, kept for history)', r.id;
--   END LOOP;
-- END $$;

-- DO $$ DECLARE
--   n_stage int; n_orphan_res int;
-- BEGIN
--   SELECT count(*) INTO n_stage FROM stage_bookings;
--   IF n_stage = 0 THEN RAISE EXCEPTION 'nothing staged — refusing to run on empty logs'; END IF;
--   SELECT count(*) INTO n_orphan_res FROM stage_bookings s
--    WHERE NOT EXISTS (SELECT 1 FROM reservations r WHERE r.id = s.reservation_id);
--   IF n_orphan_res > 0 THEN RAISE EXCEPTION 'staged bookings reference unrestored reservations (%)', n_orphan_res;
--   END IF;
--   RAISE NOTICE 'verified: % bookings staged, 0 orphans', n_stage;
-- END $$;

-- -- ----------------------------------------------------------------------------
-- -- 12. PHASE 2 WRITE: bookings with original ids (names from translations)
-- -- ----------------------------------------------------------------------------
-- INSERT INTO reservation_bookings (
--   id, reservation_id, service_id, starts_at, ends_at,
--   first_name, last_name, email, phone, comment,
--   customer_id, created_by_user_id, worker_id,
--   service_name_snapshot, duration_minutes_snapshot, price_amount_snapshot,
--   currency_snapshot, timezone, status, source, locale, data,
--   booking_token, booked_at, cancelled_at, cancelled_by_user_id,
--   rating_sent_at, reminder_sent_at
-- )
-- SELECT
--   s.id, s.reservation_id, s.service_id, s.starts_at, s.ends_at,
--   s.first_name, s.last_name, s.email, c.phone, NULL,
--   c.id, s.created_by, w.id,
--   COALESCE(t.name, 'Visszaállított szolgáltatás'), v.duration_minutes, v.price_amount,
--   v.currency, r.timezone, s.status, s.source, 'hu', NULL,
--   gen_random_uuid()::text, s.booked_at, s.cancelled_at, s.cancelled_by,
--   CASE WHEN s.status = 'attended' THEN now() ELSE NULL END,
--   NULL
-- FROM stage_bookings s
-- JOIN reservations r ON r.id = s.reservation_id
-- JOIN reservation_services v ON v.id = s.service_id
-- LEFT JOIN LATERAL (
--   SELECT name FROM reservation_service_translations
--   WHERE service_id = s.service_id ORDER BY (locale = r.default_locale) DESC LIMIT 1
-- ) t ON true
-- LEFT JOIN reservation_customers c
--   ON c.project_id = r.project_id AND lower(c.email) = lower(s.email)
--   AND (SELECT count(*) FROM reservation_customers c2
--        WHERE c2.project_id = r.project_id AND lower(c2.email) = lower(s.email)) = 1
-- LEFT JOIN LATERAL (
--   SELECT id FROM users WHERE lower(email) = lower((
--     SELECT d.metadata->'diff'->'worker_email'->>'to' FROM activity_logs d
--     WHERE d.action IN ('booking.update','booking.cancel','booking.cancel_public')
--       AND d.entity_id = s.id
--       AND NULLIF(d.metadata->'diff'->'worker_email'->>'to','null') IS NOT NULL
--     ORDER BY d.id DESC LIMIT 1))
-- ) w ON true;

-- -- created_by: prefer the admin who created it (manual creates)
-- UPDATE reservation_bookings b SET created_by_user_id = m.uid
-- FROM (SELECT DISTINCT ON (entity_id) entity_id, actor_user_id AS uid FROM activity_logs
--       WHERE action = 'booking.create_manual' AND actor_user_id IS NOT NULL
--       ORDER BY entity_id, id) m
-- WHERE b.id = m.entity_id AND EXISTS (SELECT 1 FROM users u WHERE u.id = m.uid);

-- -- sequences continue after restored ids
-- SELECT setval(pg_get_serial_sequence('reservation_bookings','id'), (SELECT max(id) FROM reservation_bookings));

-- -- ----------------------------------------------------------------------------
-- -- 13. PHASE 2 REPORT (read before COMMIT decision)
-- -- ----------------------------------------------------------------------------
-- SELECT 'phase2_bookings' AS metric, count(*)::text AS value FROM reservation_bookings
-- UNION ALL SELECT 'phase2_attended_stamped_no_resend', count(*) FROM reservation_bookings WHERE rating_sent_at IS NOT NULL
-- UNION ALL SELECT 'phase2_due_for_worker_now', count(*) FROM reservation_bookings b
--   WHERE b.rating_sent_at IS NULL AND b.status = 'attended' AND b.ends_at < now() AND b.email IS NOT NULL AND trim(b.email) != ''
--     AND NOT EXISTS (SELECT 1 FROM reservation_ratings rr WHERE rr.booking_id = b.id)
--     AND NOT EXISTS (SELECT 1 FROM reservation_ratings rr WHERE rr.reservation_id = b.reservation_id AND lower(rr.email) = lower(b.email));

-- COMMIT;
*/
