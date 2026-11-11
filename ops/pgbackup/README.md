# pgbackup — rotating full-PostgreSQL-dump service

Runs inside `docker compose` as the `pgbackup` service (same
`pgvector/pgvector:pg16` image as `db`, so `pg_dump` always matches
the server). `docker compose up -d --build` starts it together with
everything else. No ports, no host exposure.

## What it does

Every **10 minutes** (`BACKUP_INTERVAL_SECS`, default `600`) it writes
one **full-database dump** (`pg_dump -Fc`, custom format — the whole
`contact_system` DB, every table) to `./backups/` on the host
(bind mount `/backups` in the container):

```text
backups/full_2026-11-11_1910.dump   # UTC, mode 0600 (contains DB secrets)
```

After every dump it runs [`prune.sh`](prune.sh), which enforces the
tiered retention (ages from the UTC filename, not mtime, so copies
don't reset retention):

| Dump age       | Kept                                              |
| -------------- | ------------------------------------------------- |
| `< 24 hours`   | **every** 10-minute dump (~144 files)             |
| `1 – 30 days`  | **2 per day**: closest to 00:00 and 12:00 UTC     |
| `> 30 days`    | **deleted**                                       |

After the age tiers, a **total-size cap** applies
(`BACKUP_MAX_SIZE_MB`, default `2048`): while the managed dumps exceed
it, the oldest dump is deleted first until they fit. The cap counts
only `full_*.dump` files. Note a cap smaller than ~a day of dumps will
eat into the `< 24h` window; `0` disables the cap.

Steady-state disk use is ~150 MB (dumps are ~0.8 MB each: ~110 MB for
the fresh day + ~45 MB for the 29 thinned days), so the default 2 GB
cap only ever triggers if dumps grow unexpectedly.

Files that don't match `full_*.dump` are never touched.

## Configuration

Set in the compose file (override via `.env`, see `.env.example`):

| Var                   | Default | Meaning                              |
| --------------------- | ------- | ------------------------------------ |
| `BACKUP_INTERVAL_SECS`| `600`   | seconds between dumps                |
| `BACKUP_KEEP_DAYS`    | `30`    | days before a dump is deleted        |
| `BACKUP_MAX_SIZE_MB`  | `2048`  | total size cap (oldest evicted first, `0` = off) |

`PGHOST/PGPORT/POSTGRES_DB/POSTGRES_USER/POSTGRES_PASSWORD` come from
the same `.env` as the `db` service.

## Operations

```bash
# follow the loop (dump + prune log lines)
docker logs -f contact-system-pgbackup

# run the prune manually (e.g. after changing BACKUP_KEEP_DAYS)
docker exec contact-system-pgbackup bash /opt/pgbackup/prune.sh

# list dumps
ls -lh backups/

# restore a dump (runs as root so it can read the 0600 files;
# prefer restoring into a scratch DB first to verify)
docker exec -u 0 contact-system-db pg_restore \
  -h localhost -U contact -d contact_system \
  --clean --if-exists /backups/full_YYYY-MM-DD_HHMM.dump
# (needs PGPASSWORD: prefix with `docker exec -u 0 -e PGPASSWORD=<pw> ...`)
```

`/backups` is also mounted read-only into the `db` container, so the
restore above needs no `docker cp`.

## Notes

- On Linux hosts the dumps are written by the container's root user,
  so they appear as root-owned, mode `0600`. Read/restore via
  `sudo` or `docker exec` as above.
- `backups/` is gitignored (only `.gitkeep` is committed) and excluded
  from the Docker build context.
- `prune.sh` needs bash 4+ (`mapfile`). The container has it; on macOS
  run prune via `docker exec` (default `/bin/bash` is 3.2) or a newer
  bash from Homebrew.
