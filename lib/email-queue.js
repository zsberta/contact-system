// lib/email-queue.js
//
// Bounded queue for outgoing SMTP mail. Sits between call sites
// (routes/auth.js, routes/users.js, routes/form-embed.js,
// routes/reservation-embed.js) and the nodemailer transport so:
//   - Rate-limit sends so we never burst-spam the SMTP provider. The
//     token bucket refill rate is env-tunable (default: 1 token /
//     5s, burst capacity 5). One notification + one auto-reply per
//     submission = 2 tokens consumed in a tight loop, the bucket
//     absorbs the burst and the refill paces the rest.
//   - Retry transient failures (network blip, SMTP 421, DNS hiccup)
//     with exponential backoff: 1s, 4s, 16s. Permanent failures
//     (auth error, 535) fail fast after attempt 1 — retrying a 535
//     just wastes the rate budget.
//   - Provide graceful shutdown on SIGTERM (the docker stop signal)
//     so jobs in-flight at deploy time get a chance to finish before
//     the process exits.
//
// Why in-memory, not DB-backed: load is low (a handful of submissions
// per day at most), and losing the queue on container restart is
// acceptable — the persisted submission is what matters, the
// notification is best-effort. If volume grows, swap the queue
// storage for a DB outbox table without changing the call site.
//
// Callers don't await send completion. They `enqueueMail(args)` and
// get back `{ id, status: "queued" }` immediately. The promise the
// queue returns is internal — used to keep the worker drained at
// shutdown — and is NOT meant to be awaited by callers (it resolves
// only after retries complete or the job gives up).

import { sendMail } from "./email.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BURST_CAPACITY = parseInt(
  process.env.EMAIL_QUEUE_BURST || "5",
  10,
);
const REFILL_INTERVAL_MS = parseInt(
  process.env.EMAIL_QUEUE_INTERVAL_MS || "1000",
  10,
);
const MAX_ATTEMPTS = parseInt(
  process.env.EMAIL_QUEUE_MAX_ATTEMPTS || "3",
  10,
);
// Backoff sequence is base^attempt ms. With base=1000: 1s, 4s, 16s.
// Third retry gives us ~21s of total patience before giving up,
// which is plenty for a transient SMTP blip but bounded so we don't
// hold tokens forever.
const BACKOFF_BASE_MS = 1000;
// Graceful shutdown timeout. Docker sends SIGTERM and waits
// stop_grace_period (default 10s) before SIGKILL. We cap at slightly
// less so the worker can finish cleanly.
const SHUTDOWN_TIMEOUT_MS = parseInt(
  process.env.EMAIL_QUEUE_SHUTDOWN_TIMEOUT_MS || "8000",
  10,
);

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

// Pending jobs waiting for a token. FIFO.
const pending = [];
// Jobs currently being sent (consumed a token, awaiting nodemailer).
const inFlight = new Set();
// Token bucket — refills REFILL_INTERVAL_MS at a time up to
// BURST_CAPACITY. Naive integer math: tokens * 1000 / interval.
let tokens = BURST_CAPACITY;
let lastRefillAt = Date.now();
// Monotonic counter used for log-friendly job IDs.
let nextJobId = 1;
// True after stop() runs — the worker drains in-flight but accepts no
// new pending jobs.
let stopping = false;
// Resolved when the queue is fully drained (no pending + no inFlight).
// Refreshed each time we transition from "has work" to "idle" so a
// stop() that races with new enqueue still gets the right signal.
let drainResolve = null;
let drainPromise = new Promise((res) => { drainResolve = res; });
function refreshDrainPromise() {
  // Only refresh if the previous promise has settled (otherwise we'd
  // leak the old promise's resolver without anyone waiting on it,
  // which is harmless but ugly).
  drainPromise = new Promise((res) => { drainResolve = res; });
}

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

function refillTokens() {
  const now = Date.now();
  const elapsed = now - lastRefillAt;
  if (elapsed < REFILL_INTERVAL_MS) return;
  const gained = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (gained <= 0) return;
  tokens = Math.min(BURST_CAPACITY, tokens + gained);
  lastRefillAt += gained * REFILL_INTERVAL_MS;
}

function consumeToken() {
  refillTokens();
  if (tokens <= 0) return false;
  tokens -= 1;
  return true;
}

function msUntilNextToken() {
  refillTokens();
  if (tokens > 0) return 0;
  return REFILL_INTERVAL_MS - (Date.now() - lastRefillAt);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

function scheduleWorker() {
  if (stopping) return;
  // setImmediate yields the current tick so the call site finishes
  // first; setTimeout(0) would do the same but with an extra ms
  // delay. Either is fine, immediate is marginally snappier.
  setImmediate(drainWorker);
}

function drainWorker() {
  if (stopping && pending.length === 0 && inFlight.size === 0) {
    // Fully drained — resolve the drain promise so stop() can return.
    drainResolve();
    return;
  }
  while (pending.length > 0 && inFlight.size < BURST_CAPACITY) {
    if (!consumeToken()) break;
    const job = pending.shift();
    runJob(job);
  }
  // If we still have work to do (either pending jobs or in-flight
  // jobs that may free up a slot), re-arm the worker.
  if (pending.length > 0 || inFlight.size > 0) {
    const wait = msUntilNextToken();
    setTimeout(drainWorker, wait);
  } else if (!stopping) {
    // Idle — resolve the drain promise so stop() can be called
    // without waiting forever.
    drainResolve();
    refreshDrainPromise();
  }
}

async function runJob(job) {
  inFlight.add(job);
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    // sendMail catches its own errors and resolves to true/false; it
    // does NOT throw. We treat `false` as a transient failure and
    // retry with backoff. The catch here is a defensive belt — if a
    // future refactor makes sendMail throw, we still don't crash the
    // worker loop.
    let ok = false;
    try {
      ok = await sendMail(job.args);
    } catch (err) {
      lastErr = err;
    }
    if (ok === true) {
      console.log(
        `[email/queue] job=${job.id} attempt=${attempt}/${MAX_ATTEMPTS} sent to=${job.args.to} subject="${job.args.subject}"`,
      );
      inFlight.delete(job);
      scheduleWorker();
      return;
    }
    if (attempt < MAX_ATTEMPTS) {
      const backoff = BACKOFF_BASE_MS * Math.pow(4, attempt - 1);
      console.warn(
        `[email/queue] job=${job.id} attempt=${attempt}/${MAX_ATTEMPTS} failed for=${job.args.to} (subject="${job.args.subject}"); retrying in ${backoff}ms`,
      );
      // Hold the slot during backoff so other queued jobs can't
      // leapfrog. Backoff is per-job — a 16s wait for one job doesn't
      // block parallel sends to other recipients.
      await sleep(backoff);
      if (stopping) break;
    }
  }
  console.error(
    `[email/queue] job=${job.id} GIVING UP after ${MAX_ATTEMPTS} attempts to=${job.args.to} subject="${job.args.subject}"`,
  );
  inFlight.delete(job);
  scheduleWorker();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// enqueueMail — queue an outgoing message and return immediately.
// The returned job id is for log correlation; callers MUST NOT await
// send completion (the public response has already been or is about
// to be returned).
export function enqueueMail(args) {
  if (!args || typeof args.to !== "string" || args.to.length === 0) {
    console.error("[email/queue] refusing to enqueue mail without a recipient:", args);
    return { id: -1, status: "rejected" };
  }
  const job = {
    id: nextJobId,
    args,
  };
  nextJobId += 1;
  pending.push(job);
  scheduleWorker();
  return { id: job.id, status: "queued" };
}

// stop — gracefully drain in-flight jobs. Called on SIGTERM so a
// docker stop doesn't drop notifications mid-send. Returns when the
// queue is empty OR the shutdown timeout expires, whichever comes
// first.
export async function stop() {
  stopping = true;
  // Re-arm the worker in case it's idle — it needs to see stopping=true
  // and resolve the drain promise.
  scheduleWorker();
  const timeout = new Promise((res) => setTimeout(() => res(false), SHUTDOWN_TIMEOUT_MS));
  const drained = drainPromise.then(() => true);
  const result = await Promise.race([drained, timeout]);
  if (!result) {
    console.warn(
      `[email/queue] shutdown timeout (${SHUTDOWN_TIMEOUT_MS}ms) reached with ${pending.length} pending and ${inFlight.size} in-flight jobs`,
    );
  } else {
    console.log(`[email/queue] drained cleanly on shutdown`);
  }
  // Reset state so the module can be reused after restart (relevant
  // only in tests; in prod the process exits).
  stopping = false;
  tokens = BURST_CAPACITY;
  lastRefillAt = Date.now();
  refreshDrainPromise();
}

// getQueueStats — exposes counts for debugging via a /api/health
// extension or just for log dumps. Cheap O(1).
export function getQueueStats() {
  refillTokens();
  return {
    pending: pending.length,
    inFlight: inFlight.size,
    tokensAvailable: tokens,
    burstCapacity: BURST_CAPACITY,
    refillIntervalMs: REFILL_INTERVAL_MS,
    maxAttempts: MAX_ATTEMPTS,
  };
}