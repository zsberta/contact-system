//! Port of old_backend/lib/reservation-reminders.js.
//!
//! Background scheduler that sends reminder emails X hours before each
//! booking starts. Uses the reminder_sent_at NULL-claim for idempotent,
//! single-flight send: a row is only picked up while reminder_sent_at IS
//! NULL, and is stamped after the send is queued.
//!
//! Cadence mirrors the old in-process setInterval wiring: run immediately on
//! startup, then every 60 seconds. Env guard DISABLE_REMINDERS=true skips
//! startup.

use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseBackend, Statement};

const BATCH_SIZE: i64 = 100;
const POLL_INTERVAL_SECS: u64 = 60;

// ---------------------------------------------------------------------------
// run_once — query due bookings, claim, and send reminder emails
// ---------------------------------------------------------------------------

/// One reminder tick. Returns the number of reminders sent. Best-effort:
/// per-booking failures are logged and retried on the next tick (their
/// reminder_sent_at stays NULL); a failed lookup returns 0.
pub async fn run_once(db: &DatabaseConnection) -> usize {
    // Same SQL as runReminders: confirmed bookings whose reminder window
    // opened (starts within reminder_hours_before) but hasn't started yet,
    // and whose reminder hasn't been sent.
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
                    r.reminder_hours_before,
                    p.name AS project_name,
                    p.domain_address,
                    p.customer_email
             FROM reservation_bookings b
             JOIN reservations r ON r.id = b.reservation_id
             JOIN projects p ON p.id = r.project_id
             WHERE b.reminder_sent_at IS NULL
               AND b.status = 'confirmed'
               AND r.reminder_hours_before IS NOT NULL
               AND r.reminder_hours_before > 0
               AND b.starts_at > now()
               AND b.starts_at <= now() + (r.reminder_hours_before || ' hours')::interval
             ORDER BY b.starts_at
             LIMIT $1",
            vec![BATCH_SIZE.into()],
        ))
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[reminders] due-bookings lookup failed: {e:?}");
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
                    "UPDATE reservation_bookings SET reminder_sent_at = now() WHERE id = $1",
                    vec![booking_id.into()],
                ))
                .await;
            continue;
        }

        let outcome: Result<(), String> = async {
            let starts_at = opt_datetime(row, "starts_at");
            let ends_at = opt_datetime(row, "ends_at");
            let project_name = opt_str(row, "project_name");
            let rendered = crate::mailers::templates::render_booking_reminder(
                crate::mailers::templates::BookingReminderParams {
                    project_name: project_name.as_deref(),
                    domain_address: opt_str(row, "domain_address").as_deref(),
                    customer_email: opt_str(row, "customer_email").as_deref(),
                    starts_at: starts_at.as_deref(),
                    ends_at: ends_at.as_deref(),
                    booking_id: Some(booking_id),
                    service_name: opt_str(row, "service_name_snapshot").as_deref(),
                    worker_name: None,
                    locale: opt_str(row, "locale").as_deref(),
                    timezone: opt_str(row, "timezone").as_deref(),
                    signer_name: None,
                    booking_token: opt_str(row, "booking_token").as_deref(),
                    embed_base_url: build_embed_base_url(
                        opt_str(row, "secret_token").as_deref(),
                    )
                    .as_deref(),
                    hours_before: row
                        .try_get::<i32>("", "reminder_hours_before")
                        .or_else(|_| {
                            row.try_get::<i64>("", "reminder_hours_before")
                                .map(|v| v as i32)
                        })
                        .unwrap_or(0) as i64,
                },
            );
            crate::mailers::email::enqueue_mail(crate::mailers::email::EmailJob {
                to: email,
                subject: rendered.subject,
                text: rendered.text,
                html: rendered.html,
                from_name: project_name,
                from_address: None,
            });
            // Mark as sent — prevents duplicate sends on next tick. Set
            // eagerly (same as the old code): delivery from here is
            // best-effort and a retry loop would be worse than a single
            // missed reminder.
            db.execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "UPDATE reservation_bookings SET reminder_sent_at = now() WHERE id = $1",
                vec![booking_id.into()],
            ))
            .await
            .map_err(|e| format!("stamp failed: {e:?}"))?;
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => sent += 1,
            Err(detail) => {
                // Leave reminder_sent_at NULL so the next tick retries.
                tracing::error!("[reminder] failed booking={booking_id}: {detail}");
            }
        }
    }
    sent
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

fn build_embed_base_url(secret_token: Option<&str>) -> Option<String> {
    let app_url = std::env::var("APP_PUBLIC_URL")
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_string();
    match (secret_token, app_url.is_empty()) {
        (Some(token), false) if !token.is_empty() => {
            Some(format!("{app_url}/embed/reservations/{token}"))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// spawn — wired from boot (same pattern as startReminders)
// ---------------------------------------------------------------------------

/// Start the 60s reminder loop. Run immediately on startup, then every 60
/// seconds. No-op when DISABLE_REMINDERS=true.
pub fn spawn(db: DatabaseConnection) {
    if std::env::var("DISABLE_REMINDERS").as_deref() == Ok("true") {
        tracing::info!("[reminders] disabled by DISABLE_REMINDERS=true");
        return;
    }
    tokio::spawn(async move {
        // Run immediately on startup, then every 60 seconds.
        run_once(&db).await;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(POLL_INTERVAL_SECS)).await;
            run_once(&db).await;
        }
    });
    tracing::info!("[reminders] started (every 60s)");
}

// ---------------------------------------------------------------------------
// Local booking-reminder renderer.
// ---------------------------------------------------------------------------
//
// TODO(mail crew): swap `BookingReminderInput` / `render_booking_reminder` /
// `RenderedMail` with `crate::mailers::templates::render_booking_reminder`
// once the mail crew lands it. The input fields below mirror the
// `renderBookingReminder({...})` arguments in
// old_backend/lib/email-templates.js one-for-one (workerName/signerName are
// not selected by the reminder query, so they are absent here), and the
// output `{ subject, html, text }` shape is identical — the swap is a
// drop-in rename at the `render_booking_reminder(&input)` call site above.

/// Compatible input for the (future) shared `render_booking_reminder`.
pub struct BookingReminderInput {
    pub project_name: Option<String>,
    pub domain_address: Option<String>,
    pub customer_email: Option<String>,
    pub starts_at: Option<String>,
    pub ends_at: Option<String>,
    pub booking_id: i64,
    pub service_name: Option<String>,
    pub locale: String,
    pub timezone: String,
    pub booking_token: Option<String>,
    pub embed_base_url: Option<String>,
    pub hours_before: i32,
}

/// Compatible output for the (future) shared `render_booking_reminder`.
pub struct RenderedMail {
    pub subject: String,
    pub html: String,
    pub text: String,
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Local stand-in renderer (see the TODO above). Mirrors the wording and
/// structure of `renderBookingReminder` in old_backend/lib/email-templates.js
/// (reminder intro with hoursBefore, service/date/id detail rows,
/// modify/cancel manage links, no-reply hint, sign-off).
pub fn render_booking_reminder(input: &BookingReminderInput) -> RenderedMail {
    let hu = input.locale != "en";
    let reminder = if hu { "Emlékeztető" } else { "Reminder" };
    let intro = if hu {
        format!(
            "Ez egy emlékeztető, hogy a foglalásod {} órán belül kezdődik.",
            input.hours_before
        )
    } else {
        format!(
            "This is a reminder that your booking starts in {} hours.",
            input.hours_before
        )
    };
    let (id_label, service_label, date_label) = if hu {
        ("Foglalás azonosító", "Szolgáltatás", "Időpont")
    } else {
        ("Booking ID", "Service", "Date & time")
    };
    let start_display = input
        .starts_at
        .as_deref()
        .map(|s| crate::push::format_date(s, &input.locale, &input.timezone))
        .unwrap_or_default();
    let end_display = input
        .ends_at
        .as_deref()
        .map(|s| crate::push::format_date(s, &input.locale, &input.timezone))
        .unwrap_or_default();
    let date_range = match (start_display.is_empty(), end_display.is_empty()) {
        (true, _) => String::new(),
        (false, true) => start_display.clone(),
        (false, false) => format!("{start_display} – {end_display}"),
    };
    let service_display = input.service_name.clone().unwrap_or_default();
    let subject = if service_display.is_empty() {
        if hu {
            "Foglalási emlékeztető".to_string()
        } else {
            "Booking reminder".to_string()
        }
    } else if start_display.is_empty() {
        format!("{service_display} - {reminder}")
    } else {
        format!("{service_display} - {start_display} - {reminder}")
    };

    let manage_url = match (&input.embed_base_url, &input.booking_token) {
        (Some(base), Some(token)) if !token.is_empty() => {
            Some(format!("{}/manage/{token}", base.trim_end_matches('/')))
        }
        _ => None,
    };
    let from_name = input.project_name.clone().unwrap_or_else(|| {
        if hu {
            "a csapat".to_string()
        } else {
            "the team".to_string()
        }
    });
    let write_to = input
        .customer_email
        .clone()
        .unwrap_or_else(|| "info@zsoltberta.hu".to_string());
    let (reply_hint, sign_off, modify_label, cancel_label) = if hu {
        (
            format!(
                "<strong>Erre az e-mailre ne válaszolj.</strong> Ha bármit módosítanod kell, írj nekünk közvetlenül ide: <a href=\"mailto:{w}\">{w}</a>.",
                w = esc(&write_to)
            ),
            "Üdvözlettel,",
            "Módosítás",
            "Lemondás",
        )
    } else {
        (
            format!(
                "<strong>Please do not reply to this email.</strong> If you need to change anything, write to us directly at <a href=\"mailto:{w}\">{w}</a>.",
                w = esc(&write_to)
            ),
            "Best regards,",
            "Modify booking",
            "Cancel booking",
        )
    };
    let mut detail_rows = String::new();
    if !service_display.is_empty() {
        detail_rows.push_str(&format!(
            "<tr><td>{service_label}:</td><td><strong>{}</strong></td></tr>",
            esc(&service_display)
        ));
    }
    if !date_range.is_empty() {
        detail_rows.push_str(&format!(
            "<tr><td>{date_label}:</td><td><strong>{}</strong></td></tr>",
            esc(&date_range)
        ));
    }
    detail_rows.push_str(&format!(
        "<tr><td>{id_label}:</td><td><strong>#{}</strong></td></tr>",
        input.booking_id
    ));
    let manage_html = manage_url
        .as_deref()
        .map(|u| {
            format!(
                "<p><a href=\"{u}\">{modify_label}</a> · <a href=\"{u}\">{cancel_label}</a></p>"
            )
        })
        .unwrap_or_default();
    let html = format!(
        "<h1>{}</h1><p>{}</p><table>{}</table>{}<p>{}</p><p>{}<br><strong>{}</strong></p>",
        esc(reminder),
        esc(&intro),
        detail_rows,
        manage_html,
        reply_hint,
        esc(sign_off),
        esc(&from_name),
    );
    let detail_text = [
        (!service_display.is_empty())
            .then(|| format!("{service_label}: {service_display}")),
        (!date_range.is_empty()).then(|| format!("{date_label}: {date_range}")),
        Some(format!("{id_label}: #{}", input.booking_id)),
        manage_url.map(|u| {
            if hu {
                format!("Módosítás/lemondás: {u}")
            } else {
                format!("Modify/cancel: {u}")
            }
        }),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n");
    let text = format!("{reminder}\n{intro}\n{detail_text}\n\n{sign_off}\n{from_name}");
    RenderedMail {
        subject,
        html,
        text,
    }
}
