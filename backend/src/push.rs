//! Central push fan-out: every notification type that pairs an in-app row
//! with a browser push goes through [`create_notification`], which INSERTs
//! the row and then pushes from this one place with byte-identical payloads
//! and gates. Unknown types only create the in-app row.
//!
//! [`send_push_to_user`] sends a `{title, body, url}` JSON payload to every
//! device registered to a user, purging dead endpoints (410/404) and never
//! failing its callers (best-effort).

use sea_orm::{ConnectionTrait, DatabaseConnection, DatabaseBackend, Statement};
use serde_json::json;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

/// VAPID subject (`mailto:` contact) for outgoing browser pushes.
pub const VAPID_SUBJECT: &str = "mailto:info@zsoltberta.hu";

/// Push-message TTL (4 weeks), matching the node-web-push default.
const PUSH_TTL_SECS: u32 = 2_419_200;

// ---------------------------------------------------------------------------
// send_push_to_user(userId, payload, audit)
// ---------------------------------------------------------------------------

/// Send a push notification to all devices registered to a user.
///
/// Silently no-ops when VAPID keys are not configured. Purges expired
/// subscriptions (410/404) automatically. Best-effort: never fails callers —
/// every failure is logged and swallowed.
pub async fn send_push_to_user(
    db: &DatabaseConnection,
    user_id: i64,
    title: &str,
    body: &str,
    url: &str,
) {
    let vapid_public = std::env::var("VAPID_PUBLIC_KEY").unwrap_or_default();
    let vapid_private = std::env::var("VAPID_PRIVATE_KEY").unwrap_or_default();
    if vapid_public.is_empty() || vapid_private.is_empty() {
        return;
    }

    let rows = match db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = $1",
            vec![user_id.into()],
        ))
        .await
    {
        Ok(rows) => rows,
        Err(e) => {
            tracing::error!("[push] subscription lookup failed: {e:?}");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }

    // VAPID_PRIVATE_KEY holds the raw base64url-no-pad private key (the same
    // string node-web-push consumes), so from_base64 maps directly onto
    // setVapidDetails. Build once, clone per endpoint for the aud claim.
    let partial = match VapidSignatureBuilder::from_base64_no_sub(&vapid_private) {
        Ok(b) => b,
        Err(e) => {
            tracing::error!("[push] invalid VAPID_PRIVATE_KEY: {e}");
            return;
        }
    };
    let client = match IsahcWebPushClient::new() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("[push] web-push client init failed: {e}");
            return;
        }
    };
    let payload =
        serde_json::to_vec(&json!({ "title": title, "body": body, "url": url }))
            .unwrap_or_default();

    // ok=false only when NO device received the push. 410/404 purges are
    // housekeeping on a dead endpoint, counted as delivered, not failed.
    let devices = rows.len();
    let mut delivered: usize = 0;
    for row in &rows {
        let endpoint: String = match row.try_get("", "endpoint") {
            Ok(e) => e,
            Err(_) => continue,
        };
        let p256dh: String = row.try_get("", "keys_p256dh").unwrap_or_default();
        let auth: String = row.try_get("", "keys_auth").unwrap_or_default();
        if p256dh.is_empty() || auth.is_empty() {
            continue;
        }
        let sub_info = SubscriptionInfo::new(endpoint.as_str(), p256dh.as_str(), auth.as_str());
        let mut sig_builder = partial.clone().add_sub_info(&sub_info);
        sig_builder.add_claim("sub", VAPID_SUBJECT);
        let signature = match sig_builder.build() {
            Ok(s) => s,
            Err(e) => {
                tracing::error!("[push] vapid signature failed: {e}");
                continue;
            }
        };
        let mut builder = WebPushMessageBuilder::new(&sub_info);
        builder.set_payload(ContentEncoding::Aes128Gcm, &payload);
        builder.set_vapid_signature(signature);
        builder.set_ttl(PUSH_TTL_SECS);
        let message = match builder.build() {
            Ok(m) => m,
            Err(e) => {
                tracing::error!("[push] message build failed: {e}");
                continue;
            }
        };
        match client.send(message).await {
            Ok(()) => delivered += 1,
            // Expired or revoked subscription — the endpoint is dead for every
            // account sharing this browser, so purge all rows for it.
            Err(WebPushError::EndpointNotFound(_))
            | Err(WebPushError::EndpointNotValid(_)) => {
                let _ = db
                    .execute_raw(Statement::from_sql_and_values(
                        DatabaseBackend::Postgres,
                        "DELETE FROM push_subscriptions WHERE endpoint = $1",
                        vec![endpoint.into()],
                    ))
                    .await;
                delivered += 1;
            }
            Err(e) => tracing::error!("[push] send error: {e}"),
        }
    }

    // One SEND row per delivery fan-out (mirrors logActivity push.send).
    log_activity(
        db,
        "push.send",
        None,
        None,
        if delivered > 0 { 201 } else { 500 },
        delivered > 0,
        json!({
            "userId": user_id,
            "title": title,
            "devices": devices,
            "delivered": delivered,
        }),
    )
    .await;
}

// ---------------------------------------------------------------------------
// create_notification({...})
// ---------------------------------------------------------------------------

/// Create an in-app notification row for a user, with central push fan-out.
///
/// `metadata` is stored as the row's jsonb sidecar and also drives
/// [`build_push_payload`]. Push is best-effort and never fails the in-app
/// notification.
#[allow(clippy::too_many_arguments)]
pub async fn create_notification(
    db: &DatabaseConnection,
    user_id: i64,
    type_: &str,
    title: &str,
    message: &str,
    entity_type: Option<&str>,
    entity_id: Option<i32>,
    metadata: serde_json::Value,
) {
    let notif_type = if type_.is_empty() { "SYSTEM" } else { type_ };
    // Same convention as controllers/settings.rs: bind JSON as text + ::jsonb.
    let meta_text =
        serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string());
    if let Err(e) = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO notifications (user_id, type, title, message, entity_type, entity_id, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)",
            vec![
                user_id.into(),
                notif_type.into(),
                title.into(),
                message.into(),
                entity_type.map(|s| s.to_string()).into(),
                entity_id.into(),
                meta_text.into(),
            ],
        ))
        .await
    {
        tracing::error!("[notifications] insert failed: {e:?}");
        return;
    }
    // Push fan-out is best-effort and must never fail the in-app row.
    match build_push_payload(db, notif_type, title, message, &metadata).await {
        Some(p) => {
            send_push_to_user(db, user_id, &p.title, &p.body, &p.url).await;
        }
        None => {
            // Unknown / gated-out types: in-app row only (same as before).
            // build_push_payload already logs unexpected failures.
        }
    }
    log_activity(
        db,
        "notification.create",
        entity_type,
        entity_id,
        201,
        true,
        json!({ "type": notif_type, "title": title, "userId": user_id }),
    )
    .await;
}

// ---------------------------------------------------------------------------
// build_push_payload (push payload builder)
// ---------------------------------------------------------------------------

/// Browser-push payload for a freshly stored notification, or `None` for
/// in-app-row-only types. Shapes and texts match the per-call-site
/// `sendPushToUser` calls byte-for-byte.
pub struct PushPayload {
    pub title: String,
    pub body: String,
    pub url: String,
}

async fn build_push_payload(
    db: &DatabaseConnection,
    type_: &str,
    title: &str,
    message: &str,
    metadata: &serde_json::Value,
) -> Option<PushPayload> {
    if type_ == "BOOKING_CREATED" || type_ == "BOOKING_CANCELLED" {
        if !worker_push_enabled(db).await {
            return None;
        }
        let locale = metadata
            .get("locale")
            .and_then(|v| v.as_str())
            .unwrap_or("hu");
        let timezone = metadata
            .get("timezone")
            .and_then(|v| v.as_str())
            .unwrap_or("UTC");
        let starts_at = metadata
            .get("startsAt")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let customer_name = metadata
            .get("customerName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let service_name = metadata
            .get("serviceName")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let date = format_date(starts_at, locale, timezone);
        if type_ == "BOOKING_CREATED" {
            return Some(PushPayload {
                title: t(locale, "push_title", &[("customerName", customer_name)]),
                body: t(locale, "push_body", &[("serviceName", service_name), ("date", &date)]),
                url: "/".to_string(),
            });
        }
        return Some(PushPayload {
            title: t(
                locale,
                "push_cancelled_title",
                &[("customerName", customer_name)],
            ),
            body: t(
                locale,
                "push_cancelled_body",
                &[("serviceName", service_name), ("date", &date)],
            ),
            url: "/".to_string(),
        });
    }
    if type_ == "GATEWAY_PAYMENT_PAID"
        || type_ == "GATEWAY_PAYMENT_FAILED"
        || type_ == "GATEWAY_PAYMENT_REFUNDED"
    {
        if !worker_push_enabled(db).await {
            return None;
        }
        return Some(PushPayload {
            title: title.to_string(),
            body: message.to_string(),
            url: "/gateway".to_string(),
        });
    }
    None
}

/// Global worker-push gate (Settings → worker push notifications).
/// Missing/unreadable setting counts as enabled (mirrors push.js).
async fn worker_push_enabled(db: &DatabaseConnection) -> bool {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT value FROM system_settings WHERE key = 'worker_push_notifications'",
            vec![],
        ))
        .await
        .ok()
        .flatten();
    match row {
        None => true,
        Some(r) => match r.try_get::<serde_json::Value>("", "value") {
            Ok(serde_json::Value::Bool(false)) => false,
            _ => true,
        },
    }
}

// ---------------------------------------------------------------------------
// notifications-i18n — push strings + t()/formatDate
// ---------------------------------------------------------------------------

fn resolve_locale(locale: &str) -> &str {
    if locale == "en" {
        "en"
    } else {
        "hu"
    }
}

fn lookup<'a>(lang: &str, key: &'a str) -> &'a str {
    match (lang, key) {
        ("hu", "new_booking") => "Új foglalás",
        ("hu", "booking_message") => "{customerName} foglalt: {serviceName} — {date}",
        ("hu", "push_title") => "Új foglalás — {customerName}",
        ("hu", "push_body") => "{serviceName} — {date}",
        ("hu", "booking_cancelled") => "Foglalás lemondva",
        ("hu", "booking_cancelled_message") => "{customerName} lemondta: {serviceName} — {date}",
        ("hu", "push_cancelled_title") => "Lemondás — {customerName}",
        ("hu", "push_cancelled_body") => "{serviceName} — {date}",
        ("en", "new_booking") => "New Booking",
        ("en", "booking_message") => "{customerName} booked {serviceName} — {date}",
        ("en", "push_title") => "New Booking — {customerName}",
        ("en", "push_body") => "{serviceName} — {date}",
        ("en", "booking_cancelled") => "Booking Cancelled",
        ("en", "booking_cancelled_message") => "{customerName} cancelled {serviceName} — {date}",
        ("en", "push_cancelled_title") => "Cancelled — {customerName}",
        ("en", "push_cancelled_body") => "{serviceName} — {date}",
        // Fallback to Hungarian (mirrors `translations.hu[key] || key`).
        (_, "new_booking") => "Új foglalás",
        (_, "booking_message") => "{customerName} foglalt: {serviceName} — {date}",
        (_, "push_title") => "Új foglalás — {customerName}",
        (_, "push_body") => "{serviceName} — {date}",
        (_, "booking_cancelled") => "Foglalás lemondva",
        (_, "booking_cancelled_message") => "{customerName} lemondta: {serviceName} — {date}",
        (_, "push_cancelled_title") => "Lemondás — {customerName}",
        (_, "push_cancelled_body") => "{serviceName} — {date}",
        _ => key,
    }
}

/// Port of `t(locale, key, vars)` from notifications-i18n.js.
pub fn t(locale: &str, key: &str, vars: &[(&str, &str)]) -> String {
    let lang = resolve_locale(locale);
    let mut text = lookup(lang, key).to_string();
    for (k, v) in vars {
        text = text.replace(&format!("{{{k}}}"), v);
    }
    text
}

const HU_MONTHS: [&str; 12] = [
    "január", "február", "március", "április", "május", "június", "július", "augusztus",
    "szeptember", "október", "november", "december",
];
const EN_MONTHS: [&str; 12] = [
    "January", "February", "March", "April", "May", "June", "July", "August", "September",
    "October", "November", "December",
];

/// Port of `formatDate(isoDate, locale, timezone)` from notifications-i18n.js.
///
/// Converts the instant to the target timezone using the same hand-rolled
/// EU DST rules as the reservation engine
/// (`crate::controllers::reservations`), so push bodies agree with the
/// e-mail templates to the minute.
pub fn format_date(iso: &str, locale: &str, timezone: &str) -> String {
    if iso.is_empty() {
        return String::new();
    }
    let dt = chrono::DateTime::parse_from_rfc3339(iso)
        .ok()
        .or_else(|| {
            chrono::DateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S%.f %#z").ok()
        })
        .or_else(|| {
            chrono::DateTime::parse_from_str(iso, "%Y-%m-%d %H:%M:%S%.f %:z").ok()
        })
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f")
                .ok()
                .map(|n| n.and_utc().fixed_offset())
        });
    let dt = match dt {
        Some(d) => d,
        None => return String::new(),
    };
    let tz = if timezone.is_empty() { "UTC" } else { timezone };
    let utc_ms = dt.timestamp_millis();
    let (year, month, day) =
        crate::controllers::reservations::fmt_date_in_tz(utc_ms, tz);
    let hm = crate::controllers::reservations::fmt_time_in_tz(utc_ms, tz);
    let month_idx = (month as usize).saturating_sub(1).min(11);
    if resolve_locale(locale) == "en" {
        format!("{day} {} {year}, {hm}", EN_MONTHS[month_idx])
    } else {
        format!("{year}. {} {day}. {hm}", HU_MONTHS[month_idx])
    }
}

// ---------------------------------------------------------------------------
// Activity-log rows (mirrors logActivity push.send / notification.create)
// ---------------------------------------------------------------------------

/// Best-effort activity_logs INSERT mirroring logActivity() for the SEND-path
/// rows push.js emits. Never fails the caller — errors are logged and dropped.
async fn log_activity(
    db: &DatabaseConnection,
    action: &str,
    entity_type: Option<&str>,
    entity_id: Option<i32>,
    status_code: i32,
    ok: bool,
    metadata: serde_json::Value,
) {
    let meta_text = serde_json::to_string(&metadata).unwrap_or_else(|_| "{}".to_string());
    let res = db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO activity_logs
               (actor_type, actor_user_id, actor_email, actor_role, actor_ip,
                method, path, action, action_type,
                entity_type, entity_id, entity_label, project_id,
                status_code, ok, metadata)
             VALUES ('system', NULL, NULL, NULL, NULL,
                     'SEND', 'SEND -', $1, 'SEND',
                     $2, $3, NULL, NULL,
                     $4, $5, $6::jsonb)",
            vec![
                action.into(),
                entity_type.map(|s| s.to_string()).into(),
                entity_id.into(),
                status_code.into(),
                ok.into(),
                meta_text.into(),
            ],
        ))
        .await;
    if let Err(e) = res {
        tracing::error!("[push] activity log insert failed: {e:?}");
    }
}
