#!/usr/bin/env bash
#
# prune.sh — tiered retention + total-size cap for full PostgreSQL dumps.
#
# Retention policy (ages relative to now; dump timestamps are UTC):
#
#   age <= 24 hours          keep EVERY dump (10-minute resolution,
#                            ~144 files for a full day)
#   24h < age <= 30 days     keep 2 dumps per calendar day: the ones
#                            closest to 00:00 and 12:00 UTC; delete rest
#   age > 30 days            delete
#
# After the age tiers, a total-size cap is enforced
# ($BACKUP_MAX_SIZE_MB, default 2048): while the managed dumps exceed
# it, the oldest dump is deleted, oldest first. The cap counts only
# full_*.dump files; anything else in the directory is ignored (never
# deleted, never counted). A cap smaller than about a day of dumps
# will eat into the <24h window. 0 disables the cap.
#
# Filename format: full_YYYY-MM-DD_HHMM.dump
# (a same-minute restart collision becomes full_YYYY-MM-DD_HHMMSS.dump,
# which is also understood). Dump-like names with an invalid timestamp
# are reported and left alone; anything else is ignored.
#
# Age is derived from the FILENAME, not mtime, so copies/moves don't
# reset retention. Pure-bash date math (no GNU `date -d`), so this runs
# on Linux, the pgbackup container, and macOS alike.
#
# Usage: prune.sh [BACKUP_DIR]      (default: $BACKUP_DIR or /backups)
# Env:   BACKUP_KEEP_DAYS (default 30)
#        BACKUP_MAX_SIZE_MB (default 2048 — total size cap for the
#          managed dumps in MB; oldest deleted first; 0 = no cap)
#
# Requires bash 4+ (`mapfile`).
# On macOS the default /bin/bash is 3.2 — run with a newer bash
# (`brew install bash`) or via:
#   docker exec contact-system-pgbackup bash /opt/pgbackup/prune.sh

set -euo pipefail

BACKUP_DIR="${1:-${BACKUP_DIR:-/backups}}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-30}"
FRESH_SECS=86400

if [[ ! -d "$BACKUP_DIR" ]]; then
  echo "[prune] directory $BACKUP_DIR not found, nothing to do" >&2
  exit 0
fi

NOW="$(date -u +%s)"
EXPIRED_SECS=$((KEEP_DAYS * 86400))

# days_from_civil Y M D -> whole days since 1970-01-01 (UTC).
# Howard Hinnant's days_from_civil algorithm; valid for all
# realistic dump dates. The 10# prefixes force decimal so values
# like 08/09 are never misread as octal.
days_from_civil() {
  local y=$((10#$1)) m=$((10#$2)) d=$((10#$3))
  if ((m <= 2)); then y=$((y - 1)); fi
  local era=$(((y >= 0 ? y : y - 399) / 400))
  local yoe=$((y - era * 400))
  local mshift
  if ((m > 2)); then mshift=$((m - 3)); else mshift=$((m + 9)); fi
  local doy=$(((153 * mshift + 2) / 5 + d - 1))
  local doe=$((yoe * 365 + yoe / 4 - yoe / 100 + doy))
  echo $((era * 146097 + doe - 719468))
}

# fmt_mb BYTES -> e.g. 12.3 (MB with one decimal, pure bash).
fmt_mb() {
  local b=$1
  echo "$((b / 1048576)).$(((b % 1048576) * 10 / 1048576))"
}

shopt -s nullglob
files=("$BACKUP_DIR"/full_*.dump)
shopt -u nullglob

if ((${#files[@]} == 0)); then
  echo "[prune] no dumps in $BACKUP_DIR"
  exit 0
fi

kept_fresh=0
kept_daily=0
deleted_expired=0
deleted_thinned=0
size_evicted=0
skipped=0

# "Old" files (past the 24h window, inside the keep window) are
# collected first, then thinned to 2 per calendar day.
old_files=()
old_epochs=()
old_days=()

# Survivors of the age tiers, for the size-cap phase.
all_files=()
all_epochs=()
all_sizes=()
total_bytes=0

# record_survivor PATH EPOCH — track a dump that survived the age
# tiers. `wc -c` is used instead of stat for portability (GNU/BSD
# stat flags differ).
record_survivor() {
  local sz
  sz=$(wc -c < "$1")
  all_files+=("$1")
  all_epochs+=("$2")
  all_sizes+=("$sz")
  total_bytes=$((total_bytes + sz))
}

for f in "${files[@]}"; do
  base="$(basename "$f")"
  if [[ ! "$base" =~ ^full_([0-9]{4})-([0-9]{2})-([0-9]{2})_([0-9]{2})([0-9]{2})([0-9]{2})?\.dump$ ]]; then
    echo "[prune] skip (unrecognized name): $base" >&2
    skipped=$((skipped + 1))
    continue
  fi
  Y="${BASH_REMATCH[1]}"
  MO="${BASH_REMATCH[2]}"
  D="${BASH_REMATCH[3]}"
  HH="${BASH_REMATCH[4]}"
  MI="${BASH_REMATCH[5]}"
  SS="${BASH_REMATCH[6]:-00}"
  if ((10#$MO < 1 || 10#$MO > 12 || 10#$D < 1 || 10#$D > 31 ||
    10#$HH > 23 || 10#$MI > 59 || 10#$SS > 59)); then
    echo "[prune] skip (invalid timestamp): $base" >&2
    skipped=$((skipped + 1))
    continue
  fi
  day="$Y-$MO-$D"
  midnight=$(($(days_from_civil "$Y" "$MO" "$D") * 86400))
  epoch=$((midnight + 10#$HH * 3600 + 10#$MI * 60 + 10#$SS))
  age=$((NOW - epoch))
  if ((age < 0)); then age=0; fi # future stamp (clock skew): keep
  if ((age > EXPIRED_SECS)); then
    echo "[prune] delete (older than ${KEEP_DAYS}d): $base"
    rm -f -- "$f"
    deleted_expired=$((deleted_expired + 1))
  elif ((age > FRESH_SECS)); then
    old_files+=("$f")
    old_epochs+=("$epoch")
    old_days+=("$day")
  else
    kept_fresh=$((kept_fresh + 1))
    record_survivor "$f" "$epoch"
  fi
done

if ((${#old_files[@]} > 0)); then
  mapfile -t days < <(printf '%s\n' "${old_days[@]}" | sort -u)
  for day in "${days[@]}"; do
    idxs=()
    for i in "${!old_files[@]}"; do
      if [[ "${old_days[$i]}" == "$day" ]]; then idxs+=("$i"); fi
    done
    if ((${#idxs[@]} <= 2)); then
      for i in "${idxs[@]}"; do
        kept_daily=$((kept_daily + 1))
        record_survivor "${old_files[$i]}" "${old_epochs[$i]}"
      done
      continue
    fi
    midnight=$(($(days_from_civil "${day:0:4}" "${day:5:2}" "${day:8:2}") * 86400))
    noon=$((midnight + 43200))
    # Keeper 1: dump closest to 00:00 UTC.
    keep_midnight=""
    best_midnight=""
    for i in "${idxs[@]}"; do
      e="${old_epochs[$i]}"
      if ((e >= midnight)); then dist=$((e - midnight)); else dist=$((midnight - e)); fi
      if [[ -z "$best_midnight" || "$dist" -lt "$best_midnight" ]]; then
        best_midnight="$dist"
        keep_midnight="$i"
      fi
    done
    # Keeper 2: dump closest to 12:00 UTC (must differ from keeper 1).
    keep_noon=""
    best_noon=""
    for i in "${idxs[@]}"; do
      if [[ "$i" == "$keep_midnight" ]]; then continue; fi
      e="${old_epochs[$i]}"
      if ((e >= noon)); then dist=$((e - noon)); else dist=$((noon - e)); fi
      if [[ -z "$best_noon" || "$dist" -lt "$best_noon" ]]; then
        best_noon="$dist"
        keep_noon="$i"
      fi
    done
    for i in "${idxs[@]}"; do
      if [[ "$i" == "$keep_midnight" || "$i" == "$keep_noon" ]]; then
        kept_daily=$((kept_daily + 1))
        record_survivor "${old_files[$i]}" "${old_epochs[$i]}"
      else
        echo "[prune] delete (thinned, keeping 2/day for $day): $(basename "${old_files[$i]}")"
        rm -f -- "${old_files[$i]}"
        deleted_thinned=$((deleted_thinned + 1))
      fi
    done
  done
fi

# Size cap: evict oldest first until the managed dumps fit.
cap_mb="${BACKUP_MAX_SIZE_MB:-2048}"
if [[ ! "$cap_mb" =~ ^[0-9]+$ ]]; then
  echo "[prune] WARN: invalid BACKUP_MAX_SIZE_MB='$cap_mb', using 2048" >&2
  cap_mb=2048
fi
if ((cap_mb > 0)) && ((${#all_files[@]} > 0)); then
  cap_bytes=$((cap_mb * 1048576))
  if ((total_bytes > cap_bytes)); then
    echo "[prune] size cap: $(fmt_mb "$total_bytes")MB > ${cap_mb}MB, evicting oldest first"
    mapfile -t evict_order < <(for i in "${!all_files[@]}"; do
      printf '%s\t%s\n' "${all_epochs[$i]}" "$i"
    done | sort -t $'\t' -k1,1n -k2,2n | cut -f2)
    for i in "${evict_order[@]}"; do
      if ((total_bytes <= cap_bytes)); then break; fi
      echo "[prune] delete (over ${cap_mb}MB cap, oldest first): $(basename "${all_files[$i]}")"
      rm -f -- "${all_files[$i]}"
      total_bytes=$((total_bytes - all_sizes[$i]))
      size_evicted=$((size_evicted + 1))
    done
  fi
fi

echo "[prune] done: fresh_kept=$kept_fresh daily_kept=$kept_daily expired_deleted=$deleted_expired thinned_deleted=$deleted_thinned size_evicted=$size_evicted size_mb=$(fmt_mb "$total_bytes") skipped=$skipped"
