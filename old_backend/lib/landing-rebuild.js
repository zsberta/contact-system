import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Bridge between the CRM and the host-cron landing rebuild watcher.
//
// On the VPS, the contact-system container's docker-compose mounts a
// host directory at /var/triggers/landing-rebuild (see docker-compose.yml).
// The host-cron runs /usr/local/bin/landing-rebuild-watcher.sh every
// minute; that script reads any *.flag files in the directory and runs
// the per-project build command. Files older than the cron interval
// (e.g. missed while the host was rebooting) are still processed.
//
// Why a flag directory instead of a webhook endpoint:
//   1. The CRM container can't reach the host filesystem or process
//      table — a spawn() from inside the container would fail at the
//      bind-mount boundary or the user-permission boundary.
//   2. The host-cron already runs as root (or a deploy user) and has
//      full access to /home/zsolt/www/<landing>/; the CRM just needs
//      to leave a note.
//   3. Flag files survive container restarts. A queued webhook would
//      be lost if the CRM crashed between publish and rebuild.
//
// Atomicity:
//   Each write is to a unique filename derived from the publish event,
//   so concurrent publishes don't clobber each other's flags. The host
//   script removes the flag once it has spawned the build.
//
// Failure modes:
//   - If the bind mount is missing (env not set, compose not updated),
//     we log and return success — the post is published regardless.
//     The operator gets a single warning per failure rather than the
//     publish endpoint 500'ing.
//   - If the directory doesn't exist, we create it (mkdir -p).
//
// Concurrency safety:
//   The host-cron script holds a per-project lockfile while building,
//   so even if 5 flags for the same project land in the same minute,
//   only one build runs. The others become no-ops on the next cron
//     tick (their flag file still exists but the lock is held).

const DEFAULT_FLAG_DIR = "/var/triggers/landing-rebuild";

function getFlagDir() {
  // Allow override via env so dev environments without the bind mount
  // can route the flag somewhere they can poll (e.g. /tmp). Default is
  // the production path.
  return process.env.LANDING_REBUILD_FLAG_DIR || DEFAULT_FLAG_DIR;
}

/**
 * Write a per-event flag file the host-cron will pick up on its next
 * tick. Best-effort: errors are surfaced via the returned promise so the
 * caller can log them, but never via throwing — the calling route is
 * always expected to resolve the user request even if the trigger
 * mechanism is degraded.
 *
 * @param {Object} args
 * @param {string} args.domain - the project's canonical domain
 *   (e.g. "zsoltberta.hu"). Used by the host script for log labelling.
 * @param {string} args.repoDir - the landing's source directory on the
 *   host (e.g. "/home/zsolt/www/zsoltberta.hu"). The host script
 *   `cd`s here before invoking the build command.
 * @param {string} args.buildCommand - the shell command to run. Defaults
 *   to "npm run build:content-only" if unset on the project record.
 * @param {string} args.reason - free-form audit label (e.g. "publish:post:42")
 * @param {Object} [args.buildEnv] - optional env vars to expose to the build
 *   (e.g. {LANDING_DOMAIN: "zsoltberta.hu"}). Persisted as JSON in the
 *   flag so the host script can replay them on the build invocation.
 * @returns {Promise<{written: boolean, path?: string, reason?: string}>}
 */
export async function writeLandingRebuildFlag({
  domain,
  repoDir,
  buildCommand,
  reason,
  buildEnv = {},
}) {
  if (!domain || !repoDir) {
    // Without domain/repoDir the host script has nothing to act on;
    // logging at the caller is enough.
    return { written: false, reason: "missing domain or repoDir" };
  }

  const flagDir = getFlagDir();
  try {
    await fs.mkdir(flagDir, { recursive: true });
  } catch (err) {
    console.error(
      "[landing-rebuild] cannot create flag dir",
      flagDir,
      err.code,
      err.message,
    );
    return { written: false, reason: "mkdir_failed" };
  }

  // Filename embeds the project domain (so the host script can route
  // multi-project flags) and a timestamp + nonce (so concurrent
  // publishes don't collide on the same name).
  const ts = Date.now();
  const nonce = crypto.randomBytes(4).toString("hex");
  const safeDomain = domain.replace(/[^a-z0-9.-]/gi, "-").toLowerCase();
  const filename = `${safeDomain}-${ts}-${nonce}.flag`;
  const fullPath = path.join(flagDir, filename);

  const payload = {
    domain,
    repoDir,
    buildCommand: buildCommand || "npm run build:content-only",
    reason: reason || "manual",
    buildEnv,
    queuedAt: new Date(ts).toISOString(),
  };

  try {
    await fs.writeFile(fullPath, JSON.stringify(payload, null, 2), {
      mode: 0o644,
    });
    return { written: true, path: fullPath };
  } catch (err) {
    console.error(
      "[landing-rebuild] cannot write flag",
      fullPath,
      err.code,
      err.message,
    );
    return { written: false, reason: "write_failed" };
  }
}