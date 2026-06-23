# Migrations

This project uses [`node-pg-migrate`](https://github.com/salsita/node-pg-migrate) with raw SQL files (no DSL).

## How it works

- Migration files live in `db/migrations/` with the format `NNNN_name.sql`
- The `NNNN_` prefix is a zero-padded sequence number (0001, 0002, …). The current `0001_init.sql` is the only one.
- A `pgmigrations` table in the same Postgres database tracks which migrations have been applied
- `npm run db:migrate` is **idempotent**: if all migrations are already applied, it's a no-op
- Each `.sql` file has TWO sections separated by `-- Down Migration`: the up (apply) and down (rollback) statements
- The Docker `command:` runs `db:migrate && db:seed && node server.js` on every container start, so migrations are auto-applied
- For the first run, the `pgmigrations` table doesn't exist — node-pg-migrate creates it

## Available commands

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply all pending migrations (no-op if all applied) |
| `npm run db:migrate:down` | Roll back the most recent migration |
| `npm run db:status` | List all migrations and which are applied (alias for `node-pg-migrate list`) |
| `npm run db:seed` | Create the admin user from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (idempotent) |
| `npm run db:reset` | **DESTRUCTIVE**: roll back ALL migrations, re-apply, re-seed |
| `npm run db:create -- <name>` | Create a new migration file with the next sequence number |
| `node-pg-migrate up --to 0002_xxx` | Apply migrations UP TO a specific file (inclusive) |
| `node-pg-migrate down --count 3` | Roll back the most recent 3 migrations |
| `node-pg-migrate redo` | Roll back the most recent, then re-apply (for editing the last migration) |

## Workflow for a new migration

1. **Create the file** with a descriptive name (kebab-case):
   ```bash
   npm run db:create -- add-user-last-login
   # → creates db/migrations/0002_add-user-last-login.sql
   ```
2. **Edit the file**: write the `-- Up Migration` section (DDL/DML you want) and the `-- Down Migration` section (the inverse).
3. **Test locally**:
   ```bash
   npm run db:migrate
   ```
4. **Verify**:
   ```bash
   psql $DATABASE_URL -c "SELECT * FROM pgmigrations;"
   npm run db:status
   ```
5. **Roll back if needed**:
   ```bash
   npm run db:migrate:down
   ```
6. **Commit the `.sql` file** to the repo.

## Production deployment

In production, migrations are auto-applied on container start (via the `app` service's `command:` override in `docker-compose.local.yml`). For zero-downtime deploys with a real production load, you have two options:

1. **Maintain backward-compatibility** in every migration: each migration must be safe to run while the previous version of the app is still serving traffic. Examples: add nullable columns (don't make them NOT NULL yet), create new tables, don't drop columns in the same migration that removes their usage.
2. **Run migrations as a separate one-shot step** before swapping traffic: e.g., `docker compose run --rm app npm run db:migrate`, then `docker compose up -d app`. The `app` service's `command:` override does this automatically.

## Why raw SQL instead of an ORM/DSL

- We use raw SQL because the schema is small (~2 tables) and full visibility of the SQL is valuable
- Migrations are 1:1 with what a DBA would write
- `node-pg-migrate` is just a runner + tracker; it doesn't constrain your SQL
- `citext`, partial indexes, custom constraints, etc. all just work
- Easy to debug: `psql $DATABASE_URL -c "SELECT * FROM pgmigrations;"` shows exactly what's applied
