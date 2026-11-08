//! SMTP mailer (lettre-backed) with a paced retry queue. Port of
//! `old_backend/lib/email.js` (`sendMail`) + `old_backend/lib/email-queue.js`
//! (`enqueueMail`, token bucket, worker).
//!
//! - Callers never await send completion. They call [`enqueue_mail`], which
//!   validates the recipient and returns `(job_id, "queued")` immediately.
//!   A background drain task (started via [`start`]) paces sends through a
//!   token bucket (`EMAIL_QUEUE_BURST`, default 5; `EMAIL_QUEUE_INTERVAL_MS`,
//!   default 1000) and retries transient failures with backoff 1s / 4s / 16s
//!   (`1000 * 4^(attempt-1)`, `EMAIL_QUEUE_MAX_ATTEMPTS`, default 3).
//! - `EMAIL_SENDING=false` is the global kill-switch: the worker drops the
//!   job silently (no retry, no log row) and [`send_now`] reports `false`
//!   without sending.
//! - `send_now` returns `bool` and never throws: transport/build failures
//!   are logged and reported as `false` so the worker can retry them.
//! - No `SMTP_HOST` → dev JSON-transport parity: the message is dumped to
//!   stdout (`[email/dev-json]`) and the send counts as delivered, exactly
//!   like the old nodemailer `jsonTransport` branch.
//! - The transport is built once and cached ([`transport`]).
//! - The old queue logged one `activity_log` SEND row per delivery; that
//!   write is intentionally dropped here — the worker logs via `tracing`
//!   instead (`logActivity` has no Rust equivalent in this workspace).
//!
//! NOTE: [`start`] must be called once when the binary boots (from the
//! application boot path, which is owned by another crew — this module only
//! exposes it). If it is never called, the first [`enqueue_mail`] starts
//! the worker lazily from inside the request runtime.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    transport::smtp::{
        authentication::Credentials,
        client::{Tls, TlsParameters},
    },
};

/// Default display name when a send doesn't pass one (port of
/// `DEFAULT_FROM_NAME` — the admin-initiated flows inherit this).
pub const DEFAULT_FROM_NAME: &str = "Nexus";

/// Outgoing message. `from_name` is the `From:` display name (defaults to
/// `"Nexus"`); `from_address` overrides the envelope sender (anything
/// without an `@` falls back to the default sender).
pub struct EmailJob {
    pub to: String,
    pub subject: String,
    pub text: String,
    pub html: String,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
}

fn env_int(name: &str, default: i64) -> i64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

fn burst_capacity() -> i64 {
    env_int("EMAIL_QUEUE_BURST", 5).max(1)
}

fn refill_interval_ms() -> u64 {
    env_int("EMAIL_QUEUE_INTERVAL_MS", 1000).max(1) as u64
}

fn max_attempts() -> u32 {
    env_int("EMAIL_QUEUE_MAX_ATTEMPTS", 3).clamp(1, 10) as u32
}

/// Global kill-switch — anything other than `"false"` (or unset) sends.
pub fn sending_enabled() -> bool {
    std::env::var("EMAIL_SENDING")
        .map(|v| v != "false")
        .unwrap_or(true)
}

fn resolve_from() -> String {
    let raw = std::env::var("SMTP_FROM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::env::var("ADMIN_EMAIL")
                .ok()
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_else(|| "no-reply@zsolts-crm.example".to_string());
    raw.trim().to_string()
}

fn display_name(job: &EmailJob) -> String {
    job.from_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_FROM_NAME.to_string())
}

fn envelope(job: &EmailJob) -> String {
    job.from_address
        .as_deref()
        .map(str::trim)
        .filter(|s| s.contains('@'))
        .map(str::to_string)
        .unwrap_or_else(resolve_from)
}

/// Cached transport (port of `cachedTransport`/`buildTransport`). `None`
/// means "no SMTP_HOST — dev JSON-transport mode".
static TRANSPORT: OnceLock<Option<AsyncSmtpTransport<Tokio1Executor>>> = OnceLock::new();

fn transport() -> &'static Option<AsyncSmtpTransport<Tokio1Executor>> {
    TRANSPORT.get_or_init(|| {
        let host = std::env::var("SMTP_HOST").unwrap_or_default();
        if host.trim().is_empty() {
            return None;
        }
        let port: u16 = std::env::var("SMTP_PORT")
            .ok()
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(1025);
        let secure = std::env::var("SMTP_SECURE").as_deref() == Ok("true");
        let dangerous = std::env::var("SMTP_REJECT_UNAUTHORIZED").as_deref() == Ok("false");
        let tls = if secure {
            if dangerous {
                TlsParameters::builder(host.clone())
                    .dangerous_accept_invalid_certs(true)
                    .build()
                    .ok()
                    .map(Tls::Wrapper)
            } else {
                TlsParameters::new(host.clone()).ok().map(Tls::Wrapper)
            }
        } else {
            // STARTTLS when advertised (nodemailer `secure: false` parity).
            TlsParameters::new(host.clone()).ok().map(Tls::Opportunistic)
        };
        let mut builder =
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(host.clone()).port(port);
        if let Some(tls) = tls {
            builder = builder.tls(tls);
        }
        let user = std::env::var("SMTP_USER").unwrap_or_default();
        let pass = std::env::var("SMTP_PASSWORD").unwrap_or_default();
        if !user.is_empty() && !pass.is_empty() {
            builder = builder.credentials(Credentials::new(user, pass));
        }
        Some(builder.build())
    })
}

/// Best-effort send. Returns `true` on success, `false` on any failure
/// (logged). Never panics — failures are `bool`s so the worker can retry.
pub async fn send_now(job: &EmailJob) -> bool {
    // Global kill switch — set EMAIL_SENDING=false to disable ALL outgoing
    // email. Everything funnels through here, so this is the single gate.
    if !sending_enabled() {
        println!(
            "[email/disabled] skipped to={} subject=\"{}\"",
            job.to, job.subject
        );
        return false;
    }
    let from_header = format!("\"{}\" <{}>", display_name(job), envelope(job));
    let from_box: lettre::message::Mailbox = match from_header.parse() {
        Ok(m) => m,
        Err(_) => match envelope(job).parse() {
            Ok(m) => m,
            Err(_) => {
                tracing::error!("[email] bad sender address; dropping");
                return false;
            }
        },
    };
    let to_box: lettre::message::Mailbox = match job.to.trim().parse() {
        Ok(m) => m,
        Err(_) => {
            tracing::error!("[email] bad recipient address; dropping");
            return false;
        }
    };
    let msg = match Message::builder()
        .from(from_box)
        .to(to_box)
        .subject(job.subject.clone())
        .multipart(
            lettre::message::MultiPart::alternative()
                .singlepart(lettre::message::SinglePart::plain(job.text.clone()))
                .singlepart(lettre::message::SinglePart::html(
                    if job.html.is_empty() {
                        job.text.clone()
                    } else {
                        job.html.clone()
                    },
                )),
        ) {
        Ok(m) => m,
        Err(e) => {
            tracing::error!("[email] message build failed: {e}");
            return false;
        }
    };

    match transport() {
        None => {
            // Dev JSON transport: dump the message (including any URLs) to
            // stdout so a developer can copy links out of the logs.
            let raw = String::from_utf8_lossy(&msg.formatted()).into_owned();
            println!(
                "[email/dev-json] would send to {} subject=\"{}\"\n{}\n--- raw ---\n{}",
                job.to, job.subject, job.text, raw
            );
            true
        }
        Some(t) => match t.send(msg).await {
            Ok(info) => {
                tracing::info!(
                    "[email/smtp] sent to {} subject=\"{}\" code={}",
                    job.to,
                    job.subject,
                    info.code(),
                );
                true
            }
            Err(e) => {
                tracing::error!("[email] send failed: {e}");
                false
            }
        },
    }
}

// ---------------------------------------------------------------------------
// Queue state + drain worker
// ---------------------------------------------------------------------------

struct QueuedJob {
    id: i64,
    job: EmailJob,
}

static PENDING: OnceLock<Mutex<VecDeque<QueuedJob>>> = OnceLock::new();
static NEXT_JOB_ID: AtomicI64 = AtomicI64::new(1);
static STARTED: AtomicBool = AtomicBool::new(false);
static WAKE: OnceLock<tokio::sync::Notify> = OnceLock::new();
/// Jobs currently sending (a job holds its slot during backoff, so a
/// stalled job can't be leapfrogged — same as the old `inFlight` set).
static IN_FLIGHT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn pending() -> &'static Mutex<VecDeque<QueuedJob>> {
    PENDING.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn wake() -> &'static tokio::sync::Notify {
    WAKE.get_or_init(tokio::sync::Notify::new)
}

/// Start the background drain worker. Safe to call multiple times (only
/// the first call spawns). Should be called once when the binary boots;
/// as a fallback the first [`enqueue_mail`] also starts it lazily.
pub fn start() {
    ensure_started();
}

fn ensure_started() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(h) => {
            h.spawn(drain_loop());
        }
        Err(_) => {
            // No runtime (e.g. called pre-boot): park the flag so a later
            // enqueue/start inside the runtime starts the worker, and log.
            STARTED.store(false, Ordering::SeqCst);
            tracing::warn!("[email/queue] start() called outside a runtime; worker deferred");
        }
    }
}

async fn drain_loop() {
    let mut tokens = burst_capacity();
    let mut last_refill = Instant::now();
    loop {
        let next = pending().lock().map(|mut q| q.pop_front()).unwrap_or(None);
        let Some(queued) = next else {
            wake().notified().await;
            continue;
        };
        // Concurrency cap: at most `burst` jobs in flight (a job holds its
        // slot during backoff). Parallel sends, like the old worker.
        while IN_FLIGHT.load(Ordering::SeqCst) >= burst_capacity() as usize {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Token bucket: refill by elapsed time, then consume one token.
        loop {
            let burst = burst_capacity();
            let interval = refill_interval_ms();
            let elapsed_ms = last_refill.elapsed().as_millis() as u64;
            if elapsed_ms >= interval {
                let gained = elapsed_ms / interval;
                tokens = (tokens + gained as i64).min(burst);
                last_refill += Duration::from_millis(gained * interval);
            }
            if tokens > 0 {
                tokens -= 1;
                break;
            }
            let wait = Duration::from_millis(interval.saturating_sub(elapsed_ms).max(1));
            tokio::time::sleep(wait).await;
        }
        IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        tokio::spawn(async move {
            run_job(queued).await;
            IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
            wake().notify_one();
        });
    }
}

async fn run_job(queued: QueuedJob) {
    // Kill switch: nothing is sent, so nothing is logged — a disabled
    // queue is not a delivery failure. Drop immediately, no retry.
    if !sending_enabled() {
        return;
    }
    let max = max_attempts();
    for attempt in 1..=max {
        // Re-check the kill switch before each attempt (the env may have
        // flipped while backing off).
        if !sending_enabled() {
            return;
        }
        if send_now(&queued.job).await {
            tracing::info!(
                "[email/queue] job={} attempt={}/{max} sent to={} subject=\"{}\"",
                queued.id,
                attempt,
                queued.job.to,
                queued.job.subject,
            );
            return;
        }
        if attempt < max {
            let backoff_ms = 1000u64.saturating_mul(4u64.saturating_pow(attempt - 1));
            tracing::warn!(
                "[email/queue] job={} attempt={}/{max} failed for={} (subject=\"{}\"); retrying in {backoff_ms}ms",
                queued.id,
                attempt,
                queued.job.to,
                queued.job.subject,
            );
            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        }
    }
    tracing::error!(
        "[email/queue] job={} GIVING UP after {max} attempts to={} subject=\"{}\"",
        queued.id,
        queued.job.to,
        queued.job.subject,
    );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Queue an outgoing message and return immediately: `(job_id, status)`.
/// `status` is `"queued"` or `"rejected"` (missing recipient — the old
/// code refused with `{ id: -1, status: "rejected" }`).
pub fn enqueue_mail(job: EmailJob) -> (i64, &'static str) {
    if job.to.trim().is_empty() {
        tracing::error!("[email/queue] refusing to enqueue mail without a recipient");
        return (-1, "rejected");
    }
    let id = NEXT_JOB_ID.fetch_add(1, Ordering::SeqCst);
    pending().lock().map(|mut q| q.push_back(QueuedJob { id, job })).ok();
    ensure_started();
    wake().notify_one();
    (id, "queued")
}

// ---------------------------------------------------------------------------
// Backwards-compat shim (do NOT use in new code — use `enqueue_mail`)
// ---------------------------------------------------------------------------

/// Thin wrapper over [`enqueue_mail`] for call sites owned by other crews
/// (`workers/*`, which this migration must not touch). Best-effort and
/// non-blocking: always returns `Ok(())` — delivery failures are retried
/// inside the worker and surfaced via `tracing`, never via this return.
pub struct EmailMailer;

impl EmailMailer {
    pub fn sending_enabled() -> bool {
        sending_enabled()
    }

    pub async fn send(
        to: &str,
        subject: &str,
        html: &str,
        text: &str,
    ) -> loco_rs::prelude::Result<()> {
        enqueue_mail(EmailJob {
            to: to.to_string(),
            subject: subject.to_string(),
            text: text.to_string(),
            html: html.to_string(),
            from_name: None,
            from_address: None,
        });
        Ok(())
    }
}
