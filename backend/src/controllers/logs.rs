//! Port of old_backend/routes/logs.js.
//!
//! Admin-only activity-log API (read-only; rows are written by the app):
//!   GET /api/logs      — paged, filterable list
//!   GET /api/logs/meta — distinct filter values for the frontend selects
//!   GET /api/logs/{id} — single row or 404

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;
use std::collections::HashMap;

use crate::middleware::auth::{require_admin, MaybeUser};
use crate::middleware::query::MultiQuery;

const SEARCH_COLUMNS: &[&str] = &["action", "path", "actor_email", "entity_label", "metadata::text"];

fn row_to_dto(r: &sea_orm::QueryResult) -> serde_json::Value {
    let created: Option<chrono::DateTime<chrono::Utc>> =
        r.try_get("", "created_at").ok();
    let metadata: serde_json::Value = r
        .try_get::<Option<serde_json::Value>>("", "metadata")
        .ok()
        .flatten()
        .unwrap_or(json!({}));
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "createdAt": created.map(|t| t.to_rfc3339()),
        "actorType": r.try_get::<Option<String>>("", "actor_type").ok().flatten(),
        "actorUserId": r.try_get::<Option<i64>>("", "actor_user_id").ok().flatten(),
        "actorEmail": r.try_get::<Option<String>>("", "actor_email").ok().flatten(),
        "actorRole": r.try_get::<Option<String>>("", "actor_role").ok().flatten(),
        "actorIp": r.try_get::<Option<String>>("", "actor_ip").ok().flatten(),
        "method": r.try_get::<Option<String>>("", "method").ok().flatten(),
        "path": r.try_get::<Option<String>>("", "path").ok().flatten(),
        "action": r.try_get::<Option<String>>("", "action").ok().flatten(),
        "actionType": r.try_get::<Option<String>>("", "action_type").ok().flatten(),
        "entityType": r.try_get::<Option<String>>("", "entity_type").ok().flatten(),
        "entityId": r.try_get::<Option<i64>>("", "entity_id").ok().flatten(),
        "entityLabel": r.try_get::<Option<String>>("", "entity_label").ok().flatten(),
        "projectId": r.try_get::<Option<i64>>("", "project_id").ok().flatten(),
        "statusCode": r.try_get::<Option<i32>>("", "status_code").ok().flatten(),
        "ok": r.try_get::<bool>("", "ok").unwrap_or(true),
        "metadata": if metadata.is_object() { metadata } else { json!({}) },
    })
}

fn sortable_col(field: &str) -> &'static str {
    match field {
        "id" => "id",
        "createdAt" => "created_at",
        "action" => "action",
        "actionType" => "action_type",
        "actorType" => "actor_type",
        "entityType" => "entity_type",
        "projectId" => "project_id",
        "method" => "method",
        "statusCode" => "status_code",
        _ => "created_at",
    }
}

fn one(q: &HashMap<String, Vec<String>>, k: &str) -> Option<String> {
    q.get(k).and_then(|v| v.last()).cloned().filter(|s| !s.is_empty())
}

async fn meta(State(ctx): State<AppContext>, MaybeUser(u): MaybeUser) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    async fn distinct(ctx: &AppContext, sql: &str, col: &str) -> Vec<serde_json::Value> {
        ctx.db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                sql,
                vec![],
            ))
            .await
            .map(|rows| {
                rows.iter()
                    .map(|r| {
                        if col == "status_code" {
                            r.try_get::<Option<i32>>("", col)
                                .ok()
                                .flatten()
                                .map(|n| json!(n))
                                .unwrap_or(json!(null))
                        } else {
                            r.try_get::<Option<String>>("", col)
                                .ok()
                                .flatten()
                                .map(|s| json!(s))
                                .unwrap_or(json!(null))
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    let actions = distinct(&ctx, "SELECT DISTINCT action FROM activity_logs ORDER BY 1", "action").await;
    let entity_types = distinct(
        &ctx,
        "SELECT DISTINCT entity_type FROM activity_logs WHERE entity_type IS NOT NULL ORDER BY 1",
        "entity_type",
    )
    .await;
    let actor_types =
        distinct(&ctx, "SELECT DISTINCT actor_type FROM activity_logs ORDER BY 1", "actor_type").await;
    let status_codes = distinct(
        &ctx,
        "SELECT DISTINCT status_code FROM activity_logs WHERE status_code IS NOT NULL ORDER BY 1",
        "status_code",
    )
    .await;
    // A meta failure must not 500 the filter UI — return empties instead.
    (
        StatusCode::OK,
        Json(json!({
            "actions": actions,
            "entityTypes": entity_types,
            "actorTypes": actor_types,
            "statusCodes": status_codes,
        })),
    )
        .into_response()
}

async fn list(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let page: i64 = one(&q, "page").and_then(|v| v.parse().ok()).unwrap_or(0).max(0);
    let size: i64 = one(&q, "size").and_then(|v| v.parse().ok()).unwrap_or(10).clamp(1, 100);
    let sort_field = one(&q, "sortField").unwrap_or_else(|| "createdAt".to_string());
    let sort_order = one(&q, "sortOrder").unwrap_or_default();
    let filter_any = one(&q, "filterType").as_deref() != Some("all");

    // Free-text terms: ?queries=a&queries=b (also accepts ?queries[]=a).
    let mut terms: Vec<String> = Vec::new();
    for k in ["queries", "queries[]"] {
        if let Some(v) = q.get(k) {
            for t in v {
                let t = t.trim().to_string();
                if !t.is_empty() {
                    terms.push(t);
                }
            }
        }
    }

    let mut conds: Vec<String> = Vec::new();
    let mut params: Vec<sea_orm::Value> = Vec::new();

    if !terms.is_empty() {
        let joiner = if filter_any { " OR " } else { " AND " };
        let mut clauses = Vec::new();
        for t in &terms {
            let ph = format!("${}", params.len() + 1);
            params.push(format!("%{t}%").into());
            let ors: Vec<String> = SEARCH_COLUMNS.iter().map(|c| format!("{c} ILIKE {ph}")).collect();
            clauses.push(format!("({})", ors.join(" OR ")));
        }
        conds.push(format!("({})", clauses.join(joiner)));
    }

    if let Some(v) = one(&q, "actionType") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.into());
        conds.push(format!("action_type = {ph}"));
    }
    if let Some(v) = one(&q, "action") {
        let actions: Vec<String> = v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        if actions.len() == 1 {
            let ph = format!("${}", params.len() + 1);
            params.push(actions.into_iter().next().unwrap().into());
            conds.push(format!("action = {ph}"));
        } else if actions.len() > 1 {
            let mut phs = Vec::new();
            for a in actions {
                let ph = format!("${}", params.len() + 1);
                params.push(a.into());
                phs.push(ph);
            }
            conds.push(format!("action IN ({})", phs.join(", ")));
        }
    }
    if let Some(v) = one(&q, "actorType") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.into());
        conds.push(format!("actor_type = {ph}"));
    }
    if let Some(v) = one(&q, "actorEmail") {
        let ph = format!("${}", params.len() + 1);
        params.push(format!("%{v}%").into());
        conds.push(format!("actor_email ILIKE {ph}"));
    }
    if let Some(v) = one(&q, "entityType") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.into());
        conds.push(format!("entity_type = {ph}"));
    }
    if let Some(v) = one(&q, "entityId") {
        if let Ok(n) = v.parse::<i64>() {
            let ph = format!("${}", params.len() + 1);
            params.push(n.into());
            conds.push(format!("entity_id = {ph}"));
        }
    }
    if let Some(v) = one(&q, "projectId") {
        if let Ok(n) = v.parse::<i64>() {
            let ph = format!("${}", params.len() + 1);
            params.push(n.into());
            conds.push(format!("project_id = {ph}"));
        }
    }
    if let Some(v) = one(&q, "method") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.to_uppercase().into());
        conds.push(format!("method = {ph}"));
    }
    if let Some(v) = one(&q, "statusCode") {
        if let Ok(n) = v.parse::<i32>() {
            let ph = format!("${}", params.len() + 1);
            params.push(n.into());
            conds.push(format!("status_code = {ph}"));
        }
    }
    if let Some(v) = one(&q, "dateFrom") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.into());
        conds.push(format!("created_at >= {ph}"));
    }
    if let Some(v) = one(&q, "dateTo") {
        let ph = format!("${}", params.len() + 1);
        params.push(v.into());
        conds.push(format!("created_at <= {ph}"));
    }

    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let dir = if sort_order == "asc" { "ASC" } else { "DESC" };
    let order = format!("ORDER BY {} {dir}, id DESC", sortable_col(&sort_field));
    let offset = page * size;

    let count_sql = format!("SELECT COUNT(*)::int AS total FROM activity_logs {where_sql}");
    let total: i32 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &count_sql,
            params.clone(),
        ))
        .await
    {
        Ok(Some(r)) => r.try_get("", "total").unwrap_or(0),
        _ => {
            tracing::error!("[logs/list] count query failed");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response();
        }
    };

    let data_sql = format!(
        "SELECT id, created_at, actor_type, actor_user_id, actor_email, actor_role,
                actor_ip, method, path, action, action_type,
                entity_type, entity_id, entity_label, project_id,
                status_code, ok, metadata
         FROM activity_logs
         {where_sql}
         {order}
         LIMIT ${} OFFSET ${}",
        params.len() + 1,
        params.len() + 2
    );
    let mut dparams = params;
    dparams.push(size.into());
    dparams.push(offset.into());
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &data_sql,
            dparams,
        ))
        .await
    {
        Ok(rows) => {
            let content: Vec<_> = rows.iter().map(row_to_dto).collect();
            let total_pages = if total <= 0 { 1 } else { ((total as i64 + size - 1) / size).max(1) };
            let sorted = q.contains_key("sortField");
            (
                StatusCode::OK,
                Json(json!({
                    "totalPages": total_pages,
                    "totalElements": total,
                    "pageable": {
                        "paged": true,
                        "pageSize": size,
                        "pageNumber": page,
                        "unpaged": false,
                        "offset": offset,
                        "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                    },
                    "numberOfElements": content.len(),
                    "size": size,
                    "content": content,
                    "number": page,
                    "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
                    "first": page == 0,
                    "last": page == total_pages - 1,
                    "empty": content.is_empty(),
                })),
            )
                .into_response()
        }
        Err(e) => {
            tracing::error!("[logs/list] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response()
        }
    }
}

async fn get_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> Response {
    if let Err(r) = require_admin(&u) {
        return r;
    }
    let log_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "Invalid id" })),
            )
                .into_response();
        }
    };
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, created_at, actor_type, actor_user_id, actor_email, actor_role,
                    actor_ip, method, path, action, action_type,
                    entity_type, entity_id, entity_label, project_id,
                    status_code, ok, metadata
             FROM activity_logs WHERE id = $1",
            vec![log_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => (StatusCode::OK, Json(row_to_dto(&r))).into_response(),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "errorMessage": "Log entry not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("[logs/get] {e:?}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "errorMessage": "Internal server error" })),
            )
                .into_response()
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/logs")
        .add("/meta", get(meta))
        .add("/", get(list))
        .add("/{id}", get(get_one))
}
