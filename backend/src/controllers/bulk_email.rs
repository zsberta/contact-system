//! Admin-only bulk e-mail: 1:1 port of old_backend/routes/bulk-email.js.
//!
//!   POST /api/bulk-email — { projectId, subject, body } to every active
//!                          reservation customer of the project.
//!
//! Simplification vs the original: instead of the old renderBulkEmail
//! template + email-queue fan-out, each customer gets a small branded
//! HTML/text message sent best-effort through EmailMailer::send (which
//! honours the EMAIL_SENDING kill-switch internally).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

use crate::mailers::email::EmailMailer;
use crate::middleware::auth::MaybeUser;
use crate::middleware::auth::require_admin;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

async fn send_bulk(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> Response {
    if require_admin(&u).is_err() {
        return match u {
            None => err(StatusCode::UNAUTHORIZED, "Unauthorized"),
            Some(_) => err(StatusCode::FORBIDDEN, "Admin access required"),
        };
    }
    let project_id = body
        .get("projectId")
        .and_then(|v| v.as_i64().or_else(|| v.as_str()?.parse::<i64>().ok()))
        .unwrap_or(0);
    let subject = body
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let text_body = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Valid projectId is required");
    }
    if subject.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Subject is required");
    }
    if text_body.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "Body is required");
    }

    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, name, domain_address, customer_email FROM projects WHERE id = $1",
                vec![project_id.into()],
            ))
            .await?;
        let Some(p) = proj else {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        };
        let project_name: String = p
            .try_get::<Option<String>>("", "name")
            .ok()
            .flatten()
            .unwrap_or_else(|| "Nexus".to_string());
        let customer_email: Option<String> =
            p.try_get("", "customer_email").ok().flatten();
        let domain_address: Option<String> =
            p.try_get("", "domain_address").ok().flatten();

        let customers = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, first_name, last_name, email
                 FROM reservation_customers
                 WHERE project_id = $1 AND status = 'active'
                 ORDER BY last_name, first_name",
                vec![project_id.into()],
            ))
            .await?;
        if customers.is_empty() {
            return Ok((
                StatusCode::OK,
                Json(json!({
                    "success": true, "emailsQueued": 0,
                    "message": "No active customers found for this project",
                })),
            )
                .into_response());
        }
        let mut queued = 0i64;
        let mut skipped = 0i64;
        let footer = match (&domain_address, &customer_email) {
            (Some(d), Some(c)) => format!("<p>{d} — {c}</p>"),
            (Some(d), None) => format!("<p>{d}</p>"),
            (None, Some(c)) => format!("<p>{c}</p>"),
            (None, None) => String::new(),
        };
        for c in &customers {
            let to: Option<String> = c.try_get("", "email").ok().flatten();
            let Some(to) = to.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) else {
                skipped += 1;
                continue;
            };
            // Plain-text body may contain newlines — escape for HTML.
            let html_body = text_body
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
                .replace('\n', "<br>");
            let html = format!(
                "<div><h2>{project_name}</h2><p>{html_body}</p>{footer}</div>"
            );
            let text = format!("{project_name}\n\n{text_body}");
            // Best-effort: EmailMailer honours EMAIL_SENDING=false.
            match EmailMailer::send(&to, &subject, &html, &text).await {
                Ok(()) => queued += 1,
                Err(_) => skipped += 1,
            }
        }
        Ok((
            StatusCode::OK,
            Json(json!({
                "success": true, "emailsQueued": queued,
                "emailsSkipped": skipped, "totalCustomers": customers.len(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[bulk-email] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api/bulk-email").add("/", post(send_bulk))
}
