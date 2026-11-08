//! Port of old_backend/routes/dashboard.js.
//!
//! Routes:
//!   GET /api/dashboard/summary — legacy stub (any authenticated user)
//!   GET /api/dashboard/stats   — KPI payload (admin only; endusers get 403)
//!
//! The stats handler is best-effort by design: every sub-query has a
//! fallback so a DB error still yields a well-formed zeroed payload
//! instead of a 500 (the React dashboard renders an empty state).

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser};

async fn summary(user: CurrentUser) -> Response {
    let _ = user;
    Json(json!({ "totalContacts": 0, "lastUpdated": null })).into_response()
}

async fn stats(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser) -> Response {
    match &u {
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "errorMessage": "Unauthorized" })),
            )
                .into_response();
        }
        Some(x) if x.role == "enduser" => {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({ "errorMessage": "Endusers do not have dashboard access" })),
            )
                .into_response();
        }
        _ => {}
    }

    // (1) Revenue totals + outstanding. Falls back to zeros.
    let (revenue30d, revenue90d, revenue365d, outstanding) = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT
               COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '30 days'), 0)::float  AS revenue30d,
               COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '90 days'), 0)::float  AS revenue90d,
               COALESCE(SUM(amount) FILTER (WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '365 days'), 0)::float AS revenue365d,
               COALESCE(SUM(amount) FILTER (WHERE status IN ('pending','overdue')), 0)::float                         AS outstanding
             FROM payments",
            vec![],
        ))
        .await
        .ok()
        .flatten()
    {
        Some(r) => (
            r.try_get::<Option<f64>>("", "revenue30d").ok().flatten().unwrap_or(0.0),
            r.try_get::<Option<f64>>("", "revenue90d").ok().flatten().unwrap_or(0.0),
            r.try_get::<Option<f64>>("", "revenue365d").ok().flatten().unwrap_or(0.0),
            r.try_get::<Option<f64>>("", "outstanding").ok().flatten().unwrap_or(0.0),
        ),
        None => {
            tracing::error!("[dashboard/stats] totals query failed");
            (0.0, 0.0, 0.0, 0.0)
        }
    };

    // (2) Status counts. Falls back to zeros.
    let mut counts = serde_json::Map::new();
    for k in ["pending", "overdue", "paid", "cancelled"] {
        counts.insert(k.to_string(), json!(0));
    }
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT status, COUNT(*)::int AS n FROM payments GROUP BY status",
            vec![],
        ))
        .await
    {
        Ok(rows) => {
            for r in rows {
                let status: String = r.try_get("", "status").unwrap_or_default();
                let n: i32 = r.try_get("", "n").unwrap_or(0);
                if counts.contains_key(&status) {
                    counts.insert(status, json!(n));
                }
            }
        }
        Err(e) => tracing::error!("[dashboard/stats] counts query failed: {e:?}"),
    }

    // (3) Monthly revenue series. Falls back to [].
    let monthly_revenue: Vec<serde_json::Value> = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT TO_CHAR(date_trunc('month', paid_at), 'YYYY-MM') AS month,
                    COALESCE(SUM(amount), 0)::float                  AS amount
             FROM payments
             WHERE status = 'paid' AND paid_at >= NOW() - INTERVAL '12 months'
             GROUP BY 1
             ORDER BY 1 ASC",
            vec![],
        ))
        .await
    {
        Ok(rows) => rows
            .iter()
            .map(|r| {
                json!({
                    "month": r.try_get::<Option<String>>("", "month").ok().flatten().unwrap_or_default(),
                    "amount": r.try_get::<Option<f64>>("", "amount").ok().flatten().unwrap_or(0.0),
                })
            })
            .collect(),
        Err(e) => {
            tracing::error!("[dashboard/stats] monthly query failed: {e:?}");
            vec![]
        }
    };

    // (4) Upcoming payments. Falls back to [].
    let upcoming_payments: Vec<serde_json::Value> = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT p.id              AS \"paymentId\",
                    p.project_id      AS \"projectId\",
                    pr.name           AS \"projectName\",
                    p.amount::float   AS amount,
                    p.due_date::text  AS \"dueDate\",
                    p.status          AS status,
                    pr.customer_name  AS \"customerName\"
             FROM payments p
             JOIN projects pr ON pr.id = p.project_id
             WHERE p.status IN ('pending','overdue')
             ORDER BY p.due_date ASC
             LIMIT 5",
            vec![],
        ))
        .await
    {
        Ok(rows) => rows
            .iter()
            .map(|r| {
                json!({
                    "paymentId": r.try_get::<i64>("", "paymentId").unwrap_or(0),
                    "projectId": r.try_get::<i64>("", "projectId").unwrap_or(0),
                    "projectName": r.try_get::<Option<String>>("", "projectName").ok().flatten(),
                    "amount": r.try_get::<Option<f64>>("", "amount").ok().flatten().unwrap_or(0.0),
                    "dueDate": r.try_get::<Option<String>>("", "dueDate").ok().flatten(),
                    "status": r.try_get::<Option<String>>("", "status").ok().flatten().unwrap_or_default(),
                    "customerName": r.try_get::<Option<String>>("", "customerName").ok().flatten(),
                })
            })
            .collect(),
        Err(e) => {
            tracing::error!("[dashboard/stats] upcoming query failed: {e:?}");
            vec![]
        }
    };

    (
        StatusCode::OK,
        Json(json!({
            "revenue30d": revenue30d,
            "revenue90d": revenue90d,
            "revenue365d": revenue365d,
            "outstanding": outstanding,
            "counts": counts,
            "monthlyRevenue": monthly_revenue,
            "upcomingPayments": upcoming_payments,
        })),
    )
        .into_response()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/dashboard")
        .add("/summary", get(summary))
        .add("/stats", get(stats))
}
