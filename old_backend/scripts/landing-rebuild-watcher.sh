#!/usr/bin/env bash
# ----------------------------------------------------------------------------
# landing-rebuild-watcher.sh — Polls the flag directory for pending landing
# rebuilds and executes them.
#
# Production: run via cron every minute:
#   * * * * * /usr/local/bin/landing-rebuild-watcher.sh >> /var/log/landing-rebuild.log 2>&1
#
# Local dev:  run as a background process:
#   ./scripts/landing-rebuild-watcher.sh --foreground
#
# Reads *.flag JSON files from LANDING_REBUILD_FLAG_DIR (default:
# /var/triggers/landing-rebuild). Each flag contains:
#   { domain, repoDir, buildCommand, reason, buildEnv, queuedAt }
#
# Per-project lockfile prevents concurrent builds for the same domain.
# After a successful build, calls the CRM's internal callback endpoint
# to report status.
# ----------------------------------------------------------------------------

set -euo pipefail

# ---- Configuration ----
FLAG_DIR="${LANDING_REBUILD_FLAG_DIR:-/var/triggers/landing-rebuild}"
CRM_BASE_URL="${LANDING_CRM_BASE_URL:-http://localhost:3000}"
INTERNAL_SECRET="${LANDING_INTERNAL_SECRET:-}"
LOCK_DIR="${LANDING_LOCK_DIR:-/tmp/landing-rebuild-locks}"
LOG_PREFIX="[landing-rebuild]"
POLL_INTERVAL="${LANDING_POLL_INTERVAL:-10}"  # seconds (10 for dev, 60 for prod cron)

# ---- Functions ----

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $*"
}

# Write back build status to the CRM's internal endpoint.
# Args: $1=domain $2=status (success|failed) $3=log (optional)
report_status() {
  local domain="$1"
  local status="$2"
  local build_log="${3:-}"
  local duration_ms="${4:-}"

  if [[ -z "$INTERNAL_SECRET" ]]; then
    log "WARN: LANDING_INTERNAL_SECRET not set, skipping status report for $domain"
    return 0
  fi

  local payload
  payload=$(cat <<EOF
{
  "domain": "$domain",
  "status": "$status",
  "log": $(echo "$build_log" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()[-2000:]))' 2>/dev/null || echo '""'),
  "durationMs": ${duration_ms:-0}
}
EOF
)

  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${CRM_BASE_URL}/api/internal/landing-build-status" \
    -H "Content-Type: application/json" \
    -H "X-Internal-Secret: ${INTERNAL_SECRET}" \
    -d "$payload" \
    2>/dev/null || echo "000")

  if [[ "$http_code" == "204" ]]; then
    log "Status reported for $domain: $status"
  else
    log "WARN: Status report failed for $domain (HTTP $http_code)"
  fi
}

# Process a single flag file.
process_flag() {
  local flag_file="$1"
  local filename
  filename=$(basename "$flag_file")

  # Parse the JSON flag.
  if ! command -v python3 &>/dev/null; then
    log "ERROR: python3 required to parse flag files"
    return 1
  fi

  local domain repo_dir build_command reason build_env
  domain=$(python3 -c "import json,sys; d=json.load(open('$flag_file')); print(d.get('domain',''))" 2>/dev/null || echo "")
  repo_dir=$(python3 -c "import json,sys; d=json.load(open('$flag_file')); print(d.get('repoDir',''))" 2>/dev/null || echo "")
  build_command=$(python3 -c "import json,sys; d=json.load(open('$flag_file')); print(d.get('buildCommand','npm run build:content-only'))" 2>/dev/null || echo "npm run build:content-only")
  reason=$(python3 -c "import json,sys; d=json.load(open('$flag_file')); print(d.get('reason',''))" 2>/dev/null || echo "")

  if [[ -z "$domain" || -z "$repo_dir" ]]; then
    log "SKIP: $filename — missing domain or repoDir"
    rm -f "$flag_file"
    return 0
  fi

  log "Processing: $domain (reason: $reason)"

  # Per-project lockfile — skip if another build is running for this domain.
  mkdir -p "$LOCK_DIR"
  local lockfile="$LOCK_DIR/${domain}.lock"
  if [[ -f "$lockfile" ]]; then
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lockfile" 2>/dev/null || stat -c %Y "$lockfile" 2>/dev/null || echo "$(date +%s)") ))
    # If lock is older than 30 minutes, it's stale — remove it.
    if [[ $lock_age -gt 1800 ]]; then
      log "WARN: Stale lock for $domain (${lock_age}s old), removing"
      rm -f "$lockfile"
    else
      log "SKIP: $filename — build already running for $domain (${lock_age}s ago)"
      return 0
    fi
  fi

  # Create lockfile.
  echo "$$" > "$lockfile"

  # Verify the repo directory exists.
  if [[ ! -d "$repo_dir" ]]; then
    log "ERROR: $filename — repo dir does not exist: $repo_dir"
    report_status "$domain" "failed" "Repository directory not found: $repo_dir"
    rm -f "$lockfile" "$flag_file"
    return 0
  fi

  # Run the build command.
  local start_time
  start_time=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s)

  log "Running: cd $repo_dir && $build_command"
  local build_output
  local exit_code=0
  build_output=$(cd "$repo_dir" && eval "$build_command" 2>&1) || exit_code=$?

  local end_time
  end_time=$(python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || date +%s)
  local duration_ms=$(( end_time - start_time ))

  if [[ $exit_code -eq 0 ]]; then
    log "SUCCESS: $domain build completed in ${duration_ms}ms"
    report_status "$domain" "success" "$build_output" "$duration_ms"
  else
    log "FAILED: $domain build failed (exit code $exit_code) in ${duration_ms}ms"
    report_status "$domain" "failed" "$build_output" "$duration_ms"
  fi

  # Remove lockfile and flag.
  rm -f "$lockfile" "$flag_file"
}

# ---- Main ----

mkdir -p "$FLAG_DIR" "$LOCK_DIR"

if [[ "${1:-}" == "--foreground" ]]; then
  # Foreground mode for local dev — polls in a loop.
  log "Starting in foreground mode (polling every ${POLL_INTERVAL}s)"
  log "Flag dir: $FLAG_DIR"
  log "CRM URL:  $CRM_BASE_URL"

  while true; do
    # Process all flag files, oldest first.
    for flag in "$FLAG_DIR"/*.flag; do
      [[ -f "$flag" ]] || continue
      process_flag "$flag" || true
    done
    sleep "$POLL_INTERVAL"
  done
else
  # Single-pass mode for cron — process flags and exit.
  for flag in "$FLAG_DIR"/*.flag; do
    [[ -f "$flag" ]] || continue
    process_flag "$flag" || true
  done
fi
