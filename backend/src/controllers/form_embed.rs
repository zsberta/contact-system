//! Public form-embed endpoints.
//!
//! Public, NO auth (capability is the 22-char secret_token in the path).
//!   GET  /api/public/forms/:secret_token          — public form config
//!   POST /api/public/forms/:secret_token/submissions — validate + store
//!
//! Notes:
//! - Per-IP burst/sustained rate limiting is left to the global middleware
//!   (generous in-handler limiting is out of scope).
//! - Confirmation e-mails go through the paced queue (`enqueue_mail`,
//!   best-effort, never fails the request): the operator notification
//!   uses renderSubmissionNotification (always HU) and the submitter
//!   auto-reply uses renderSubmissionAutoReply + detectSubmitterEmail.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

const DATA_MAX_KEYS_PER_LEVEL: usize = 50;
const DATA_MAX_DEPTH: usize = 5;
const DATA_MAX_BYTES: usize = 50 * 1024;
const LOCALE_MAX_LEN: usize = 10;

fn measure_bag(v: &serde_json::Value, depth: usize, acc: &mut (usize, usize)) {
    if let Some(map) = v.as_object() {
        if map.len() > acc.0 {
            acc.0 = map.len();
        }
        if depth > acc.1 {
            acc.1 = depth;
        }
        if depth >= DATA_MAX_DEPTH {
            return;
        }
        for (_, child) in map {
            if child.is_object() {
                measure_bag(child, depth + 1, acc);
            }
        }
    }
}

/// Same wildcard/exact origin semantics as the FE origin-allowlist.
fn is_origin_allowed(request_origin: &str, allowed: &[String]) -> bool {
    if request_origin.is_empty() {
        return false;
    }
    let host_of = |s: &str| -> String {
        let lower = s.trim().trim_end_matches('/').to_lowercase();
        let no_scheme = lower
            .strip_prefix("http://")
            .or_else(|| lower.strip_prefix("https://"))
            .unwrap_or(&lower);
        no_scheme
            .split('/')
            .next()
            .unwrap_or("")
            .to_string()
    };
    let req_host = host_of(request_origin);
    if req_host.is_empty() {
        return false;
    }
    for entry in allowed {
        let e = entry.trim().trim_end_matches('/').to_lowercase();
        if e.is_empty() {
            continue;
        }
        let entry_host = host_of(&e);
        if entry_host == req_host {
            return true;
        }
        if let Some(star) = e.find("*.") {
            let suffix = e[star + 2..]
                .trim_start_matches("http://")
                .trim_start_matches("https://");
            let suffix_host = suffix.split(':').next().unwrap_or(suffix);
            let req_bare = req_host.split(':').next().unwrap_or(&req_host);
            if *req_bare == *suffix_host {
                continue; // apex — wildcard does NOT match
            }
            if req_bare.len() > suffix_host.len()
                && req_bare.ends_with(&format!(".{suffix_host}"))
            {
                return true;
            }
        }
    }
    false
}

fn allowed_of(row: &sea_orm::QueryResult) -> Vec<String> {
    row.try_get::<Option<Vec<String>>>("", "allowed_origins")
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Fire-and-forget operator notification + submitter auto-reply: the
/// `notifyProjectOwner` + `notifySubmitter` pair (same templates, same
/// subjects/kinds) — the operator mail is always Hungarian with a
/// `Nexus` From; the auto-reply is project-branded.
async fn send_form_emails(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
    form_name: &str,
    data: &serde_json::Value,
    locale: Option<&str>,
) {
    use crate::mailers::{
        email::{EmailJob, enqueue_mail},
        templates::{
            SubmissionAutoReplyParams, SubmissionNotificationParams, detect_submitter_email,
            render_submission_auto_reply, render_submission_notification,
        },
    };
    let proj = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT name, domain_address, customer_email FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
        .ok()
        .flatten();
    let project_name: String = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "name").ok().flatten())
        .unwrap_or_default();
    let domain_address: Option<String> = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "domain_address").ok().flatten());
    let customer_email: Option<String> = proj
        .as_ref()
        .and_then(|r| r.try_get::<Option<String>>("", "customer_email").ok().flatten());

    // Operator notification (always Hungarian).
    if let Some(to) = customer_email.clone().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        let rendered = render_submission_notification(SubmissionNotificationParams {
            project_name: &project_name,
            form_name,
            data: Some(data),
            locale: Some("hu"),
            kind: "form",
            starts_at: None,
            ends_at: None,
        });
        enqueue_mail(EmailJob {
            to,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from_name: Some("Nexus".to_string()),
            from_address: None,
        });
    }

    // Submitter auto-reply (project-branded From).
    if let Some(submitter) = detect_submitter_email(data) {
        let rendered = render_submission_auto_reply(SubmissionAutoReplyParams {
            form_name: Some(form_name),
            project_name: if project_name.is_empty() { None } else { Some(&project_name) },
            domain_address: domain_address.as_deref(),
            customer_email: customer_email.as_deref(),
            locale,
        });
        enqueue_mail(EmailJob {
            to: submitter,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            from_name: if project_name.is_empty() {
                None
            } else {
                Some(project_name.clone())
            },
            from_address: None,
        });
    }
}

// ---------------------------------------------------------------------------
// GET /api/public/forms/:secret_token — public form config (no auth)
// ---------------------------------------------------------------------------

async fn get_config(
    State(ctx): State<AppContext>,
    Path(secret_token): Path<String>,
) -> Response {
    if secret_token.len() != 22 {
        return err(StatusCode::NOT_FOUND, "Form not found");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, name, slug, status, allowed_origins
                 FROM forms WHERE trim(secret_token) = $1",
                vec![secret_token.into()],
            ))
            .await?;
        match row {
            None => Ok(err(StatusCode::NOT_FOUND, "Form not found")),
            Some(r) => {
                let status: Option<String> = r.try_get("", "status").ok().flatten();
                if status.as_deref() != Some("active") {
                    return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
                }
                Ok((
                    StatusCode::OK,
                    Json(json!({
                        "name": r.try_get::<Option<String>>("", "name").ok().flatten().unwrap_or_default(),
                        "slug": r.try_get::<Option<String>>("", "slug").ok().flatten().unwrap_or_default(),
                        "allowedOrigins": allowed_of(&r),
                    })),
                )
                    .into_response())
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[form-embed/config] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

// ---------------------------------------------------------------------------
// POST /api/public/forms/:secret_token/submissions (no auth)
// ---------------------------------------------------------------------------

async fn submit(
    State(ctx): State<AppContext>,
    Path(secret_token): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if secret_token.len() != 22 {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    let parsed: serde_json::Value = if body.trim().is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
        }
    };
    let data = parsed.get("data").cloned().unwrap_or(serde_json::Value::Null);
    if !data.is_object() {
        return err(StatusCode::BAD_REQUEST, "data must be an object");
    }
    let mut m = (0usize, 1usize);
    measure_bag(&data, 1, &mut m);
    if m.1 > DATA_MAX_DEPTH {
        return err(
            StatusCode::BAD_REQUEST,
            &format!("data exceeds max depth {DATA_MAX_DEPTH}"),
        );
    }
    if m.0 > DATA_MAX_KEYS_PER_LEVEL {
        return err(
            StatusCode::BAD_REQUEST,
            &format!("data exceeds max {DATA_MAX_KEYS_PER_LEVEL} keys per level"),
        );
    }
    let data_json = match serde_json::to_string(&data) {
        Ok(s) => s,
        Err(_) => return err(StatusCode::BAD_REQUEST, "data is not serialisable"),
    };
    if data_json.len() > DATA_MAX_BYTES {
        return err(
            StatusCode::BAD_REQUEST,
            &format!("data exceeds max {DATA_MAX_BYTES} bytes"),
        );
    }
    let mut locale: Option<String> = None;
    if let Some(l) = parsed.get("locale").and_then(|v| v.as_str()) {
        if !l.is_empty() {
            if l.len() > LOCALE_MAX_LEN {
                return err(
                    StatusCode::BAD_REQUEST,
                    &format!("locale must be ≤ {LOCALE_MAX_LEN} chars"),
                );
            }
            locale = Some(l.to_string());
        }
    }

    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, name, status, allowed_origins
                 FROM forms WHERE trim(secret_token) = $1",
                vec![secret_token.into()],
            ))
            .await?;
        let Some(r) = row else {
            return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
        };
        let status: Option<String> = r.try_get("", "status").ok().flatten();
        if status.as_deref() != Some("active") {
            return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
        }
        let form_id: i64 = r.try_get("", "id")?;
        let project_id: i64 = r.try_get("", "project_id").unwrap_or(0);
        let form_name: String = r
            .try_get::<Option<String>>("", "name")
            .ok()
            .flatten()
            .unwrap_or_default();
        let allowed = allowed_of(&r);
        if !allowed.is_empty() {
            let origin = headers
                .get("origin")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if !is_origin_allowed(origin, &allowed) {
                return Ok(err(StatusCode::NOT_FOUND, "Form not found"));
            }
        }
        let ua = headers
            .get("user-agent")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.chars().take(500).collect::<String>());
        let referer = headers
            .get("referer")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.chars().take(2000).collect::<String>());
        // Best-effort client IP: X-Forwarded-For first, else unknown.
        let ip: Option<String> = headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().chars().take(45).collect::<String>())
            .filter(|s| !s.is_empty());

        let data_val: serde_json::Value =
            serde_json::from_str(&data_json).unwrap_or(json!({}));
        let inserted = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO form_submissions (form_id, ip_address, user_agent, referer, data, locale)
                 VALUES ($1, $2::inet, $3, $4, $5::jsonb, $6)
                 RETURNING id, submitted_at",
                vec![
                    form_id.into(),
                    ip.into(),
                    ua.into(),
                    referer.into(),
                    data_val.into(),
                    locale.clone().into(),
                ],
            ))
            .await?;
        let Some(ins) = inserted else {
            return Ok(err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Internal server error",
            ));
        };
        let sid: i64 = ins.try_get("", "id")?;
        let submitted: chrono::DateTime<chrono::Utc> =
            ins.try_get("", "submitted_at")?;
        let submitted_at =
            submitted.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        // Fire-and-forget notification + auto-reply (never fails the
        // request; the queue worker owns delivery + retries).
        {
            let db = ctx.db.clone();
            let data_owned: serde_json::Value =
                serde_json::from_str::<serde_json::Value>(&data_json).unwrap_or(json!({}));
            let locale_owned = locale.clone();
            let form_name_owned = form_name.clone();
            tokio::spawn(async move {
                send_form_emails(
                    &db,
                    project_id,
                    &form_name_owned,
                    &data_owned,
                    locale_owned.as_deref(),
                )
                .await;
            });
        }
        Ok((
            StatusCode::CREATED,
            Json(json!({ "id": sid, "submittedAt": submitted_at })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[form-embed/submit] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/forms")
        .add("/{secret_token}", get(get_config))
        .add("/{secret_token}/submissions", post(submit))
}
