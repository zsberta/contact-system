# Contact System

A simple, single-user admin dashboard. Login-only, no public registration, no SSO. Built on the same React/Vite/shadcn stack as InventoBee, but with Express + PostgreSQL as the backend (no Java proxy).

## Stack

- **Frontend**: React 18 + TypeScript + Vite + shadcn/ui (Radix + Tailwind) + react-router + react-query + react-hook-form + zod + i18next
- **Backend**: Node.js + Express 4 + PostgreSQL (`pg`) + JWT (`jsonwebtoken`) + bcrypt
- **Tooling**: ESLint, multi-stage Docker, docker-compose, node-pg-migrate

## Quickstart (Docker)

```bash
cp .env.example .env
# Generate a real JWT secret:
echo "JWT_SECRET=$(openssl rand -hex 64)" >> .env.tmp
sed -i '' "s|JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 64)|" .env 2>/dev/null \
  || sed -i "s|JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 64)|" .env
# Set admin credentials in .env
docker compose -f docker-compose.local.yml up --build
```

The app will be at <http://localhost>. Postgres at `localhost:5432` (user `contact`, password `contact_pw`, database `contact_system`).

## Quickstart (without Docker)

You need a running PostgreSQL. Update `DATABASE_URL` in `.env` accordingly.

```bash
cp .env.example .env
# Set JWT_SECRET (must be ≥ 32 bytes), ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run db:migrate
npm run db:seed
npm run build
npm start                   # production: serves SPA + API on :3000
# OR for dev:
npm run dev                 # Vite dev server on :8080 (proxies /api → :3000)
npm run dev:server          # Express with --watch on :3000
```

## Environment variables

See `.env.example` for the full list. The important ones:

- `JWT_SECRET` — ≥ 32 bytes of randomness (`openssl rand -hex 64`). Required.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — used by `db:seed` to create the first user. Required.
- `DATABASE_URL` — `postgres://user:pass@host:port/db`. Required.
- `COOKIE_SECURE` — `true` in prod (HTTPS), `false` in dev (HTTP).
- `BCRYPT_COST` — default 12. Don't go below 10.

## Project structure

```
contact-system/
├── src/                      # React frontend
│   ├── components/
│   ├── pages/
│   ├── context/AuthContext
│   ├── services/csrf/
│   ├── lib/api.ts            # the single HTTP entry point
│   ├── i18n.ts               # i18next setup
│   └── i18n/{en,hu}/         # translation JSON
├── server.js                 # Express app (entry point)
├── routes/                   # /api/auth, /api/csrf, /api/dashboard
├── middleware/               # jwtAuth, csrf
├── db/
│   ├── pool.js               # pg Pool singleton
│   ├── seed.js               # idempotent admin seeder
│   └── migrations/0001_init.sql
├── Dockerfile                # multi-stage (FE build → slim runner)
├── docker-compose.local.yml  # postgres + app
└── .env.example
```

## Architecture

The Express server does **everything**: serves the SPA (`dist/`), issues HttpOnly cookies (`sessionId`, `token`, `refreshToken`), signs JWTs, verifies them, serves the CSRF token endpoint, enforces double-submit CSRF on state-changing calls, and talks to PostgreSQL directly via `pg`.

Refresh tokens are stored hashed (`sha256(jti)`) in the `refresh_tokens` table so they can be revoked. Sessions themselves are stateless — the JWT carries everything.

The frontend has the same `apiFetch` / `CsrfTokenService` / `ProtectedRoute` / `AuthContext` stack as InventoBee, with the only API URL change being `/java-api → /api`.

## Scope cuts (v1)

Deliberately NOT in v1:

- **Registration** — only login. Add users via `db:seed` or SQL.
- **Password change** — out of scope.
- **SSO** — user explicitly excluded.
- **Roles / permissions** — `usePermission` is stubbed to return `true` for every check. The 3-tier permission enforcement from InventoBee is not active. Adding `requiredPermissions` to a `<ProtectedRoute>` will be accepted by the API but ignored.
- **Entity CRUD pages** — only the `/dashboard` placeholder exists.
- **Multi-language i18n** — Hungarian (`hu`) translations are placeholders (copies of English). Translate `src/i18n/hu/*.json` to localize.
- **HTTPS termination** — local compose is HTTP-only. Add a reverse proxy or `FRONTEND_HTTPS=true` for prod.

## Troubleshooting

- **Login loops back to `/login`** — check `COOKIE_SECURE` in `.env`. In dev it must be `false` (HTTP).
- **`401 Unauthorized` on every call** — JWT secret mismatch. Both the FE and BE need the same `JWT_SECRET`.
- **`403 Invalid CSRF token` on POST** — the FE calls `GET /api/csrf` first (handled by `CsrfTokenService.initialize()` after `login()`). If you bypass `apiFetch` and use raw `fetch`, you must include the `X-XSRF-TOKEN` header.
- **`Cannot find module 'pg'`** — you need to run `npm install` after editing `package.json`.

## Future work

- Implement entity CRUD (contacts) — the dashboard placeholder is wired to `GET /api/dashboard/summary`.
- Add `POST /api/auth/change-password` for password rotation.
- Implement the 3-tier permission system (sidebar/route/button).
- Add `helmet` + proper CSP when serving over HTTPS.
