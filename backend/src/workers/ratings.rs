//! Background scheduler that sends rating-request emails to customers
//! whose booking was marked `attended` ("Részt vett"). Mirrors the
//! reminders worker: the `rating_sent_at` NULL-claim makes the send
//! idempotent and single-flight.
//!
//! Cadence: run immediately on startup, then every RATING_POLL_INTERVAL_SECS
//! seconds (default 60). Env guard DISABLE_RATINGS=true skips startup.
//!
//! Frequency throttle (per project, `rating_email_every_n_bookings`, N):
//! the guest's past attended visits (same reservation + email, visit over)
//! are counted, oldest first; the current visit is #`ordinal`. The email
//! goes out when `ordinal == 1` (first visit always emails) or when
//! `ordinal % N == 0` — e.g. N=5 sends on visits 1, 5, 10, 15, ...
//! Bookings that lose the throttle check are still stamped
//! (`rating_sent_at`) so they are never reconsidered. N=1 preserves the
//! old behavior: every attended visit emails (until the guest rates).
//!
//! Deploy safety: historical attended bookings are pre-stamped as processed
//! by migration `..._backfill_rating_sent_at`, so enabling this on an
//! environment with past visits never mass-emails old guests — only visits
//! marked attended afterwards can generate emails.
//!
//! Skip rules (a booking is only picked up when ALL hold):
//! - status = 'attended' and rating_sent_at IS NULL
//! - the visit is over (ends_at < now())
//! - the booking has a non-empty email address
//! - the booking itself has no rating yet
//! - the same customer (same email, same reservation) has not rated before —
//!   once a customer rated at least once, they never get another rating email

use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseBackend, Statement};

const BATCH_SIZE: i64 = 100;
const DEFAULT_POLL_INTERVAL_SECS: u64 = 60;
const MIN_POLL_INTERVAL_SECS: u64 = 10;

/// Poll interval for the rating loop. Overridable via
/// `RATING_POLL_INTERVAL_SECS` (seconds, minimum 10, default 60).
fn poll_interval_secs() -> u64 {
    std::env::var("RATING_POLL_INTERVAL_SECS")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_POLL_INTERVAL_SECS)
        .max(MIN_POLL_INTERVAL_SECS)
}

// ---------------------------------------------------------------------------
// run_once — query due bookings, claim, and send rating-request emails
// ---------------------------------------------------------------------------

/// One rating tick. Returns the number of rating emails sent. Best-effort:
/// per-booking failures are logged and retried on the next tick (their
/// rating_sent_at stays NULL); a failed lookup returns 0.
pub async fn run_once(db: &DatabaseConnection) -> usize {
    let rows = match db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT b.id AS booking_id,
                    b.starts_at, b.ends_at,
                    b.email, b.first_name, b.last_name,
                    b.service_name_snapshot, b.timezone,
                    b.locale, b.booking_token,
                    r.id AS reservation_id,
                    r.name AS reservation_name,
                    r.secret_token,
                    r.project_id,
                    p.name AS project_name,
                    p.domain_address,
                    p.customer_email,
                    p.rating_email_every_n_bookings
             FROM reservation_bookings b
             JOIN reservations r ON r.id = b.reservation_id
             JOIN projects p ON p.id = r.project_id
             WHERE b.rating_sent_at IS NULL
               AND b.status = 'attended'
               AND b.ends_at < now()
               AND NOT EXISTS (
                     SELECT 1 FROM reservation_ratings rr
                     WHERE rr.booking_id = b.id
                   )
               AND NOT EXISTS (
                     SELECT 1 FROM reservation_ratings rr
                     WHERE rr.reservation_id = b.reservation_id
                       AND lower(rr.email) = lower(b.email)
                   )
             ORDER BY b.ends_at
             LIMIT $1",
            vec![BATCH_SIZE.into()],
        ))
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[ratings] due-bookings lookup failed: {e:?}");
            return 0;
        }
    };
    if rows.is_empty() {
        return 0;
    }

    let mut sent: usize = 0;
    for row in &rows {
        let booking_id: i64 = row
            .try_get("", "booking_id")
            .or_else(|_| row.try_get::<i32>("", "booking_id").map(|v| v as i64))
            .unwrap_or(0);
        let email: String = row
            .try_get::<Option<String>>("", "email")
            .ok()
            .flatten()
            .unwrap_or_default();
        // Skip bookings without an email address (still stamped so the next
        // tick doesn't pick them up again).
        if email.trim().is_empty() {
            let _ = db
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "UPDATE reservation_bookings SET rating_sent_at = now() WHERE id = $1",
                    vec![booking_id.into()],
                ))
                .await;
            continue;
        }

        // Frequency throttle: which visit number is this for the guest?
        // Count their past attended visits (same reservation + email,
        // visit over), oldest first — the current booking included, so the
        // first visit is #1. Stateless: reprocessing (e.g. after a status
        // flip-flop) yields the same number, never an extra email.
        let every_n: i64 = row
            .try_get::<Option<i32>>("", "rating_email_every_n_bookings")
            .ok()
            .flatten()
            .map(|v| v as i64)
            .or_else(|| {
                row.try_get::<Option<i64>>("", "rating_email_every_n_bookings")
                    .ok()
                    .flatten()
            })
            .unwrap_or(1)
            .max(1);
        let reservation_id: i64 = row
            .try_get("", "reservation_id")
            .or_else(|_| row.try_get::<i32>("", "reservation_id").map(|v| v as i64))
            .unwrap_or(0);
        let ends_dt: Option<chrono::DateTime<chrono::Utc>> =
            row.try_get("", "ends_at").ok();
        let ordinal: Option<i64> = match ends_dt {
            Some(ends) => db
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT COUNT(*)::bigint AS ord FROM reservation_bookings
                      WHERE reservation_id = $1 AND status = 'attended'
                        AND lower(email) = lower($2)
                        AND ends_at < now()
                        AND (ends_at, id) <= ($3::timestamptz, $4)",
                    vec![
                        reservation_id.into(),
                        email.clone().into(),
                        ends.to_rfc3339().into(),
                        booking_id.into(),
                    ],
                ))
                .await
                .ok()
                .flatten()
                .and_then(|r| r.try_get::<i64>("", "ord").ok()),
            None => None,
        };
        let Some(ordinal) = ordinal else {
            // Ordinal lookup failed — stamp and skip (never send blind):
            // the stateless count keeps future visits on schedule.
            tracing::error!("[ratings] ordinal lookup failed booking={booking_id}");
            let _ = db
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "UPDATE reservation_bookings SET rating_sent_at = now() WHERE id = $1",
                    vec![booking_id.into()],
                ))
                .await;
            continue;
        };
        if ordinal != 1 && ordinal % every_n != 0 {
            // Throttled visit — stamp so it is never reconsidered, no email.
            tracing::debug!(
                "[ratings] throttled booking={booking_id} visit=#{ordinal} every_n={every_n}"
            );
            let _ = db
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "UPDATE reservation_bookings SET rating_sent_at = now() WHERE id = $1",
                    vec![booking_id.into()],
                ))
                .await;
            continue;
        }

        match send_rating_email_for_booking(db, booking_id).await {
            Ok(()) => sent += 1,
            Err(RatingEmailError::Failed(detail)) => {
                // Leave rating_sent_at NULL so the next tick retries.
                tracing::error!("[ratings] failed booking={booking_id}: {detail}");
            }
            Err(e) => {
                // Became ineligible between select and send (rated, status
                // flip, email wiped): stamp so it is never reconsidered.
                tracing::debug!("[ratings] skipped booking={booking_id}: {e}");
                let _ = db
                    .execute_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "UPDATE reservation_bookings SET rating_sent_at = now() WHERE id = $1",
                        vec![booking_id.into()],
                    ))
                    .await;
            }
        }
    }
    sent
}

// ---------------------------------------------------------------------------
// Shared send — used by the worker loop above AND the manual admin trigger.
// Same checks, same template, same stamp (so the worker ignores manually
// sent bookings afterwards). The ONLY thing the manual trigger skips is
// the frequency throttle: an explicit send always goes out.
// ---------------------------------------------------------------------------

/// Why a rating email was refused (maps to 4xx in the admin endpoint).
#[derive(Debug)]
pub enum RatingEmailError {
    NotFound,
    /// Not attended / visit not over / no email address.
    NotEligible(String),
    /// This booking — or this guest in this reservation — already rated.
    AlreadyRated(String),
    /// Render/enqueue/stamp failure (transient: safe to retry).
    Failed(String),
}

impl std::fmt::Display for RatingEmailError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RatingEmailError::NotFound => write!(f, "Booking not found"),
            RatingEmailError::NotEligible(m) => write!(f, "{m}"),
            RatingEmailError::AlreadyRated(m) => write!(f, "{m}"),
            RatingEmailError::Failed(m) => write!(f, "{m}"),
        }
    }
}

/// Send the rating-request email for one booking: validate, render with the
/// booking-email template, enqueue, and stamp `rating_sent_at` (idempotent
/// single-flight — the worker picks only unstamped bookings, so a manual
/// send is never duplicated automatically).
pub async fn send_rating_email_for_booking(
    db: &DatabaseConnection,
    booking_id: i64,
) -> Result<(), RatingEmailError> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT b.id AS booking_id,
                    b.status, b.starts_at, b.ends_at,
                    b.email, b.first_name, b.last_name,
                    b.service_name_snapshot, b.timezone,
                    b.locale, b.booking_token, b.reservation_id,
                    r.secret_token, r.project_id,
                    p.name AS project_name,
                    p.domain_address,
                    p.customer_email
             FROM reservation_bookings b
             JOIN reservations r ON r.id = b.reservation_id
             JOIN projects p ON p.id = r.project_id
             WHERE b.id = $1",
            vec![booking_id.into()],
        ))
        .await
        .map_err(|e| RatingEmailError::Failed(format!("lookup failed: {e:?}")))?
        .ok_or(RatingEmailError::NotFound)?;

    let status: String = row.try_get("", "status").unwrap_or_default();
    // Guest-facing messages follow the booking's language (hu default),
    // same convention as the email templates — the admin endpoint shows
    // them directly in toasts.
    let hu = opt_str(&row, "locale")
        .map(|s| !s.to_lowercase().starts_with("en"))
        .unwrap_or(true);
    if status != "attended" {
        return Err(RatingEmailError::NotEligible(if hu {
            "Csak „Részt vett” státuszú foglalásra küldhető értékelő e-mail".to_string()
        } else {
            "Only attended bookings can receive a rating email".to_string()
        }));
    }
    let ends_over: bool = row
        .try_get::<chrono::DateTime<chrono::Utc>>("", "ends_at")
        .map(|dt| dt < chrono::Utc::now())
        .unwrap_or(false);
    if !ends_over {
        return Err(RatingEmailError::NotEligible(if hu {
            "A látogatás még nem ért véget".to_string()
        } else {
            "The visit has not ended yet".to_string()
        }));
    }
    let email: String = opt_str(&row, "email").unwrap_or_default();
    if email.trim().is_empty() {
        return Err(RatingEmailError::NotEligible(if hu {
            "A foglaláshoz nincs megadva e-mail cím".to_string()
        } else {
            "Booking has no email address".to_string()
        }));
    }
    let already: bool = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT 1 AS one FROM reservation_ratings
              WHERE booking_id = $1
                 OR (reservation_id = (SELECT reservation_id FROM reservation_bookings WHERE id = $1)
                     AND lower(email) = lower($2))
              LIMIT 1",
            vec![booking_id.into(), email.clone().into()],
        ))
        .await
        .map_err(|e| RatingEmailError::Failed(format!("lookup failed: {e:?}")))?
        .is_some();
    if already {
        return Err(RatingEmailError::AlreadyRated(if hu {
            "Ez a vendég már küldött értékelést".to_string()
        } else {
            "This guest has already submitted a rating".to_string()
        }));
    }

    let starts_at = opt_datetime(&row, "starts_at");
    let ends_at = opt_datetime(&row, "ends_at");
    let project_name = opt_str(&row, "project_name");
    let rating_url = build_rating_url(
        opt_str(&row, "secret_token").as_deref(),
        opt_str(&row, "booking_token").as_deref(),
    );
    let rendered = crate::mailers::templates::render_rating_request(
        crate::mailers::templates::RatingRequestParams {
            project_name: project_name.as_deref(),
            domain_address: opt_str(&row, "domain_address").as_deref(),
            customer_email: opt_str(&row, "customer_email").as_deref(),
            customer_first_name: opt_str(&row, "first_name").as_deref(),
            starts_at: starts_at.as_deref(),
            ends_at: ends_at.as_deref(),
            booking_id: Some(booking_id),
            service_name: opt_str(&row, "service_name_snapshot").as_deref(),
            worker_name: None,
            locale: opt_str(&row, "locale").as_deref(),
            timezone: opt_str(&row, "timezone").as_deref(),
            signer_name: None,
            rating_url: rating_url.as_deref(),
        },
    );
    crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
        to: email.clone(),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        from_name: project_name,
        from_address: None,
    });
    // Mark as sent — the worker ignores stamped bookings, so a manual
    // send is never duplicated automatically.
    db.execute_raw(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE reservation_bookings SET rating_sent_at = now() WHERE id = $1",
        vec![booking_id.into()],
    ))
    .await
    .map_err(|e| RatingEmailError::Failed(format!("stamp failed: {e:?}")))?;
    crate::push::log_entity_activity(
        db,
        "system",
        None,
        None,
        None,
        None,
        "SEND",
        "SEND -",
        "rating.send",
        "SEND",
        Some("booking"),
        Some(booking_id),
        None,
        row.try_get::<i64>("", "project_id").ok(),
        200,
        serde_json::json!({
            "ratingUrl": rating_url,
            "email": email,
        }),
    )
    .await;
    Ok(())
}

fn opt_str(row: &sea_orm::QueryResult, col: &str) -> Option<String> {
    row.try_get::<Option<String>>("", col).ok().flatten()
}

fn opt_datetime(row: &sea_orm::QueryResult, col: &str) -> Option<String> {
    if let Ok(dt) = row.try_get::<chrono::DateTime<chrono::Utc>>("", col) {
        return Some(dt.to_rfc3339());
    }
    if let Ok(dt) = row.try_get::<chrono::NaiveDateTime>("", col) {
        return Some(dt.and_utc().to_rfc3339());
    }
    row.try_get::<Option<String>>("", col).ok().flatten()
}

fn build_rating_url(secret_token: Option<&str>, booking_token: Option<&str>) -> Option<String> {
    let app_url = std::env::var("APP_PUBLIC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    match (secret_token, booking_token, app_url.is_empty()) {
        (Some(secret), Some(token), false) if !secret.is_empty() && !token.is_empty() => {
            Some(format!("{app_url}/embed/reservations/{secret}/rate/{token}"))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// spawn — wired from boot (same pattern as reminders)
// ---------------------------------------------------------------------------

/// Start the rating loop. Run immediately on startup, then every
/// `RATING_POLL_INTERVAL_SECS` seconds (default 60).
/// No-op when DISABLE_RATINGS=true.
pub fn spawn(db: DatabaseConnection) {
    if std::env::var("DISABLE_RATINGS").as_deref() == Ok("true") {
        tracing::info!("[ratings] disabled by DISABLE_RATINGS=true");
        return;
    }
    let interval = poll_interval_secs();
    tokio::spawn(async move {
        // Run immediately on startup, then every interval.
        run_once(&db).await;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
            run_once(&db).await;
        }
    });
    tracing::info!("[ratings] started (every {interval}s)");
}
