//! Routes (all require auth; endusers are scoped to assigned projects):
//!   GET /api/project-modules?projectId=<id> — module DTOs for one project
//!   GET /api/project-modules/{id}            — single module DTO

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;
use std::collections::HashMap;

use crate::middleware::auth::{scoped_project_ids, CurrentUser};

const MODULE_SQL: &str = "SELECT
     pm.id,
     pm.project_id AS \"projectId\",
     pm.module_type AS \"kind\",
     CASE pm.module_type
       WHEN 'form' THEN (SELECT id FROM forms WHERE module_id = pm.id)
       WHEN 'reservation' THEN (SELECT id FROM reservations WHERE module_id = pm.id)
       WHEN 'analytics' THEN (SELECT id FROM analytics_configs WHERE module_id = pm.id)
       WHEN 'ai-assistant' THEN (SELECT id FROM ai_assistant_configs WHERE module_id = pm.id)
       ELSE NULL
     END AS \"resourceId\",
     CASE pm.module_type
       WHEN 'form' THEN (SELECT name FROM forms WHERE module_id = pm.id)
       WHEN 'reservation' THEN (SELECT name FROM reservations WHERE module_id = pm.id)
       WHEN 'analytics' THEN (SELECT name FROM analytics_configs WHERE module_id = pm.id)
       WHEN 'ai-assistant' THEN (SELECT name FROM ai_assistant_configs WHERE module_id = pm.id)
       WHEN 'blog' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Blog'
       WHEN 'faq' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' FAQ'
       WHEN 'service' THEN (SELECT name FROM projects WHERE id = pm.project_id) || ' Services'
       ELSE pm.module_type
     END AS label";

fn row_to_dto(r: &sea_orm::QueryResult) -> serde_json::Value {
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": r.try_get::<i64>("", "projectId").unwrap_or(0),
        "kind": r.try_get::<Option<String>>("", "kind").ok().flatten().unwrap_or_default(),
        "resourceId": r.try_get::<Option<i64>>("", "resourceId").ok().flatten(),
        "label": r.try_get::<Option<String>>("", "label").ok().flatten(),
    })
}

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let project_id: i64 = match q.get("projectId").and_then(|v| v.parse().ok()) {
        Some(n) if n > 0 => n,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "projectId is required" })),
            )
                .into_response();
        }
    };
    // Scope: endusers only see their assigned projects.
    if let Some(ids) = scoped_project_ids(&user) {
        if !ids.contains(&project_id) {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "errorMessage": "Project not found" })),
            )
                .into_response();
        }
    }
    let sql = format!("{MODULE_SQL} FROM project_modules pm WHERE pm.project_id = $1 ORDER BY pm.module_type");
    match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &sql,
            vec![project_id.into()],
        ))
        .await
    {
        Ok(rows) => {
            // Distinguish "project doesn't exist" from "project has no modules".
            if rows.is_empty() {
                let exists = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT id FROM projects WHERE id = $1",
                        vec![project_id.into()],
                    ))
                    .await
                    .ok()
                    .flatten()
                    .is_some();
                if !exists {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "errorMessage": "Project not found" })),
                    )
                        .into_response();
                }
            }
            (StatusCode::OK, Json(rows.iter().map(row_to_dto).collect::<Vec<_>>())).into_response()
        }
        Err(e) => {
            tracing::error!("[project-modules/list] {e:?}");
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
    user: CurrentUser,
    Path(id): Path<String>,
) -> Response {
    let module_id: i64 = match id.parse() {
        Ok(n) if n > 0 => n,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "errorMessage": "Invalid module ID" })),
            )
                .into_response();
        }
    };
    let sql = format!("{MODULE_SQL} FROM project_modules pm WHERE pm.id = $1");
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            &sql,
            vec![module_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => {
            if let Some(ids) = scoped_project_ids(&user) {
                let pid: i64 = r.try_get("", "projectId").unwrap_or(0);
                if !ids.contains(&pid) {
                    return (
                        StatusCode::NOT_FOUND,
                        Json(json!({ "errorMessage": "Module not found" })),
                    )
                        .into_response();
                }
            }
            (StatusCode::OK, Json(row_to_dto(&r))).into_response()
        }
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "errorMessage": "Module not found" })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!("[project-modules/get] {e:?}");
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
        .prefix("/api/project-modules")
        .add("/", get(list))
        .add("/{id}", get(get_one))
}
