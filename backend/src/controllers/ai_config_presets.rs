//! Admin CRUD for reusable AI config presets.
//!
//! Routes (all under /api/ai-config-presets, auth required):
//!   GET    /          — paged list of the current user's presets
//!   GET    /:id       — single preset (owner-scoped)
//!   POST   /          — create (admin only; endusers get 403)
//!   PUT    /:id       — update (admin only)
//!   DELETE /:id       — delete (admin only, 204)
//!
//! Notes / degradations:
//! - `apiKey` is stored verbatim in `api_key_enc` (no AES call in this
//!   route) and never returned in the DTO: the key is write-only and
//!   never serialized back.
//! - Activity logging isn't wired here; mutations are traced via
//!   `tracing::info!` instead.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde::Deserialize;
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser};

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

fn auth_user(u: &Option<CurrentUser>) -> Result<&CurrentUser, Response> {
    match u {
        Some(x) => Ok(x),
        None => Err(err(StatusCode::UNAUTHORIZED, "Unauthorized")),
    }
}

fn forbid_enduser(user: &CurrentUser) -> Option<Response> {
    if user.role == "enduser" {
        return Some(err(
            StatusCode::FORBIDDEN,
            "Endusers have read-only access",
        ));
    }
    None
}

const SELECT_COLS: &str =
    "id, user_id, name, model, base_url, base_prompt, created_at, updated_at";

fn read_row(row: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let id: i64 = row.try_get("", "id")?;
    let user_id: i64 = row.try_get("", "user_id")?;
    let name: Option<String> = row.try_get("", "name").ok().flatten();
    let model: Option<String> = row.try_get("", "model").ok().flatten();
    let base_url: Option<String> = row.try_get("", "base_url").ok().flatten();
    let base_prompt: Option<String> = row.try_get("", "base_prompt").ok().flatten();
    let created_at: String = row
        .try_get::<chrono::DateTime<chrono::Utc>>("", "created_at")
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    let updated_at: String = row
        .try_get::<chrono::DateTime<chrono::Utc>>("", "updated_at")
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    Ok(json!({
        "id": id,
        "userId": user_id,
        "name": name.unwrap_or_default(),
        "model": model.unwrap_or_else(|| "gpt-4o".to_string()),
        "baseUrl": base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        "basePrompt": base_prompt.unwrap_or_else(|| "You are a helpful assistant.".to_string()),
        "createdAt": created_at,
        "updatedAt": updated_at,
    }))
}

#[derive(Debug, Deserialize)]
struct Paging {
    page: Option<i64>,
    size: Option<i64>,
}

async fn list(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Query(q): Query<Paging>,
) -> Response {
    let user = match auth_user(&u) {
        Ok(x) => x.clone(),
        Err(r) => return r,
    };
    let page = q.page.unwrap_or(0).max(0);
    let size = q.size.unwrap_or(20).clamp(1, 100);
    let res: Result<Response> = (async {
        let total: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT COUNT(*)::bigint AS total FROM ai_config_presets WHERE user_id = $1",
                vec![user.id.into()],
            ))
            .await?
            .map(|r| r.try_get::<i64>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT {SELECT_COLS} FROM ai_config_presets WHERE user_id = $1 ORDER BY name ASC LIMIT $2 OFFSET $3"
                ),
                vec![user.id.into(), size.into(), (page * size).into()],
            ))
            .await?;
        let mut content = Vec::with_capacity(rows.len());
        for r in &rows {
            content.push(read_row(r)?);
        }
        let total_pages = if total == 0 { 0 } else { (total + size - 1) / size };
        Ok((
            StatusCode::OK,
            Json(json!({
                "content": content,
                "totalElements": total,
                "totalPages": total_pages,
                "page": page,
                "size": size,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[ai-config-presets/list] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn get_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_user(&u) {
        Ok(x) => x.clone(),
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            format!(
                "SELECT {SELECT_COLS} FROM ai_config_presets WHERE id = $1 AND user_id = $2"
            ),
            vec![id.into(), user.id.into()],
        ))
        .await
    {
        Ok(Some(row)) => match read_row(&row) {
            Ok(dto) => (StatusCode::OK, Json(dto)).into_response(),
            Err(e) => {
                tracing::error!("[ai-config-presets/get] {e:?}");
                err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
            }
        },
        Ok(None) => err(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => {
            tracing::error!("[ai-config-presets/get] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

#[derive(Debug, Deserialize)]
struct PresetBody {
    name: Option<String>,
    model: Option<String>,
    #[serde(rename = "baseUrl")]
    base_url: Option<String>,
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
    #[serde(rename = "basePrompt")]
    base_prompt: Option<String>,
}

async fn create(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(b): Json<PresetBody>,
) -> Response {
    let user = match auth_user(&u) {
        Ok(x) => x.clone(),
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser(&user) {
        return r;
    }
    let name = b.name.unwrap_or_default().trim().to_string();
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "Name is required");
    }
    let model = b.model.unwrap_or_else(|| "gpt-4o".to_string());
    let base_url = b
        .base_url
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let api_key: Option<String> = b.api_key;
    let base_prompt = b
        .base_prompt
        .unwrap_or_else(|| "You are a helpful assistant.".to_string());
    let res: Result<Response> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "INSERT INTO ai_config_presets (user_id, name, model, base_url, api_key_enc, base_prompt) VALUES ($1, $2, $3, $4, $5, $6) RETURNING {SELECT_COLS}"
                ),
                vec![
                    user.id.into(),
                    name.clone().into(),
                    model.into(),
                    base_url.into(),
                    api_key.into(),
                    base_prompt.into(),
                ],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        let dto = read_row(&row)?;
        tracing::info!("[ai-config-presets] preset.create name={name}");
        Ok((StatusCode::CREATED, Json(dto)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[ai-config-presets/create] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn update(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    Json(b): Json<PresetBody>,
) -> Response {
    let user = match auth_user(&u) {
        Ok(x) => x.clone(),
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let mut sets: Vec<String> = vec![];
    let mut vals: Vec<sea_orm::Value> = vec![];
    let mut idx = 1;
    let mut fields: Vec<&str> = vec![];
    if let Some(name) = b.name {
        sets.push(format!("name = ${idx}"));
        idx += 1;
        vals.push(name.trim().to_string().into());
        fields.push("name");
    }
    if let Some(model) = b.model {
        sets.push(format!("model = ${idx}"));
        idx += 1;
        vals.push(model.trim().to_string().into());
        fields.push("model");
    }
    if let Some(base_url) = b.base_url {
        sets.push(format!("base_url = ${idx}"));
        idx += 1;
        vals.push(base_url.trim().to_string().into());
        fields.push("base_url");
    }
    if let Some(api_key) = b.api_key {
        if !api_key.is_empty() {
            sets.push(format!("api_key_enc = ${idx}"));
            idx += 1;
            vals.push(api_key.into());
            fields.push("api_key_enc");
        }
    }
    if let Some(base_prompt) = b.base_prompt {
        sets.push(format!("base_prompt = ${idx}"));
        idx += 1;
        vals.push(base_prompt.into());
        fields.push("base_prompt");
    }
    if sets.is_empty() {
        return err(StatusCode::BAD_REQUEST, "No fields to update");
    }
    vals.push(id.into());
    let id_ph = idx;
    idx += 1;
    vals.push(user.id.into());
    let user_ph = idx;
    let res: Result<Response> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "UPDATE ai_config_presets SET {} WHERE id = ${id_ph} AND user_id = ${user_ph} RETURNING {SELECT_COLS}",
                    sets.join(", ")
                ),
                vals,
            ))
            .await?;
        match row {
            Some(r) => {
                let dto = read_row(&r)?;
                tracing::info!(
                    "[ai-config-presets] preset.update id={id} fields={fields:?}"
                );
                Ok((StatusCode::OK, Json(dto)).into_response())
            }
            None => Ok(err(StatusCode::NOT_FOUND, "Not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[ai-config-presets/update] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

async fn delete_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_user(&u) {
        Ok(x) => x.clone(),
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let res: Result<Response> = (async {
        let before = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, name FROM ai_config_presets WHERE id = $1 AND user_id = $2",
                vec![id.into(), user.id.into()],
            ))
            .await?;
        let Some(b) = before else {
            return Ok(err(StatusCode::NOT_FOUND, "Not found"));
        };
        let label: Option<String> = b.try_get("", "name").ok().flatten();
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM ai_config_presets WHERE id = $1 AND user_id = $2",
                vec![id.into(), user.id.into()],
            ))
            .await?;
        tracing::info!(
            "[ai-config-presets] preset.delete id={id} label={}",
            label.unwrap_or_default()
        );
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[ai-config-presets/delete] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/ai-config-presets")
        .add("/", get(list))
        .add("/", post(create))
        .add("/{id}", get(get_one))
        .add("/{id}", put(update))
        .add("/{id}", delete(delete_one))
}
