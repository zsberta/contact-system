# Zsolt's CRM

A simple, single-user admin dashboard. Login-only, no public registration, no SSO. React/Vite/shadcn frontend with a **Rust (Loco) + PostgreSQL** backend.

> Backend is Rust/Loco (ported from Express with zero data/feature loss). Same API contract (`/api/*`), same Postgres schema, same React SPA.

## Stack

- **Frontend**: React 18 + TypeScript + Vite + shadcn/ui (Radix + Tailwind) + react-router + react-query + react-hook-form + zod + i18next
- **Backend**: Rust + Loco (`backend/`, Axum + SeaORM) + PostgreSQL + JWT + bcrypt
- **Tooling**: ESLint, Cargo, multi-stage Docker, docker-compose (migrations embedded in the binary)

## Quickstart (Docker)

```bash
cp .env.example .env
# Generate a real JWT secret:
echo "JWT_SECRET=$(openssl rand -hex 64)" >> .env.tmp
sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 64)|" .env 2>/dev/null \
  || sed -i "s|JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 64)|" .env
# Set admin credentials in .env
docker compose up -d --build
```

The app will be at <http://localhost>. Migrations run automatically on boot (embedded SQL, idempotent — safe against the existing database volume), then the admin user is ensured from `ADMIN_EMAIL`/`ADMIN_PASSWORD`, then the server starts. Postgres at `localhost:5432` (user `contact`, database `contact_system`, password from `POSTGRES_PASSWORD`).

## Quickstart (without Docker)

You need a running PostgreSQL. Update `DATABASE_URL` in `.env` accordingly.

```bash
cp .env.example .env
# Set JWT_SECRET (must be ≥ 32 bytes), ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run build             # frontend SPA into dist/
# Backend (needs Rust toolchain + running Postgres, DATABASE_URL in env):
cargo run -p contact-system --bin contact-system-cli -- db migrate
cargo run -p contact-system --bin contact-system-cli -- task seed_admin
cargo run -p contact-system --bin contact-system-cli -- start
# OR for frontend dev:
npm run dev               # Vite dev server on :8080 (proxies /api → :3000)
```

## Environment variables

See `.env.example` for the full list. The important ones:

- `JWT_SECRET` — ≥ 32 bytes of randomness (`openssl rand -hex 64`). Required.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — used by `task seed_admin` to create the first user. Required.
- `DATABASE_URL` — `postgres://user:pass@host:port/db`. Required.
- `COOKIE_SECURE` — `true` in prod (HTTPS), `false` in dev (HTTP).
- `BCRYPT_COST` — default 12. Don't go below 10.
- `APP_PUBLIC_URL` — public base URL of the app (e.g. `https://crm.example.com`). Used to build links inside outgoing emails (booking manage links, **rating links**). If unset/empty, emails go out without those links.
- `EMAIL_SENDING` — `false` disables ALL outgoing email. Default (unset) sends.
- `DISABLE_REMINDERS` / `DISABLE_RATINGS` — set to `true` to pause the booking-reminder worker / the rating-request worker. `false` (or unset) = running.
- `REMINDER_POLL_INTERVAL_SECS` / `RATING_POLL_INTERVAL_SECS` — how often each worker polls for due bookings, in seconds. Default `60`, minimum `10`.

## Reservation ratings

Guests can rate a past visit 1–5 stars with an optional comment:

- An operator sets a booking to **"Részt vett" (attended)**. The ratings worker (every `RATING_POLL_INTERVAL_SECS`, default 60s) emails the guest a rating link — same look as the booking emails. One email per attended booking; once a guest rated with an email address, no further rating emails go to that address.
- The link opens a public page (`/embed/reservations/:secret/rate/:bookingToken`, no login). The guest's name is shown from the booking — nothing to fill in except stars + comment. Each booking can be rated once; reopening a rated link shows the thank-you state, never the form again.
- **Frequency** (project field *"Értékelő e-mail gyakoriság / Rating email frequency"*): send every Nth attended visit instead of every one. `1` = every visit (default), `5` = the 1st, 5th, 10th, 15th visit. The first visit always emails; skipped visits are never reconsidered. Once a guest rates, no further rating emails go to that address regardless of N.
- **Manual send**: the booking view page has a *"Értékelő e-mail küldése / Send rating email"* button (enabled for attended bookings whose visit is over). It runs the same checks and the same email, and stamps the booking so the automatic logic ignores it afterwards — it only skips the frequency throttle. Rejected with a clear error if the visit hasn't ended, the booking isn't attended, has no email, or the guest already rated.
- **Deploy safety**: historical attended bookings never get emailed — a backfill migration stamps them as processed at deploy time, and editing a booking's status afterwards doesn't re-arm them. Only visits marked attended after the deploy generate emails.
- After submitting **1–2 stars** the guest sees an apologetic message (no Google redirect). After **3–5 stars** they see a thank-you message plus a **"Rate us on Google"** button — the URL comes from the project's **Google review link** field (project edit form). All ratings are listed under the reservation module's **Értékelések / Ratings** sidebar page (average, count, per-star distribution, delete).
- Kill-switch: `DISABLE_RATINGS=true` pauses the worker; already-sent links keep working.

## Migrations (backend)

SQL files live in `backend/migration/sql/*.sql`, executed in lexicographic order. Each file has its own tracked migration (applied = recorded in `seaql_migrations`), so plain `docker compose up -d --build` applies pending files automatically on every environment — no manual steps, no data loss.

Rules for adding a migration (all must hold, or deploys break):

1. **Up-section must be re-runnable.** Guard everything: `IF NOT EXISTS` / `IF EXISTS`, `DO $$ ... EXCEPTION WHEN duplicate_*`, `ON CONFLICT DO NOTHING`, or convergent `WHERE`-guarded backfills. Assume your file will execute many times, not once.
2. **Only the up-section runs.** The runner executes everything before the `-- Down Migration` marker (files without a marker run in full). Keep the marker on its own line, exactly once per file.
3. **`down()` is a no-op by design.** Rollbacks are done via explicit SQL, never `migrate:down` (which would just re-queue the up-section).
4. **Register the file** in `backend/migration/src/lib.rs`: one `sql_migration!(...)` line plus one `Box::new(...)` line, in lexicographic order.
5. **Never delete or rename an applied migration struct** — not even the `LegacySquashedLib` tombstone at the top of the list. The framework aborts boot (`Migration file of version 'X' is missing`) if the database contains an applied migration with no matching code.
6. **Never `DROP TABLE` (or any data-destroying statement) in the up-section** — not even in a "recovery block". A re-run on a populated database (migrator transition, restored backup, re-applied volume) executes it against live data: on 2026-11-10 exactly this wiped production reservations/bookings and emptied every module table. Create with `IF NOT EXISTS`; clean up partial runs with convergent guards only, never drops.

## Project structure

```
contact-system/
├── src/                      # React frontend
│   ├── components/           # incl. per-module UI (reservations, blog, faq, ...)
│   ├── pages/                # incl. public embed pages (booking, rating)
│   ├── context/              # AuthContext, ProjectContext
│   ├── hooks/                # usePermission, useDataTableQuery, ...
│   ├── lib/                  # apiFetch entry point, per-module API clients
│   ├── types/                # DTOs mirroring the backend
│   ├── i18n.ts               # i18next setup (namespaces: hu + en)
│   └── i18n/{en,hu}/         # translation JSON per namespace
├── backend/
│   ├── src/
│   │   ├── controllers/      # /api/* handlers (auth, projects, reservations, ...)
│   │   ├── mailers/          # SMTP queue + branded email templates
│   │   ├── workers/          # background loops (reminders, ratings, gateway, ...)
│   │   ├── middleware/       # auth, CSRF, CORS, rate limit
│   │   ├── models/ tasks/    # seed_admin lives in tasks/
│   │   └── app.rs            # boot: workers, routes, middleware layers
│   ├── migration/sql/        # *.sql files (lexicographic order = execution order)
│   ├── migration/src/lib.rs  # one tracked migration per SQL file (see Migrations)
│   ├── config/               # loco environment configs
│   └── entrypoint.sh         # migrate → seed admin → start (used by Docker)
├── e2e/full.spec.ts          # Playwright end-to-end suite
├── scripts/check-i18n-keys.mjs  # fails the build on missing/mismatched i18n keys
├── Dockerfile                # multi-stage (FE build + Rust release → slim runner)
├── docker-compose.yml        # app + postgres (dev default)
├── docker-compose.local.yml / docker-compose.prod.yml  # env variants
└── .env.example
```

## Architecture

The Rust backend does **everything**: serves the SPA (`dist/`), issues HttpOnly cookies, signs JWTs (access + refresh), verifies them, serves the CSRF token endpoint, enforces double-submit CSRF on state-changing calls, and talks to PostgreSQL via SeaORM.

Refresh tokens are stored hashed (`sha256(jti)`) in the `refresh_tokens` table so they can be revoked. Sessions themselves are stateless — the JWT carries everything.

Roles are coarse: `admin` (full access) vs `enduser` (customer portal — read-only access to explicitly assigned projects only). Route-level enforcement lives in `ProtectedRoute` + backend project scoping; fine-grained per-button permissions (`usePermission`) are still stubbed.

The frontend talks to the backend only through `apiFetch` (`src/lib/api.ts`), with per-module clients in `src/lib/`. Public embed widgets (booking, rating, forms) use token-capability URLs and never require login. All user-facing text is translated (HU + EN, wired through `src/i18n.ts`, enforced by `npm run check:i18n`).

## Backups

The `pgbackup` compose service dumps the whole PostgreSQL DB
(`pg_dump -Fc`) into `./backups/` every 10 minutes: every dump is kept
for 24h, then thinned to 2/day (00:00 + 12:00 UTC) for 30 days, then
deleted. A 2 GB total-size cap (oldest evicted first) guards disk use.
Starts with `docker compose up -d --build`. Details + restore
in [`ops/pgbackup/README.md`](ops/pgbackup/README.md).

## Scope cuts (v1)

Deliberately NOT in v1:

- **Public registration** — login only. Admins create users (endusers get an invite link and pick their own password).
- **SSO** — explicitly excluded.
- **Fine-grained permissions** — only the admin/enduser split exists; `usePermission` returns `true` for every check.
- **HTTPS termination** — local compose is HTTP-only. Add a reverse proxy for prod.

## Troubleshooting

- **Login loops back to `/login`** — check `COOKIE_SECURE` in `.env`. In dev it must be `false` (HTTP).
- **`401 Unauthorized` on every call** — JWT secret mismatch. Both the FE and BE need the same `JWT_SECRET`.
- **`403 Invalid CSRF token` on POST** — the FE calls `GET /api/csrf` first (handled by `CsrfTokenService.initialize()` after `login()`). If you bypass `apiFetch` and use raw `fetch`, you must include the `X-XSRF-TOKEN` header.
- **`Cannot find module 'pg'`** — you need to run `npm install` after editing `package.json`.
- **`Migration file of version 'X' is missing` boot loop** — an applied migration's code was deleted or renamed. Restore the file/struct (see Migrations above); never delete applied migrations.
- **`column ... does not exist` 500s after adding a migration** — the file wasn't applied: check boot logs for `Applying migration '<name>'`. If the migrator reports `No pending migrations` for a file that is clearly new, the migration isn't registered in `backend/migration/src/lib.rs`.

## Future work

- Implement the fine-grained permission system (sidebar/route/button) behind `usePermission`.
- Add `helmet`-style hardening + proper CSP when serving over HTTPS.
