#!/usr/bin/env bash
#
# backup-loop.sh — pgbackup service entrypoint.
#
# Every $BACKUP_INTERVAL_SECS (default 600 = 10 minutes) takes a FULL
# PostgreSQL dump (`pg_dump -Fc`, custom format, whole database) into
# $BACKUP_DIR (default /backups, bind-mounted to ./backups on the host),
# then runs prune.sh to enforce the tiered retention policy:
#
#   age <= 24h        keep every 10-minute dump
#   24h < age <= 30d  keep 2/day (closest to 00:00 and 12:00 UTC)
#   age > 30d         delete
#
# Filenames are UTC: full_YYYY-MM-DD_HHMM.dump, mode 0600 (dumps
# contain the whole DB including secrets).
#
# Env (all optional except POSTGRES_PASSWORD):
#   PGHOST / PGPORT / POSTGRES_DB / POSTGRES_USER (defaults: db,
#     5432, contact_system, contact)
#   POSTGRES_PASSWORD (required)
#   BACKUP_DIR (default /backups)
#   BACKUP_INTERVAL_SECS (default 600)
#   BACKUP_KEEP_DAYS (default 30, forwarded to prune.sh)

set -euo pipefail

PGHOST="${PGHOST:-db}"
PGPORT="${PGPORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-contact_system}"
POSTGRES_USER="${POSTGRES_USER:-contact}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env (pgbackup service)}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECS:-600}"
export BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p "$BACKUP_DIR"

echo "[pgbackup] waiting for postgres at $PGHOST:$PGPORT ..."
until pg_isready -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q; do
  sleep 5
done
echo "[pgbackup] postgres is up, starting 10-minute dump loop (dir=$BACKUP_DIR)"

shutdown() {
  echo "[pgbackup] stopping..."
  exit 0
}
trap shutdown TERM INT

while true; do
  # Stale temp file from a killed run (ours is the only writer, so a
  # leftover at iteration start is always dead). The dot prefix keeps
  # it invisible to prune.sh's full_*.dump glob.
  rm -f "$BACKUP_DIR"/.tmp_*.dump

  TS="$(date -u +%F_%H%M)"
  DEST="$BACKUP_DIR/full_${TS}.dump"
  if [[ -e "$DEST" ]]; then
    # Same-minute restart collision: add seconds (prune.sh understands it).
    DEST="$BACKUP_DIR/full_${TS}$(date -u +%S).dump"
  fi
  TMP="$DEST.tmp.$$"

  export PGPASSWORD="$POSTGRES_PASSWORD"
  if pg_dump -h "$PGHOST" -p "$PGPORT" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Fc -f "$TMP"; then
    chmod 600 "$TMP"
    mv -f "$TMP" "$DEST"
    echo "[pgbackup] wrote $DEST"
    bash "$SCRIPT_DIR/prune.sh" "$BACKUP_DIR" || echo "[pgbackup] prune failed (non-fatal)" >&2
  else
    echo "[pgbackup] pg_dump FAILED, keeping previous backups" >&2
    rm -f "$TMP"
  fi

  # `sleep & wait` (instead of plain `sleep`) so SIGTERM stops the
  # container promptly even mid-interval.
  sleep "$INTERVAL" & wait $!
done
