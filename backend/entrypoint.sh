#!/bin/sh
# Entrypoint: fix volume ownership -> migrate -> seed admin -> serve.
# All steps are idempotent, so `docker compose up` is safe to re-run
# against existing volumes (no data loss, no duplicates).
#
# Runs as root on purpose: the named `uploads` volume keeps whatever
# ownership it was created with (e.g. the previous Node image's user),
# and only root can chown it back. The server itself NEVER runs as root
# — we drop to appuser via gosu before starting it. Mirrors the old
# image's `chown -R nodeapp ... && su-exec nodeapp` startup.
set -e

export LOCO_ENV="${LOCO_ENV:-${NODE_ENV:-development}}"

echo "[entrypoint] LOCO_ENV=$LOCO_ENV (uid=$(id -u))"

# Named volumes are NOT re-chowned by Docker on reuse: without this,
# uploads written by the previous image are unreadable AND new uploads
# fail with EACCES (mkdir permission denied). Best-effort on dev bind
# mounts (host-owned files) — failures there are non-fatal.
if [ -d /app/uploads ]; then
  if chown -R appuser:appuser /app/uploads 2>/dev/null; then
    echo "[entrypoint] uploads ownership fixed"
  else
    echo "[entrypoint] WARNING: could not chown /app/uploads (continuing anyway)"
  fi
fi

echo "[entrypoint] running migrations..."
gosu appuser:appuser /app/contact-system-cli db migrate --environment "$LOCO_ENV"

echo "[entrypoint] ensuring admin user..."
ADMIN_EMAIL="${ADMIN_EMAIL:-}" ADMIN_PASSWORD="${ADMIN_PASSWORD:-}" \
  gosu appuser:appuser /app/contact-system-cli task seed_admin --environment "$LOCO_ENV" || true

echo "[entrypoint] starting server as appuser..."
exec gosu appuser:appuser /app/contact-system-cli start --environment "$LOCO_ENV" --binding 0.0.0.0 --port 3000
