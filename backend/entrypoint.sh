#!/bin/sh
# Entrypoint: migrate -> seed admin -> serve.
# All steps are idempotent, so `docker compose up` is safe to re-run
# against an existing database volume (no data loss, no duplicates).
set -e

export LOCO_ENV="${LOCO_ENV:-${NODE_ENV:-development}}"

echo "[entrypoint] LOCO_ENV=$LOCO_ENV"

echo "[entrypoint] running migrations..."
/app/contact-system-cli db migrate --environment "$LOCO_ENV"

echo "[entrypoint] ensuring admin user..."
ADMIN_EMAIL="${ADMIN_EMAIL:-}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  /app/contact-system-cli task seed_admin --environment "$LOCO_ENV" || true

echo "[entrypoint] starting server..."
exec /app/contact-system-cli start --environment "$LOCO_ENV" --binding 0.0.0.0 --port 3000
