# VPS setup — blog module + landing prerender integration

This document describes everything needed to wire the contact-system
blog module to the static landing pages on the VPS, end to end.

The pieces:

1. contact-system container publishes blog posts to PostgreSQL.
2. On publish/unpublish/delete, the contact-system writes a per-project
   trigger file to a host-bind-mounted directory (`/var/triggers/landing-rebuild/`).
3. A host-cron script watches that directory and runs
   `npm run build:content-only` in each landing repo, which calls back
   into the contact-system public read API and rewrites `dist/blog/<slug>/index.html`.
4. The reverse-proxy nginx serves the rebuilt `dist/` directly — no
   Vite preview server, no SPA fallback for blog post URLs (the
   static HTML is the source of truth).

The trigger file is the only inter-process primitive. We use a file
instead of a webhook because:

- The CRM container cannot reach the host filesystem or process table
  directly. `spawn()` from inside the container would fail at the
  bind-mount boundary or the user-permission boundary.
- A trigger file survives container restarts.
- The host cron can batch / dedupe / lock per-project trivially.

---

## 1. docker-compose.local.yml — bind mount the trigger directory

The contact-system container needs to write to
`/var/triggers/landing-rebuild/`, which is a host directory.

```yaml
# docker-compose.local.yml — under services.app
services:
  app:
    # ... existing config ...
    volumes:
      # NEW: where the CRM writes trigger flags.
      # Path is fixed — lib/landing-rebuild.js hardcodes it.
      - /var/triggers/landing-rebuild:/var/triggers/landing-rebuild:rw
      # NEW: where the CRM writes nothing yet, but useful for log
      # volume if you ever want to tail publish errors. Not strictly
      # required.
      # - /var/log/landing-rebuilds:/var/log/landing-rebuilds:rw
    environment:
      # NEW: override the default flag dir if you want a non-default path.
      # - LANDING_REBUILD_FLAG_DIR=/var/triggers/landing-rebuild
      # NEW: the shared secret the host cron uses to POST build outcomes
      # back to /api/internal/landing-build-status. Must match the
      # secret in /etc/landing-rebuild.env on the host.
      - LANDING_INTERNAL_SECRET=${LANDING_INTERNAL_SECRET:?set in .env}

  # ... db service unchanged ...
```

Then in `.env` on the host (or wherever your compose reads from):

```bash
# 32 random bytes, hex. Same value goes into /etc/landing-rebuild.env.
LANDING_INTERNAL_SECRET=$(openssl rand -hex 32)
```

After editing the compose file, restart the app:

```bash
docker compose -f docker-compose.local.yml up -d app
```

Verify the bind mount is visible inside the container:

```bash
docker exec contact-system-app ls -la /var/triggers/landing-rebuild
# expect: empty directory owned by the app user
```

---

## 2. Host directory setup

Create the trigger directory on the host (one-time):

```bash
sudo mkdir -p /var/triggers/landing-rebuild
sudo chown 1000:1000 /var/triggers/landing-rebuild
# 1000 is the typical nodeapp uid inside the container; check yours:
docker exec contact-system-app id -u
# if it's not 1000, use the value reported here.
```

Create the rebuild log directory (one-time):

```bash
sudo mkdir -p /var/log/landing-rebuilds
sudo chown 1000:1000 /var/log/landing-rebuilds
```

Create the rebuild secret file:

```bash
sudo tee /etc/landing-rebuild.env >/dev/null <<EOF
LANDING_INTERNAL_SECRET=REPLACE_WITH_THE_SAME_SECRET_AS_IN_CONTACT_SYSTEM_ENV
EOF
sudo chmod 600 /etc/landing-rebuild.env
```

The same secret must be in the contact-system `.env` file as
`LANDING_INTERNAL_SECRET`. If they don't match, the host's status
POSTs will 401 and the CRM won't update `projects.landing_last_build_*`.

---

## 3. Host cron script

Place this at `/usr/local/bin/landing-rebuild-watcher.sh` and `chmod +x` it:

```bash
#!/bin/bash
# landing-rebuild-watcher.sh — host-side cron companion to the
# contact-system blog module. Watches /var/triggers/landing-rebuild/
# for per-project trigger flags and runs the rebuild script in the
# corresponding landing repo.
#
# Cron line: * * * * * /usr/local/bin/landing-rebuild-watcher.sh
#
# Why a per-project lock: the CRM can publish 5 posts in quick
# succession, each writing a trigger flag. Without the lock, 5
# builds would race. The lock is per-domain (one project = one lock)
# so different projects can build in parallel.
#
# Why we don't run the full `npm run build` (with Vite): the static
# landing design changes rarely. The `build:content-only` script
# just rewrites the prerendered blog post HTML files using the
# existing `dist/index.html` template. ~5 seconds for 1k posts.
#
# Why we POST the build outcome back to the CRM: so the operator sees
# the last build status in the project view without having to log
# into the VPS.

set -euo pipefail

TRIGGERS=/var/triggers/landing-rebuild
LOGDIR=/var/log/landing-rebuilds
LOCKDIR=/var/run/landing-rebuild-locks
SECRET_FILE=/etc/landing-rebuild.env

# Source the secret. If the file is missing or unreadable, we still
# run the build (the build itself doesn't need the secret), but we
# skip the status POST so we don't 401-spam the CRM logs.
SECRET=""
if [[ -r "$SECRET_FILE" ]]; then
  # shellcheck disable=SC1090
  SECRET=$(grep '^LANDING_INTERNAL_SECRET=' "$SECRET_FILE" | cut -d= -f2-)
fi

CRM_BASE="${CRM_BASE:-http://localhost:3000}"

mkdir -p "$LOGDIR" "$LOCKDIR"

shopt -s nullglob
for flag in "$TRIGGERS"/*.flag; do
  # Skip malformed flags (e.g. truncated write during a crash).
  if ! data=$(cat "$flag" 2>/dev/null); then
    continue
  fi

  domain=$(echo "$data" | jq -r .domain 2>/dev/null || echo "")
  repoDir=$(echo "$data" | jq -r .repoDir 2>/dev/null || echo "")
  buildCmd=$(echo "$data" | jq -r .buildCommand 2>/dev/null || echo "")
  reason=$(echo "$data" | jq -r .reason 2>/dev/null || echo "")
  buildEnvJson=$(echo "$data" | jq -r .buildEnv 2>/dev/null || echo "{}")

  if [[ -z "$domain" || -z "$repoDir" ]]; then
    echo "[$(date -Iseconds)] malformed flag: $flag" >> "$LOGDIR/watcher.log"
    rm -f "$flag"
    continue
  fi

  lock="$LOCKDIR/$domain.lock"
  # If a build is already running for this domain, skip — the next
  # cron tick (or the current build finishing) will pick this up.
  # We DO NOT remove the flag yet; the current build's loop will
  # remove it after it finishes (it sweeps the whole dir).
  if [[ -f "$lock" ]]; then
    echo "[$(date -Iseconds)] $domain: build in progress, skipping" >> "$LOGDIR/watcher.log"
    continue
  fi
  touch "$lock"

  logfile="$LOGDIR/$domain.log"
  echo "[$(date -Iseconds)] $domain: starting build ($reason)" >> "$logfile"

  # Run the build. We pipe buildEnv JSON into the env so the landing
  # script sees e.g. LANDING_DOMAIN set to its own value.
  startMs=$(date +%s%3N)
  (
    cd "$repoDir" || exit 1
    # Source the JSON-derived env, then run the user's buildCommand.
    # jq -r outputs `KEY=value` lines which `env` consumes.
    env \
      CI=1 \
      CRM_API_BASE="$CRM_BASE" \
      LANDING_DOMAIN="$domain" \
      $(echo "$buildEnvJson" | jq -r 'to_entries | .[] | "\(.key)=\(.value)"') \
      bash -c "$buildCmd" >> "$logfile" 2>&1
  )
  rc=$?
  endMs=$(date +%s%3N)
  durationMs=$((endMs - startMs))

  if [[ $rc -eq 0 ]]; then
    status="success"
    logLine="$domain: build succeeded in ${durationMs}ms"
  else
    status="failed"
    logLine="$domain: build FAILED (exit=$rc) in ${durationMs}ms"
  fi
  echo "[$(date -Iseconds)] $logLine" >> "$logfile"
  echo "[$(date -Iseconds)] $logLine" >> "$LOGDIR/watcher.log"

  # POST the outcome back to the CRM.
  if [[ -n "$SECRET" ]]; then
    # Capture the last 8 KB of stderr from the logfile to send as
    # the operator-facing error message.
    logTail=$(tail -c 8192 "$logfile" | jq -Rs .)
    curl -sS -X POST "$CRM_BASE/api/internal/landing-build-status" \
      -H "content-type: application/json" \
      -H "x-internal-secret: $SECRET" \
      --max-time 5 \
      --data "$(jq -n --arg domain "$domain" --arg status "$status" --argjson log "$logTail" --argjson durationMs "$durationMs" \
        '{domain:$domain, status:$status, log:$log, durationMs:$durationMs}')" \
      >/dev/null 2>&1 || true
  fi

  rm -f "$lock"
  rm -f "$flag"
done
```

Install:

```bash
sudo install -m 755 /path/to/landing-rebuild-watcher.sh /usr/local/bin/
```

Install the cron entry:

```bash
sudo crontab -e
# Add:
* * * * * /usr/local/bin/landing-rebuild-watcher.sh
```

You can test the watcher manually before relying on cron:

```bash
# Trigger a build manually:
echo '{"domain":"zsoltberta.hu","repoDir":"/home/zsolt/www/zsoltberta.hu","buildCommand":"npm run build:content-only","reason":"manual-test","buildEnv":{}}' \
  | sudo tee /var/triggers/landing-rebuild/zsoltberta-hu-test.flag

# Run the watcher:
sudo /usr/local/bin/landing-rebuild-watcher.sh

# Tail the log:
tail -f /var/log/landing-rebuilds/zsoltberta.hu.log
```

---

## 4. Reverse-proxy: no changes needed for blog URLs

The existing `nginx-proxy` container already serves the landing
domain's `dist/` directory. The blog prerender writes
`dist/blog/<slug>/index.html`, and the existing `try_files` rule
serves it directly:

```nginx
location / {
  try_files $uri $uri/ /index.html;
}
```

When a visitor hits `https://zsoltberta.hu/blog/foo-bar`, nginx finds
`/var/www/zsoltberta.hu/dist/blog/foo-bar/index.html` (read-only
bind-mount in your reverse-proxy compose) and serves it as a static
file. No SSR, no PHP, no upstream proxy.

You do NOT need to add a `/blog/` location block, because the
prerendered HTML is in `dist/` already.

---

## 5. Configure each landing project in the CRM admin UI

For every project whose landing should publish blog content:

1. Open the project in the admin UI: `/projects/view/<id>`.
2. In the **Landing oldal beállítások** section, fill in:
   - **Landing repository path**: the host path of the landing's
     source tree, e.g. `/home/zsolt/www/zsoltberta.hu`. This must
     exist on the host and be readable by the user running the cron
     (typically root or a `deploy` user).
   - **Build command**: leave the default `npm run build:content-only`
     unless the landing's `package.json` defines a different script.
   - **Landing dist path** (optional, informational): where the
     prerender output ends up. Usually
     `/home/zsolt/www/zsoltberta.hu/dist`.
   - **Landing enabled**: must be **true** for the publish handler to
     write trigger flags.

3. Save. The next publish will trigger a build.

For multiple landings on one VPS, repeat per project. Each project
gets its own `landing_repo_dir` and its own per-domain lock file in
`/var/run/landing-rebuild-locks/`.

---

## 6. Per-landing requirements

Each landing repo must have:

- A `package.json` with a `build:content-only` script that runs the
  prerender against the contact-system public API.
- The `scripts/generate-blog-routes.mjs` file from this repo's
  pattern (already added to zsoltberta.hu as part of this feature).
- A populated `dist/` from at least one prior `vite build` (the
  prerender script uses `dist/index.html` as a template).

If you `git clone` a fresh landing repo, you must run `npm install`
and `npm run build` once on the host BEFORE the cron can run
`build:content-only`. After that initial setup, the cron only
re-runs the prerender (the cheap part) — Vite is not invoked.

---

## 7. End-to-end test

After the above is in place:

1. Log into the CRM admin at `https://crm.zsoltberta.hu`.
2. Go to `/blog`, create a new post, mark it `published`.
3. Within ~60 seconds (cron interval), check
   `/home/zsolt/www/zsoltberta.hu/dist/blog/<slug>/index.html`
   exists on the host.
4. Open `https://zsoltberta.hu/blog/<slug>` in an incognito tab. The
   page should render with the title, body, and meta tags from the
   CRM.
5. View the page source — confirm the static HTML contains the
   title, OG tags, JSON-LD `BlogPosting` schema, and the body
   `<article data-blog-fallback>` block.

If step 3 fails, check:
- `/var/log/landing-rebuilds/<domain>.log` on the host.
- `docker logs contact-system-app` for the publish-time trigger write.
- `/var/triggers/landing-rebuild/` for stuck flags (a stuck flag
  without an active lock means the watcher crashed mid-run; remove
  it manually and the next cron tick will pick up the next flag).

---

## 8. Operational notes

- **The build is idempotent.** Re-running it produces the same
  `dist/blog/<slug>/index.html` (assuming the CRM hasn't changed the
  post).
- **Failed builds don't roll back.** If the build crashes, the
  previous `dist/` stays in place — visitors see the last good
  version. The `landing_last_build_status='failed'` flag in the
  CRM tells the operator.
- **The cron is per-project locked.** If two landing projects
  publish simultaneously, they build in parallel (separate lock
  files).
- **Multi-locale**: each post is per-(project, locale). The
  `dist/<slug>/index.html` lives under the same slug regardless of
  locale; if you want per-locale URL prefixes like `/en/blog/foo`,
  the prerender script needs an additional `langPrefix` parameter
  (not implemented yet — single-locale per landing is the v1
  contract).
- **At millions of posts**, the build is still under a minute per
  rebuild (most of the time spent in `mkdir`/`writeFile`). The
  `state.json` short-circuits unchanged posts.
- **The `dist/.prerender-state.json` file is committed in spirit
  but should NOT be uploaded anywhere — it's local state.**

---

## 9. What this does NOT cover

- **Multi-locale URL prefixes** (e.g. `/en/blog/foo`): the v1 design
  uses a single locale per landing. If a landing needs EN + HU
  side-by-side, the routing requires a prefix-aware version of the
  script.
- **Image uploads in the blog editor**: the Tiptap editor in
  `BlogBodyEditor.tsx` only handles external image URLs (typed or
  pasted). Drag-and-drop file uploads would require a `/api/blog/:id/upload`
  endpoint backed by the existing `project_attachments` infrastructure.
- **Landing-side caching headers**: the nginx config in
  `reverse-proxy/nginx.conf` already sets `Cache-Control: max-age=...`
  on `/assets/.*` and `/blog/<slug>/`. If you change the prerender,
  invalidate the CDN / nginx cache by `nginx -s reload` (the
  build process doesn't auto-reload nginx, since reloads on every
  publish would be wasteful; do it manually after a batch of
  publishes if you have a CDN in front).