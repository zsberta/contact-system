//! Admin AI Assistant controller.
//!
//! Endpoints (all under /api/ai-assistant, auth required):
//! - GET    / — paged config list (enduser: project-scoped)
//! - GET    /by-project/:projectId — lazy upsert (404-masked for endusers)
//! - GET    /:id — config + translations (404-masked for endusers)
//! - PUT    /:id — update config + translations in a txn (admin only)
//! - DELETE /:id — hard delete CASCADE (admin only)
//! - GET    /:id/snippet — embed snippet
//! - GET    /:id/knowledge — list docs
//! - POST   /:id/knowledge — multipart upload (admin only; 201 processing)
//! - GET    /:id/knowledge/:docId/chunks
//! - DELETE /:id/knowledge/:docId (admin only, 204)
//! - POST   /:id/avatar — widget avatar upload (admin only)
//! - DELETE /:id/avatar (admin only, 204)
//! - GET    /:id/sessions — paged chat sessions
//! - GET    /:id/sessions/:sessionId — messages (read-only)
//! - POST   /:id/test-chat — non-persisted RAG + LLM round-trip (any authed
//!   user with project access; mirrors the public chat pipeline without
//!   SSE persistence)
//!
//! Degradations (reason for each):
//! - ENCRYPTION: `aes-gcm` is NOT in Cargo deps (Cargo.toml is shared /
//!   frozen), so pre-existing AES-256-GCM blobs CANNOT be decrypted here.
//!   New keys are stored as `"plain:<key>"` (unknown shapes are treated as
//!   legacy plaintext, so rows stay readable everywhere).
//!   `resolve_api_key()` returns `EncryptedUnavailable` for such blobs;
//!   only key-protected operations (chat/test-chat,
//!   embeddings) fail with a clear 500 "encryption unavailable — re-save
//!   the key"; every other endpoint keeps working.
//! - EMBEDDINGS: if `AI_EMBEDDING_API_KEY` (or a resolvable assistant key)
//!   is set, embeddings are fetched from the OpenAI-compatible endpoint
//!   (`AI_EMBEDDING_BASE_URL`, `AI_EMBEDDING_MODEL`) via reqwest and stored
//!   as pgvector literals; otherwise chunks are stored with NULL embedding
//!   and retrieval falls back to keyword (ILIKE) search. Document status
//!   still becomes `ready`.
//! - EXTRACTION: `.txt`/`.md`/`.csv` are read as UTF-8; `.pdf`/`.docx`
//!   extraction libraries are unavailable in this workspace, so those docs
//!   finish with `status='error'` and a clear message instead of hanging.
//! - PROCESSING runs as a Tokio background task (same process), not a
//!   detached child process — same DB-status protocol (`processing` →
//!   `ready`/`error`), temp file removed afterwards.
//! - STREAMING: reqwest here has no `stream` feature, so the LLM SSE body
//!   is buffered server-side and then replayed as SSE (embed chat) or
//!   returned as JSON (test-chat). Clients still receive valid SSE.
//! - `createNotification` (push/in-app) and `logActivity` side effects are
//!   skipped / replaced with `tracing`.

use axum::{
    extract::{Multipart, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::middleware::auth::{CurrentUser, MaybeUser};
use crate::middleware::query::MultiQuery;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn db_err(e: sea_orm::DbErr) -> Response {
    tracing::error!("[ai-assistant] db {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn auth_required(u: &Option<CurrentUser>) -> Result<CurrentUser, Response> {
    match u {
        Some(x) => Ok(x.clone()),
        None => Err(err(StatusCode::UNAUTHORIZED, "Unauthorized")),
    }
}

fn forbid_enduser_mutation(user: &CurrentUser) -> Option<Response> {
    if user.role == "enduser" {
        return Some(err(StatusCode::FORBIDDEN, "Endusers have read-only access"));
    }
    None
}

fn scoped_ids(user: &CurrentUser) -> Option<Vec<i64>> {
    if user.role == "admin" {
        None
    } else if user.role == "enduser" {
        Some(user.project_ids.iter().copied().filter(|n| *n > 0).collect())
    } else {
        Some(vec![])
    }
}

fn ts(v: &sea_orm::QueryResult, col: &str) -> String {
    v.try_get::<chrono::DateTime<chrono::Utc>>("", col)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default()
}

fn opt_str(v: &sea_orm::QueryResult, col: &str) -> Option<String> {
    v.try_get::<Option<String>>("", col).ok().flatten()
}

fn str_arr(v: &sea_orm::QueryResult, col: &str) -> Vec<String> {
    if let Ok(a) = v.try_get::<Vec<String>>("", col) {
        return a.into_iter().filter(|s| !s.is_empty()).collect();
    }
    if let Some(s) = opt_str(v, col) {
        if let Ok(a) = serde_json::from_str::<Vec<String>>(&s) {
            return a;
        }
    }
    vec![]
}

fn rand_secret_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut buf);
    const ALPH: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(22);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for b in buf {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            out.push(ALPH[((acc >> bits) & 63) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPH[((acc << (6 - bits)) & 63) as usize] as char);
    }
    out
}

// ---------------------------------------------------------------------------
// API-key encryption state (see header)
// ---------------------------------------------------------------------------

pub(crate) enum KeyState {
    Missing,
    Ready(String),
    EncryptedUnavailable,
}

pub(crate) fn resolve_api_key(enc: Option<String>) -> KeyState {
    match enc {
        None => KeyState::Missing,
        Some(s) if s.is_empty() => KeyState::Missing,
        Some(s) => {
            if let Some(rest) = s.strip_prefix("plain:") {
                if rest.is_empty() {
                    KeyState::Missing
                } else {
                    KeyState::Ready(rest.to_string())
                }
            } else {
                // Pre-existing AES-256-GCM blob (or legacy raw key). Without aes-gcm
                // we cannot decrypt; per spec this is a clear 500 for
                // key-protected operations only.
                KeyState::EncryptedUnavailable
            }
        }
    }
}

fn store_api_key(raw: &str) -> String {
    format!("plain:{raw}")
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const CONFIG_COLUMNS: &str = "c.id, c.project_id, p.name AS project_name, c.name, c.secret_token, c.status, c.ai_config_id, c.model, c.base_url, c.base_prompt, c.display_name, c.primary_color, c.secondary_color, c.greeting_message, c.legal_message, c.popup_message, c.avatar_url, c.position, c.default_language, c.supported_languages, c.allowed_origins, c.rate_limit_burst, c.rate_limit_sustained, c.max_upload_size_mb, c.created_at, c.updated_at";

fn config_dto(r: &sea_orm::QueryResult) -> Value {
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "projectId": r.try_get::<i64>("", "project_id").unwrap_or(0),
        "projectName": opt_str(r, "project_name"),
        "name": opt_str(r, "name").unwrap_or_default(),
        "secretToken": opt_str(r, "secret_token").unwrap_or_default(),
        "status": opt_str(r, "status").unwrap_or_else(|| "active".to_string()),
        "aiConfigId": r.try_get::<Option<i64>>("", "ai_config_id").ok().flatten(),
        "model": opt_str(r, "model").unwrap_or_else(|| "gpt-4o".to_string()),
        "baseUrl": opt_str(r, "base_url").unwrap_or_default(),
        "basePrompt": opt_str(r, "base_prompt").unwrap_or_default(),
        "displayName": opt_str(r, "display_name").unwrap_or_else(|| "AI Assistant".to_string()),
        "primaryColor": opt_str(r, "primary_color").unwrap_or_else(|| "#3b82f6".to_string()),
        "secondaryColor": opt_str(r, "secondary_color").unwrap_or_else(|| "#ffffff".to_string()),
        "greetingMessage": opt_str(r, "greeting_message").unwrap_or_default(),
        "legalMessage": opt_str(r, "legal_message").unwrap_or_default(),
        "popupMessage": opt_str(r, "popup_message").unwrap_or_default(),
        "avatarUrl": opt_str(r, "avatar_url"),
        "position": opt_str(r, "position").unwrap_or_else(|| "bottom-right".to_string()),
        "defaultLanguage": opt_str(r, "default_language").unwrap_or_else(|| "en".to_string()),
        "supportedLanguages": str_arr(r, "supported_languages"),
        "allowedOrigins": str_arr(r, "allowed_origins"),
        "rateLimitBurst": r.try_get::<i32>("", "rate_limit_burst").unwrap_or(30),
        "rateLimitSustained": r.try_get::<i32>("", "rate_limit_sustained").unwrap_or(500),
        "maxUploadSizeMb": r.try_get::<i32>("", "max_upload_size_mb").unwrap_or(20),
        "createdAt": ts(r, "created_at"),
        "updatedAt": ts(r, "updated_at"),
    })
}

async fn translations_for(
    db: &sea_orm::DatabaseConnection,
    assistant_id: i64,
) -> Result<Vec<Value>, sea_orm::DbErr> {
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, assistant_id, language, display_name, greeting_message, placeholder, created_at, updated_at FROM ai_assistant_translations WHERE assistant_id = $1 ORDER BY language ASC",
            vec![assistant_id.into()],
        ))
        .await?;
    Ok(rows
        .iter()
        .map(|t| {
            json!({
                "id": t.try_get::<i64>("", "id").unwrap_or(0),
                "assistantId": t.try_get::<i64>("", "assistant_id").unwrap_or(0),
                "language": opt_str(t, "language"),
                "displayName": opt_str(t, "display_name"),
                "greetingMessage": opt_str(t, "greeting_message"),
                "placeholder": opt_str(t, "placeholder"),
                "createdAt": ts(t, "created_at"),
                "updatedAt": ts(t, "updated_at"),
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Body validation (partial=true for PUT)
// ---------------------------------------------------------------------------

fn validate_origin_entry(entry: &str, index: usize, seen: &mut std::collections::HashSet<String>) -> Result<String, String> {
    use regex::Regex;
    let trimmed = entry.trim().to_lowercase();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return Err(format!("allowedOrigins[{index}]: must be 1..253 chars"));
    }
    let host_re = Regex::new(r"^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$").unwrap();
    let scheme_re = Regex::new(r"^https?://(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$").unwrap();
    let lb_bare = Regex::new(r"^localhost(:[0-9]{1,5})?$").unwrap();
    let lb_v4 = Regex::new(r"^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$").unwrap();
    let lb_v6 = Regex::new(r"^\[::1?\](:[0-9]{1,5})?$").unwrap();
    let lb_scheme = Regex::new(r"^https?://(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$").unwrap();
    let is_bare = host_re.is_match(&trimmed);
    let is_scheme = scheme_re.is_match(&trimmed);
    let is_lb = lb_bare.is_match(&trimmed) || lb_v4.is_match(&trimmed) || lb_v6.is_match(&trimmed);
    let is_lb_scheme = lb_scheme.is_match(&trimmed);
    if !is_bare && !is_scheme && !is_lb && !is_lb_scheme {
        return Err(format!("allowedOrigins[{index}]: invalid origin ({entry})"));
    }
    let normalised = if is_scheme || is_lb_scheme { trimmed } else { format!("https://{trimmed}") };
    if seen.contains(&normalised) {
        return Err(format!("allowedOrigins[{index}]: duplicate"));
    }
    seen.insert(normalised.clone());
    Ok(normalised)
}

fn bstr(body: &Value, camel: &str, snake: &str) -> Option<String> {
    body.get(camel).or_else(|| body.get(snake)).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn bint(body: &Value, camel: &str, snake: &str) -> Option<i64> {
    let v = body.get(camel).or_else(|| body.get(snake))?;
    v.as_i64().or_else(|| v.as_str()?.parse().ok())
}

fn validate_config_body(body: &Value, partial: bool) -> Result<HashMap<String, sea_orm::Value>, String> {
    let mut out: HashMap<String, sea_orm::Value> = HashMap::new();
    let mut errors: Vec<String> = vec![];
    if body.get("projectId").is_some() || body.get("project_id").is_some() {
        if partial {
            errors.push("projectId cannot be changed".to_string());
        } else {
            match bint(body, "projectId", "project_id").filter(|n| *n > 0) {
                Some(n) => {
                    out.insert("project_id".to_string(), n.into());
                }
                None => errors.push("projectId must be a positive integer".to_string()),
            }
        }
    } else if !partial {
        errors.push("projectId is required".to_string());
    }
    match bstr(body, "name", "name") {
        Some(n) => {
            let t = n.trim().to_string();
            if t.is_empty() || t.len() > 200 {
                errors.push("name must be 1..200 chars".to_string());
            } else {
                out.insert("name".to_string(), t.into());
            }
        }
        None if !partial => errors.push("name is required".to_string()),
        None => {}
    }
    if body.get("secretToken").is_some() || body.get("secret_token").is_some() {
        errors.push("secretToken cannot be set or changed".to_string());
    }
    match bstr(body, "status", "status") {
        Some(s) => {
            if s == "active" || s == "disabled" {
                out.insert("status".to_string(), s.into());
            } else {
                errors.push("status must be one of active, disabled".to_string());
            }
        }
        None if !partial => {
            out.insert("status".to_string(), "active".to_string().into());
        }
        None => {}
    }
    match body.get("allowedOrigins").or_else(|| body.get("allowed_origins")) {
        Some(v) => match v.as_array() {
            Some(arr) => {
                if arr.len() > 100 {
                    errors.push("allowedOrigins: maximum 100 entries".to_string());
                } else {
                    let mut seen = std::collections::HashSet::new();
                    let mut cleaned = vec![];
                    for (i, e) in arr.iter().enumerate() {
                        match e.as_str() {
                            Some(s) => match validate_origin_entry(s, i, &mut seen) {
                                Ok(n) => cleaned.push(n),
                                Err(x) => errors.push(x),
                            },
                            None => errors.push(format!("allowedOrigins[{i}]: must be a string")),
                        }
                    }
                    if errors.is_empty() {
                        out.insert("allowed_origins".to_string(), cleaned.into());
                    }
                }
            }
            None => errors.push("allowedOrigins must be an array".to_string()),
        },
        None if !partial => {
            out.insert("allowed_origins".to_string(), Vec::<String>::new().into());
        }
        None => {}
    }
    match bstr(body, "model", "model") {
        Some(s) => {
            let t = s.trim().to_string();
            if t.is_empty() || t.len() > 200 {
                errors.push("model must be 1..200 chars".to_string());
            } else {
                out.insert("model".to_string(), t.into());
            }
        }
        None if !partial => {
            out.insert("model".to_string(), "gpt-4o".to_string().into());
        }
        None => {}
    }
    match bstr(body, "baseUrl", "base_url") {
        Some(s) => {
            let t = s.trim().to_string();
            if t.is_empty() || t.len() > 500 {
                errors.push("baseUrl must be 1..500 chars".to_string());
            } else {
                out.insert("base_url".to_string(), t.into());
            }
        }
        None if !partial => {
            out.insert("base_url".to_string(), "https://api.openai.com/v1".to_string().into());
        }
        None => {}
    }
    if let Some(v) = body.get("apiKey").or_else(|| body.get("api_key")) {
        if let Some(s) = v.as_str() {
            if !s.is_empty() {
                out.insert("api_key_enc".to_string(), store_api_key(s).into());
            }
        }
    }
    match body.get("basePrompt").or_else(|| body.get("base_prompt")) {
        Some(v) => match v.as_str() {
            Some(s) => {
                if s.len() > 10000 {
                    errors.push("basePrompt must be <= 10000 chars".to_string());
                } else {
                    out.insert("base_prompt".to_string(), s.to_string().into());
                }
            }
            None => errors.push("basePrompt must be a string".to_string()),
        },
        None if !partial => {
            out.insert("base_prompt".to_string(), "You are a helpful assistant.".to_string().into());
        }
        None => {}
    }
    match bstr(body, "displayName", "display_name") {
        Some(s) => {
            let t = s.trim().to_string();
            if t.is_empty() || t.len() > 200 {
                errors.push("displayName must be 1..200 chars".to_string());
            } else {
                out.insert("display_name".to_string(), t.into());
            }
        }
        None if !partial => {
            out.insert("display_name".to_string(), "AI Assistant".to_string().into());
        }
        None => {}
    }
    for (camel, col) in [("primaryColor", "primary_color"), ("secondaryColor", "secondary_color")] {
        let def = if col == "primary_color" { "#3b82f6" } else { "#ffffff" };
        match bstr(body, camel, col) {
            Some(s) => {
                let ok = (s.len() == 4 || s.len() == 7 || s.len() == 9)
                    && s.starts_with('#')
                    && s[1..].chars().all(|c| c.is_ascii_hexdigit());
                if !ok {
                    errors.push(format!("{camel} must be a valid hex color"));
                } else {
                    out.insert(col.to_string(), s.into());
                }
            }
            None if !partial => {
                out.insert(col.to_string(), def.to_string().into());
            }
            None => {}
        }
    }
    for (camel, col, max) in [("greetingMessage", "greeting_message", 2000), ("legalMessage", "legal_message", 5000), ("popupMessage", "popup_message", 5000)] {
        let def = if col == "greeting_message" { "Hello! How can I help you today?" } else { "" };
        match body.get(camel).or_else(|| body.get(col)) {
            Some(v) => match v.as_str() {
                Some(s) => {
                    if s.len() > max {
                        errors.push(format!("{camel} must be <= {max} chars"));
                    } else {
                        out.insert(col.to_string(), s.to_string().into());
                    }
                }
                None => errors.push(format!("{camel} must be a string")),
            },
            None if !partial => {
                out.insert(col.to_string(), def.to_string().into());
            }
            None => {}
        }
    }
    match body.get("avatarUrl").or_else(|| body.get("avatar_url")) {
        Some(Value::Null) | None if partial && body.get("avatarUrl").is_none() && body.get("avatar_url").is_none() => {}
        Some(Value::Null) => {
            out.insert("avatar_url".to_string(), sea_orm::Value::String(None));
        }
        Some(v) => match v.as_str() {
            Some(s) => {
                if s.is_empty() {
                    out.insert("avatar_url".to_string(), sea_orm::Value::String(None));
                } else {
                    out.insert("avatar_url".to_string(), s.to_string().into());
                }
            }
            None => errors.push("avatarUrl must be a string or null".to_string()),
        },
        None if !partial => {
            out.insert("avatar_url".to_string(), sea_orm::Value::String(None));
        }
        None => {}
    }
    match body.get("position") {
        Some(v) => match v.as_str() {
            Some(s) if s == "bottom-right" || s == "bottom-left" => {
                out.insert("position".to_string(), s.to_string().into());
            }
            _ => errors.push("position must be 'bottom-right' or 'bottom-left'".to_string()),
        },
        None if !partial => {
            out.insert("position".to_string(), "bottom-right".to_string().into());
        }
        None => {}
    }
    match bstr(body, "defaultLanguage", "default_language") {
        Some(s) => {
            let t = s.trim().to_string();
            if t.len() < 2 || t.len() > 10 {
                errors.push("defaultLanguage must be 2..10 chars".to_string());
            } else {
                out.insert("default_language".to_string(), t.into());
            }
        }
        None if !partial => {
            out.insert("default_language".to_string(), "en".to_string().into());
        }
        None => {}
    }
    match body.get("supportedLanguages").or_else(|| body.get("supported_languages")) {
        Some(v) => match v.as_array() {
            Some(arr) => {
                let cleaned: Vec<String> = arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| s.len() >= 2 && s.len() <= 10)
                    .collect();
                if cleaned.is_empty() {
                    errors.push("supportedLanguages must contain at least one valid language code".to_string());
                } else {
                    out.insert("supported_languages".to_string(), cleaned.into());
                }
            }
            None => errors.push("supportedLanguages must be an array".to_string()),
        },
        None if !partial => {
            out.insert("supported_languages".to_string(), vec!["en".to_string()].into());
        }
        None => {}
    }
    for (camel, col, lo, hi) in [("rateLimitBurst", "rate_limit_burst", 1, 10000), ("rateLimitSustained", "rate_limit_sustained", 1, 100000), ("maxUploadSizeMb", "max_upload_size_mb", 1, 100)] {
        let def = if col == "rate_limit_burst" { 30 } else if col == "rate_limit_sustained" { 500 } else { 20 };
        match bint(body, camel, col) {
            Some(n) => {
                if n < lo || n > hi {
                    errors.push(format!("{camel} must be {lo}..{hi}"));
                } else {
                    out.insert(col.to_string(), (n as i32).into());
                }
            }
            None if !partial => {
                out.insert(col.to_string(), (def as i32).into());
            }
            None => {}
        }
    }
    if let Some(v) = body.get("aiConfigId").or_else(|| body.get("ai_config_id")) {
        if v.is_null() {
            out.insert("ai_config_id".to_string(), sea_orm::Value::BigInt(None));
        } else if let Some(n) = v.as_i64().filter(|n| *n > 0) {
            out.insert("ai_config_id".to_string(), n.into());
        } else {
            errors.push("aiConfigId must be a positive integer or null".to_string());
        }
    }
    if !errors.is_empty() {
        return Err(errors.join("; "));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Handlers: configs
// ---------------------------------------------------------------------------

async fn list_configs(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    MultiQuery(q): MultiQuery,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    let one = |k: &str| q.get(k).and_then(|v| v.first()).cloned();
    let page = one("page").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).max(0);
    let size = one("size").and_then(|s| s.parse::<i64>().ok()).unwrap_or(10).clamp(1, 100);
    let sort_field = one("sortField");
    let sort_order = one("sortOrder");
    let sort_col = match sort_field.as_deref() {
        Some("id") => "c.id",
        Some("name") => "c.name",
        Some("status") => "c.status",
        Some("updatedAt") => "c.updated_at",
        _ => "c.created_at",
    };
    let dir = if sort_order.as_deref() == Some("asc") { "ASC" } else { "DESC" };
    let sorted = sort_field.is_some();
    let mut raw_terms: Vec<String> = q.get("queries").cloned().unwrap_or_default();
    if let Some(extra) = q.get("queries[]") {
        raw_terms.extend(extra.clone());
    }
    let terms: Vec<String> = raw_terms.into_iter().filter(|t| !t.trim().is_empty()).collect();
    let filter_all = one("filterType").as_deref() == Some("all");
    let mut conds: Vec<String> = vec![];
    let mut vals: Vec<sea_orm::Value> = vec![];
    let mut ph = 1;
    if let Some(pid) = one("projectId").or_else(|| one("project_id")).and_then(|s| s.parse::<i64>().ok()).filter(|n| *n > 0) {
        conds.push(format!("c.project_id = ${ph}"));
        ph += 1;
        vals.push(pid.into());
    }
    if !terms.is_empty() {
        let conj = if filter_all { " AND " } else { " OR " };
        let parts: Vec<String> = terms
            .into_iter()
            .map(|t| {
                let s = format!("(c.name ILIKE ${ph})");
                ph += 1;
                vals.push(format!("%{t}%").into());
                s
            })
            .collect();
        conds.push(parts.join(conj));
    }
    match scoped_ids(&user) {
        None => {}
        Some(ids) => {
            if ids.is_empty() {
                conds.push("FALSE".to_string());
            } else {
                conds.push(format!("c.project_id = ANY(${ph}::bigint[])"));
                ph += 1;
                vals.push(ids.into());
            }
        }
    }
    let where_sql = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
    let res: Result<Response, sea_orm::DbErr> = (async {
        let total: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::bigint AS total FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id {where_sql}"),
                vals.clone(),
            ))
            .await?
            .map(|r| r.try_get::<i64>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let mut dvals = vals.clone();
        dvals.push(size.into());
        dvals.push((page * size).into());
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {CONFIG_COLUMNS} FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id {where_sql} ORDER BY {sort_col} {dir}, c.id DESC LIMIT ${ph} OFFSET ${}", ph + 1, ph = ph),
                dvals,
            ))
            .await?;
        let content: Vec<Value> = rows.iter().map(config_dto).collect();
        let total_pages = ((total + size - 1) / size).max(1);
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages,
                "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
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
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn config_by_project(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(project_id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if project_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid project id");
    }
    if user.role == "enduser" && !user.project_ids.contains(&project_id) {
        return err(StatusCode::NOT_FOUND, "AI assistant config not found");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let proj = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, name FROM projects WHERE id = $1",
                vec![project_id.into()],
            ))
            .await?;
        let Some(proj) = proj else {
            return Ok(err(StatusCode::NOT_FOUND, "Project not found"));
        };
        let project_name: String = opt_str(&proj, "name").unwrap_or_else(|| format!("project #{project_id}"));
        let secret = rand_secret_token();
        let pm: Option<i64> = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO project_modules (project_id, module_type) VALUES ($1, 'ai-assistant') ON CONFLICT (project_id, module_type) DO NOTHING RETURNING id",
                vec![project_id.into()],
            ))
            .await?
            .and_then(|r| r.try_get::<i64>("", "id").ok())
            .or_else(|| Some(0));
        let module_id: i64 = match pm {
            Some(0) | None => ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'ai-assistant'",
                    vec![project_id.into()],
                ))
                .await?
                .and_then(|r| r.try_get::<i64>("", "id").ok())
                .unwrap_or(0),
            Some(id) => id,
        };
        let ins = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO ai_assistant_configs (project_id, module_id, name, secret_token) VALUES ($1,$2,$3,$4) ON CONFLICT (project_id) DO NOTHING RETURNING id",
                vec![project_id.into(), module_id.into(), project_name.clone().into(), secret.into()],
            ))
            .await?;
        if ins.is_some() {
            tracing::info!("[ai-assistant] lazy create project={project_id}");
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {CONFIG_COLUMNS} FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id WHERE c.project_id = $1"),
                vec![project_id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("config missing".to_string()))?;
        let mut dto = config_dto(&row);
        dto["projectName"] = json!(project_name);
        Ok((StatusCode::OK, Json(dto)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn scoped_config_project(
    db: &sea_orm::DatabaseConnection,
    user: &CurrentUser,
    id: i64,
) -> Result<Result<i64, Response>, sea_orm::DbErr> {
    let pre = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT project_id FROM ai_assistant_configs WHERE id = $1",
            vec![id.into()],
        ))
        .await?;
    match pre {
        None => Ok(Err(err(StatusCode::NOT_FOUND, "AI assistant config not found"))),
        Some(p) => {
            let pid: i64 = p.try_get("", "project_id").unwrap_or(0);
            if user.role == "enduser" && !user.project_ids.contains(&pid) {
                return Ok(Err(err(StatusCode::NOT_FOUND, "AI assistant config not found")));
            }
            Ok(Ok(pid))
        }
    }
}

async fn get_config(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {CONFIG_COLUMNS} FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id WHERE c.id = $1"),
                vec![id.into()],
            ))
            .await?;
        match row {
            Some(r) => {
                let mut dto = config_dto(&r);
                dto["translations"] = json!(translations_for(&ctx.db, id).await?);
                Ok((StatusCode::OK, Json(dto)).into_response())
            }
            None => Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found")),
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn update_config(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let translations = body.get("translations").and_then(|v| v.as_array()).cloned();
    let fields = match validate_config_body(&body, true) {
        Ok(f) => f,
        Err(e) => return err(StatusCode::BAD_REQUEST, e),
    };
    if fields.is_empty() && translations.is_none() {
        return err(StatusCode::BAD_REQUEST, "No updatable fields provided");
    }
    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => return db_err(e),
    };
    let res: Result<Response, sea_orm::DbErr> = (async {
        if !fields.is_empty() {
            let mut sets: Vec<String> = vec![];
            let mut vals: Vec<sea_orm::Value> = vec![id.into()];
            let mut ph = 2;
            let mut cols: Vec<String> = fields.keys().cloned().collect();
            cols.sort();
            for c in &cols {
                sets.push(format!("{c} = ${ph}"));
                ph += 1;
                vals.push(fields[c].clone());
            }
            sets.push("updated_at = now()".to_string());
            let n = txn
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    format!("UPDATE ai_assistant_configs SET {} WHERE id = $1", sets.join(", ")),
                    vals,
                ))
                .await?;
            if n.rows_affected() == 0 {
                txn.rollback().await.ok();
                return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
            }
        } else {
            let ex: Option<sea_orm::QueryResult> = txn
                .query_one_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "SELECT id FROM ai_assistant_configs WHERE id = $1",
                    vec![id.into()],
                ))
                .await?;
            if ex.is_none() {
                txn.rollback().await.ok();
                return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
            }
        }
        if let Some(trs) = translations {
            for t in &trs {
                if t.get("_delete").and_then(|v| v.as_bool()).unwrap_or(false) {
                    if let Some(tid) = t.get("id").and_then(|v| v.as_i64()) {
                        txn.execute_raw(Statement::from_sql_and_values(
                            sea_orm::DatabaseBackend::Postgres,
                            "DELETE FROM ai_assistant_translations WHERE id = $1 AND assistant_id = $2",
                            vec![tid.into(), id.into()],
                        ))
                        .await?;
                    }
                    continue;
                }
                if let Some(tid) = t.get("id").and_then(|v| v.as_i64()) {
                    let lang = t.get("language").and_then(|v| v.as_str()).unwrap_or("en").to_string();
                    txn.execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "UPDATE ai_assistant_translations SET display_name = $1, greeting_message = $2, placeholder = $3, language = $4, updated_at = NOW() WHERE id = $5 AND assistant_id = $6",
                        vec![
                            t.get("displayName").or_else(|| t.get("display_name")).and_then(|v| v.as_str()).into(),
                            t.get("greetingMessage").or_else(|| t.get("greeting_message")).and_then(|v| v.as_str()).into(),
                            t.get("placeholder").and_then(|v| v.as_str()).into(),
                            lang.into(),
                            tid.into(),
                            id.into(),
                        ],
                    ))
                    .await?;
                } else if let Some(lang) = t.get("language").and_then(|v| v.as_str()) {
                    txn.execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO ai_assistant_translations (assistant_id, language, display_name, greeting_message, placeholder) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (assistant_id, language) DO UPDATE SET display_name = EXCLUDED.display_name, greeting_message = EXCLUDED.greeting_message, placeholder = EXCLUDED.placeholder, updated_at = NOW()",
                        vec![
                            id.into(),
                            lang.to_string().into(),
                            t.get("displayName").or_else(|| t.get("display_name")).and_then(|v| v.as_str()).into(),
                            t.get("greetingMessage").or_else(|| t.get("greeting_message")).and_then(|v| v.as_str()).into(),
                            t.get("placeholder").and_then(|v| v.as_str()).into(),
                        ],
                    ))
                    .await?;
                }
            }
        }
        txn.commit().await?;
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {CONFIG_COLUMNS} FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id WHERE c.id = $1"),
                vec![id.into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("re-read failed".to_string()))?;
        let mut dto = config_dto(&row);
        dto["translations"] = json!(translations_for(&ctx.db, id).await?);
        tracing::info!("[ai-assistant] assistant.update id={id}");
        Ok((StatusCode::OK, Json(dto)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_config(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let n = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM ai_assistant_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        if n.rows_affected() == 0 {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        }
        tracing::info!("[ai-assistant] assistant.delete id={id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn snippet(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT name, secret_token, default_language, allowed_origins FROM ai_assistant_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        let Some(r) = row else {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        };
        let origin = std::env::var("APP_PUBLIC_URL").unwrap_or_else(|_| {
            let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("localhost");
            format!("http://{host}")
        });
        let name = opt_str(&r, "name").unwrap_or_default();
        let secret = opt_str(&r, "secret_token").unwrap_or_default();
        let lang = opt_str(&r, "default_language").unwrap_or_else(|| "en".to_string());
        let script_url = format!("{origin}/api/public/ai-assistant/{secret}/script.js");
        let html = format!("<!-- AI Assistant \"{name}\" -->\n<script src=\"{script_url}\" data-lang=\"{lang}\" defer></script>");
        let origins: Vec<String> = str_arr(&r, "allowed_origins");
        Ok((
            StatusCode::OK,
            Json(json!({
                "html": html,
                "scriptUrl": script_url,
                "secretToken": secret,
                "defaultLanguage": lang,
                "origin": origin,
                "allowedOrigins": origins,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

fn doc_dto(r: &sea_orm::QueryResult) -> Value {
    json!({
        "id": r.try_get::<i64>("", "id").unwrap_or(0),
        "assistantId": r.try_get::<i64>("", "assistant_id").unwrap_or(0),
        "filename": opt_str(r, "filename"),
        "originalFilename": opt_str(r, "original_filename"),
        "fileType": opt_str(r, "file_type"),
        "fileSizeBytes": r.try_get::<i64>("", "file_size_bytes").unwrap_or(0),
        "status": opt_str(r, "status").unwrap_or_else(|| "processing".to_string()),
        "errorMessage": opt_str(r, "error_message"),
        "chunkCount": r.try_get::<i32>("", "chunk_count").unwrap_or(0),
        "createdAt": ts(r, "created_at"),
        "updatedAt": ts(r, "updated_at"),
    })
}

const DOC_COLS: &str = "id, assistant_id, filename, original_filename, file_type, file_size_bytes, status, error_message, chunk_count, created_at, updated_at";

async fn list_knowledge(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT {DOC_COLS} FROM ai_knowledge_base WHERE assistant_id = $1 ORDER BY created_at DESC"),
                vec![id.into()],
            ))
            .await?;
        Ok((StatusCode::OK, Json(rows.iter().map(doc_dto).collect::<Vec<_>>())).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

/// Naive paragraph chunker: ~2000 chars with ~200 overlap, preferring
/// newline / sentence breaks (mirrors chunkText in ai-knowledge-worker.js).
fn chunk_text(text: &str) -> Vec<String> {
    const SIZE: usize = 2000;
    const OVERLAP: usize = 200;
    let chars: Vec<char> = text.chars().collect();
    let mut out = vec![];
    let mut start = 0;
    while start < chars.len() {
        let mut end = (start + SIZE).min(chars.len());
        if end < chars.len() {
            let win_start = end.saturating_sub(200).max(start);
            let window: String = chars[win_start..end].iter().collect();
            let nl = window.rfind('\n');
            let per = window.rfind(". ");
            let bp = match (nl, per) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (Some(a), None) => Some(a),
                (None, Some(b)) => Some(b),
                _ => None,
            };
            if let Some(p) = bp {
                if p > 50 {
                    end = win_start + p + 1;
                }
            }
        }
        let chunk: String = chars[start..end].iter().collect();
        if !chunk.trim().is_empty() {
            out.push(chunk);
        }
        if end >= chars.len() {
            break;
        }
        start = (end.saturating_sub(OVERLAP)).max(start + 1);
    }
    out
}

async fn has_pgvector(db: &sea_orm::DatabaseConnection) -> bool {
    db.query_one_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT 1 AS one FROM pg_type WHERE typname = 'vector'",
        vec![],
    ))
    .await
    .ok()
    .flatten()
    .is_some()
}

async fn embed_batch(base_url: &str, api_key: &str, model: &str, inputs: &[String], session: &str) -> Result<Vec<Vec<f32>>, String> {
    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    let mut all: Vec<Vec<f32>> = vec![];
    for batch in inputs.chunks(20) {
        let resp = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {api_key}"))
            .header("User-Agent", "contact-system-ai-assistant/1.0")
            .header("x-opencode-session", session)
            .json(&json!({ "model": model, "input": batch }))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            let t = resp.text().await.unwrap_or_default();
            return Err(format!("Embeddings API error: {}", t.chars().take(500).collect::<String>()));
        }
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        let data = v.get("data").and_then(|d| d.as_array()).ok_or("bad embeddings response")?;
        for item in data {
            let emb: Vec<f32> = item
                .get("embedding")
                .and_then(|e| e.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_f64().map(|n| n as f32)).collect())
                .unwrap_or_default();
            all.push(emb);
        }
    }
    Ok(all)
}

async fn mark_failed(db: &sea_orm::DatabaseConnection, document_id: i64, file_path: &str, msg: String) {
    let _ = db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE ai_knowledge_base SET status = 'error', error_message = $2, updated_at = NOW() WHERE id = $1",
            vec![document_id.into(), msg.into()],
        ))
        .await;
    let _ = tokio::fs::remove_file(file_path).await;
}

async fn process_document(db: sea_orm::DatabaseConnection, document_id: i64, assistant_id: i64, file_path: String, file_type: String) {
    // 1. extract
    let text: String = if [".txt", ".md", ".csv"].contains(&file_type.as_str()) {
        match tokio::fs::read_to_string(&file_path).await {
            Ok(t) => t,
            Err(e) => {
                mark_failed(&db, document_id, &file_path, format!("read failed: {e}")).await;
                return;
            }
        }
    } else {
        mark_failed(&db, document_id, &file_path, format!("Unsupported file type: {file_type} (PDF/DOCX extraction libraries unavailable; upload .txt/.md/.csv instead)")).await;
        return;
    };
    if text.trim().is_empty() {
        mark_failed(&db, document_id, &file_path, "Document contains no extractable text".to_string()).await;
        return;
    }
    let chunks = chunk_text(&text);
    if chunks.is_empty() {
        mark_failed(&db, document_id, &file_path, "Document produced no chunks after processing".to_string()).await;
        return;
    }
    // 2. embedding credentials: env first, then assistant config
    let mut base_url = std::env::var("AI_EMBEDDING_BASE_URL").unwrap_or_default();
    let mut api_key = std::env::var("AI_EMBEDDING_API_KEY").unwrap_or_default();
    let model = std::env::var("AI_EMBEDDING_MODEL").unwrap_or_else(|_| "text-embedding-3-small".to_string());
    if base_url.is_empty() || api_key.is_empty() {
        if let Ok(Some(row)) = db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT base_url, api_key_enc FROM ai_assistant_configs WHERE id = $1",
                vec![assistant_id.into()],
            ))
            .await
        {
            if base_url.is_empty() {
                base_url = opt_str(&row, "base_url").unwrap_or_default();
            }
            if api_key.is_empty() {
                match resolve_api_key(opt_str(&row, "api_key_enc")) {
                    KeyState::Ready(k) => api_key = k,
                    _ => {}
                }
            }
        }
    }
    // 3. embeddings (or NULL when no key — keyword fallback documented)
    let mut embeddings: Vec<Option<String>> = vec![None; chunks.len()];
    if !api_key.is_empty() && !base_url.is_empty() {
        match embed_batch(&base_url, &api_key, &model, &chunks, &format!("knowledge-assistant-{assistant_id}")).await {
            Ok(vecs) if vecs.len() == chunks.len() => {
                for (i, v) in vecs.into_iter().enumerate() {
                    embeddings[i] = Some(format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(",")));
                }
            }
            Ok(_) => {
                mark_failed(&db, document_id, &file_path, "Embedding count mismatch".to_string()).await;
                return;
            }
            Err(e) => {
                mark_failed(&db, document_id, &file_path, format!("Embeddings failed: {e}")).await;
                return;
            }
        }
    }
    // 4. insert
    let vector = has_pgvector(&db).await;
    let txn = match db.begin().await {
        Ok(t) => t,
        Err(_) => {
            mark_failed(&db, document_id, &file_path, "DB transaction failed".to_string()).await;
            return;
        }
    };
    let sql = if vector {
        "INSERT INTO ai_knowledge_chunks (document_id, assistant_id, chunk_index, content, embedding, token_count) VALUES ($1,$2,$3,$4,$5::vector,$6)"
    } else {
        "INSERT INTO ai_knowledge_chunks (document_id, assistant_id, chunk_index, content, embedding, token_count) VALUES ($1,$2,$3,$4,$5,$6)"
    };
    for (i, chunk) in chunks.iter().enumerate() {
        let tokens = (chunk.len() as f64 / 4.0).ceil() as i32;
        let r = txn
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                sql,
                vec![
                    document_id.into(),
                    assistant_id.into(),
                    (i as i32).into(),
                    chunk.clone().into(),
                    embeddings[i].clone().into(),
                    tokens.into(),
                ],
            ))
            .await;
        if r.is_err() {
            txn.rollback().await.ok();
            mark_failed(&db, document_id, &file_path, "Chunk insert failed (pgvector dimension mismatch?)".to_string()).await;
            return;
        }
    }
    if txn.commit().await.is_err() {
        mark_failed(&db, document_id, &file_path, "DB commit failed".to_string()).await;
        return;
    }
    let _ = db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE ai_knowledge_base SET status = 'ready', error_message = NULL, chunk_count = $2, updated_at = NOW() WHERE id = $1",
            vec![document_id.into(), (chunks.len() as i32).into()],
        ))
        .await;
    let _ = tokio::fs::remove_file(&file_path).await;
    tracing::info!("[ai-assistant] knowledge ready doc={document_id} chunks={}", chunks.len());
}

async fn upload_knowledge(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    mut multipart: Multipart,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let cfg = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, project_id, max_upload_size_mb FROM ai_assistant_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        let Some(cfg) = cfg else {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        };
        let max_mb: i64 = cfg.try_get::<i32>("", "max_upload_size_mb").unwrap_or(20) as i64;
        let mut file: Option<(String, Vec<u8>)> = None;
        while let Ok(Some(field)) = multipart.next_field().await {
            if field.name().unwrap_or("") != "file" {
                continue;
            }
            let fname = field.file_name().unwrap_or("upload").to_string();
            match field.bytes().await {
                Ok(b) => {
                    file = Some((fname, b.to_vec()));
                    break;
                }
                Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "Upload failed")),
            }
        }
        let Some((orig, bytes)) = file else {
            return Ok(err(StatusCode::BAD_REQUEST, "No file provided"));
        };
        if bytes.len() as i64 > max_mb * 1024 * 1024 {
            return Ok(err(StatusCode::BAD_REQUEST, format!("File too large. Maximum size is {max_mb} MB")));
        }
        let ext = format!(".{}", orig.rsplit('.').next().unwrap_or("").to_lowercase());
        if ![".txt", ".md", ".pdf", ".docx", ".csv"].contains(&ext.as_str()) {
            return Ok(err(StatusCode::BAD_REQUEST, format!("Unsupported extension: {ext}. Allowed: .txt, .md, .pdf, .docx, .csv")));
        }
        let dir = std::env::var("AI_ASSISTANT_UPLOAD_DIR").unwrap_or_else(|_| "./uploads/ai-assistant".to_string());
        if let Err(e) = std::fs::create_dir_all(&dir) {
            tracing::error!("[ai-assistant] mkdir {e:?}");
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error"));
        }
        let stored = format!("{id}_{}_{orig}", chrono::Utc::now().timestamp_millis());
        let safe: String = stored.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect();
        let path = std::path::Path::new(&dir).join(&safe);
        if std::fs::write(&path, &bytes).is_err() {
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store upload"));
        }
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("INSERT INTO ai_knowledge_base (assistant_id, filename, original_filename, file_type, file_size_bytes, status) VALUES ($1,$2,$3,$4,$5,'processing') RETURNING {DOC_COLS}"),
                vec![id.into(), safe.into(), orig.into(), ext.clone().into(), (bytes.len() as i64).into()],
            ))
            .await?
            .ok_or(sea_orm::DbErr::RecordNotFound("insert failed".to_string()))?;
        let doc_id: i64 = row.try_get("", "id").unwrap_or(0);
        tracing::info!("[ai-assistant] knowledge.upload doc={doc_id}");
        let db = ctx.db.clone();
        let path_s = path.to_string_lossy().to_string();
        tokio::spawn(async move {
            process_document(db, doc_id, id, path_s, ext).await;
        });
        Ok((StatusCode::CREATED, Json(doc_dto(&row))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn list_chunks(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((id, doc_id)): Path<(i64, i64)>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    if doc_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid document id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let doc = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, original_filename, file_type, chunk_count, status FROM ai_knowledge_base WHERE id = $1 AND assistant_id = $2",
                vec![doc_id.into(), id.into()],
            ))
            .await?;
        let Some(doc) = doc else {
            return Ok(err(StatusCode::NOT_FOUND, "Document not found"));
        };
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, chunk_index, content, token_count, created_at FROM ai_knowledge_chunks WHERE document_id = $1 AND assistant_id = $2 ORDER BY chunk_index ASC",
                vec![doc_id.into(), id.into()],
            ))
            .await?;
        let chunks: Vec<Value> = rows
            .iter()
            .map(|c| {
                json!({
                    "id": c.try_get::<i64>("", "id").unwrap_or(0),
                    "chunkIndex": c.try_get::<i32>("", "chunk_index").unwrap_or(0),
                    "content": opt_str(c, "content"),
                    "tokenCount": c.try_get::<i32>("", "token_count").unwrap_or(0),
                    "createdAt": ts(c, "created_at"),
                })
            })
            .collect();
        Ok((
            StatusCode::OK,
            Json(json!({
                "document": {
                    "id": doc.try_get::<i64>("", "id").unwrap_or(0),
                    "originalFilename": opt_str(&doc, "original_filename"),
                    "fileType": opt_str(&doc, "file_type"),
                    "chunkCount": doc.try_get::<i32>("", "chunk_count").unwrap_or(0),
                    "status": opt_str(&doc, "status"),
                },
                "chunks": chunks,
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_knowledge(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((id, doc_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    if doc_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid document id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let n = ctx
            .db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "DELETE FROM ai_knowledge_base WHERE id = $1 AND assistant_id = $2",
                vec![doc_id.into(), id.into()],
            ))
            .await?;
        if n.rows_affected() == 0 {
            return Ok(err(StatusCode::NOT_FOUND, "Document not found"));
        }
        tracing::info!("[ai-assistant] knowledge.delete doc={doc_id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------

fn avatar_dir() -> String {
    std::env::var("AI_ASSISTANT_AVATAR_DIR").unwrap_or_else(|_| "./uploads/ai-assistant-avatars".to_string())
}

async fn upload_avatar(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&_user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let cfg = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM ai_assistant_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        if cfg.is_none() {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        }
        let mut file: Option<(String, Vec<u8>)> = None;
        while let Ok(Some(field)) = multipart.next_field().await {
            if field.name().unwrap_or("") != "file" {
                continue;
            }
            let fname = field.file_name().unwrap_or("upload").to_string();
            match field.bytes().await {
                Ok(b) => {
                    file = Some((fname, b.to_vec()));
                    break;
                }
                Err(_) => return Ok(err(StatusCode::BAD_REQUEST, "Upload failed")),
            }
        }
        let Some((orig, bytes)) = file else {
            return Ok(err(StatusCode::BAD_REQUEST, "No file provided"));
        };
        if bytes.len() > 2 * 1024 * 1024 {
            return Ok(err(StatusCode::BAD_REQUEST, "File exceeds 2 MB limit"));
        }
        let ext = format!(".{}", orig.rsplit('.').next().unwrap_or("").to_lowercase());
        if ![".webp", ".png", ".jpg", ".jpeg", ".avif"].contains(&ext.as_str()) {
            return Ok(err(StatusCode::BAD_REQUEST, "Unsupported image type. Allowed: webp, png, jpg, avif"));
        }
        let dir = avatar_dir();
        if std::fs::create_dir_all(&dir).is_err() {
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store avatar file"));
        }
        let stored = format!("assistant_{id}_avatar{ext}");
        if std::fs::write(std::path::Path::new(&dir).join(&stored), &bytes).is_err() {
            return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to store avatar file"));
        }
        let origin = std::env::var("APP_PUBLIC_URL").unwrap_or_else(|_| {
            let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("localhost");
            format!("http://{host}")
        });
        let url = format!("{origin}/uploads/ai-assistant-avatars/{stored}");
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE ai_assistant_configs SET avatar_url = $1, updated_at = NOW() WHERE id = $2",
                vec![url.clone().into(), id.into()],
            ))
            .await?;
        tracing::info!("[ai-assistant] avatar.upload id={id}");
        Ok((StatusCode::OK, Json(json!({ "avatarUrl": url }))).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn delete_avatar(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
) -> Response {
    let _user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if let Some(r) = forbid_enduser_mutation(&_user) {
        return r;
    }
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT avatar_url FROM ai_assistant_configs WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        let Some(row) = row else {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        };
        if let Some(url) = opt_str(&row, "avatar_url") {
            if let Some(name) = url.rsplit('/').next() {
                let _ = std::fs::remove_file(std::path::Path::new(&avatar_dir()).join(name));
            }
        }
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "UPDATE ai_assistant_configs SET avatar_url = NULL, updated_at = NOW() WHERE id = $1",
                vec![id.into()],
            ))
            .await?;
        tracing::info!("[ai-assistant] avatar.delete id={id}");
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Sessions / messages (read-only)
// ---------------------------------------------------------------------------

async fn list_sessions(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    MultiQuery(q): MultiQuery,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let one = |k: &str| q.get(k).and_then(|v| v.first()).cloned();
    let page = one("page").and_then(|s| s.parse::<i64>().ok()).unwrap_or(0).max(0);
    let size = one("size").and_then(|s| s.parse::<i64>().ok()).unwrap_or(20).clamp(1, 100);
    let mut raw_terms: Vec<String> = q.get("queries").cloned().unwrap_or_default();
    if let Some(extra) = q.get("queries[]") {
        raw_terms.extend(extra.clone());
    }
    let terms: Vec<String> = raw_terms.into_iter().filter(|t| !t.trim().is_empty()).collect();
    let sort_field = one("sortField");
    let sort_order = one("sortOrder");
    let sort_col = match sort_field.as_deref() {
        Some("language") => "s.language",
        Some("sessionId") => "s.session_id",
        _ => "s.created_at",
    };
    let dir = if sort_order.as_deref() == Some("asc") { "ASC" } else { "DESC" };
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let mut search_sql = String::new();
        let mut svals: Vec<sea_orm::Value> = vec![];
        if !terms.is_empty() {
            let mut parts: Vec<String> = vec![];
            for t in &terms {
                svals.push(format!("%{t}%").into());
                let p = svals.len() + 1;
                parts.push(format!("(s.session_id ILIKE ${p} OR s.visitor_id ILIKE ${p} OR s.language ILIKE ${p} OR s.ip_address::text ILIKE ${p} OR EXISTS (SELECT 1 FROM ai_chat_messages cm WHERE cm.session_id = s.id AND cm.content ILIKE ${p}))"));
            }
            search_sql = format!(" AND ({})", parts.join(" OR "));
        }
        let total: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT COUNT(*)::bigint AS total FROM ai_chat_sessions s WHERE s.assistant_id = $1{search_sql}"),
                {
                    let mut v = vec![id.into()];
                    v.extend(svals.clone());
                    v
                },
            ))
            .await?
            .map(|r| r.try_get::<i64>("", "total").unwrap_or(0))
            .unwrap_or(0);
        let mut dvals: Vec<sea_orm::Value> = vec![id.into()];
        dvals.extend(svals);
        let lim = dvals.len() + 1;
        let off = dvals.len() + 2;
        dvals.push(size.into());
        dvals.push((page * size).into());
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                format!("SELECT s.id, s.assistant_id, s.session_id, s.visitor_id, s.language, s.ip_address::text AS ip_address, s.user_agent, s.created_at, s.updated_at, COALESCE(m.cnt, 0)::int AS message_count FROM ai_chat_sessions s LEFT JOIN (SELECT session_id, COUNT(*)::int AS cnt FROM ai_chat_messages WHERE assistant_id = $1 GROUP BY session_id) m ON m.session_id = s.id WHERE s.assistant_id = $1{search_sql} ORDER BY {sort_col} {dir} LIMIT ${lim} OFFSET ${off}"),
                dvals,
            ))
            .await?;
        let content: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<i64>("", "id").unwrap_or(0),
                    "assistantId": r.try_get::<i64>("", "assistant_id").unwrap_or(0),
                    "sessionId": opt_str(r, "session_id"),
                    "visitorId": opt_str(r, "visitor_id"),
                    "language": opt_str(r, "language").unwrap_or_else(|| "en".to_string()),
                    "ipAddress": opt_str(r, "ip_address"),
                    "userAgent": opt_str(r, "user_agent"),
                    "messageCount": r.try_get::<i32>("", "message_count").unwrap_or(0),
                    "createdAt": ts(r, "created_at"),
                    "updatedAt": ts(r, "updated_at"),
                })
            })
            .collect();
        let total_pages = ((total + size - 1) / size).max(1);
        Ok((
            StatusCode::OK,
            Json(json!({
                "totalPages": total_pages,
                "totalElements": total,
                "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": page * size, "sort": { "sorted": true, "unsorted": false, "empty": false } },
                "numberOfElements": content.len(),
                "size": size,
                "content": content,
                "number": page,
                "sort": { "sorted": true, "unsorted": false, "empty": false },
                "first": page == 0,
                "last": page == total_pages - 1,
                "empty": content.is_empty(),
            })),
        )
            .into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

async fn session_messages(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path((id, session_id)): Path<(i64, i64)>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    if session_id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid session id");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let chk = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM ai_chat_sessions WHERE id = $1 AND assistant_id = $2",
                vec![session_id.into(), id.into()],
            ))
            .await?;
        if chk.is_none() {
            return Ok(err(StatusCode::NOT_FOUND, "Session not found"));
        }
        let rows = ctx
            .db
            .query_all_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, session_id, assistant_id, role, content, language, tokens_used, rag_sources, created_at FROM ai_chat_messages WHERE session_id = $1 AND assistant_id = $2 ORDER BY created_at ASC",
                vec![session_id.into(), id.into()],
            ))
            .await?;
        let out: Vec<Value> = rows
            .iter()
            .map(|r| {
                json!({
                    "id": r.try_get::<i64>("", "id").unwrap_or(0),
                    "sessionId": r.try_get::<i64>("", "session_id").unwrap_or(0),
                    "assistantId": r.try_get::<i64>("", "assistant_id").unwrap_or(0),
                    "role": opt_str(r, "role"),
                    "content": opt_str(r, "content"),
                    "language": opt_str(r, "language").unwrap_or_else(|| "en".to_string()),
                    "tokensUsed": r.try_get::<i32>("", "tokens_used").unwrap_or(0),
                    "ragSources": r.try_get::<Option<Value>>("", "rag_sources").ok().flatten(),
                    "createdAt": ts(r, "created_at"),
                })
            })
            .collect();
        Ok((StatusCode::OK, Json(out)).into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

// ---------------------------------------------------------------------------
// Shared RAG + LLM (pub(crate) for the public embed)
// ---------------------------------------------------------------------------

pub(crate) struct ChatConfig {
    #[allow(dead_code)]
    pub(crate) id: i64,
    pub(crate) base_prompt: String,
    pub(crate) model: String,
    pub(crate) base_url: String,
    pub(crate) api_key_enc: Option<String>,
    pub(crate) default_language: String,
}

pub(crate) async fn load_chat_config(
    db: &sea_orm::DatabaseConnection,
    assistant_id: i64,
) -> Result<Option<ChatConfig>, sea_orm::DbErr> {
    let row = db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, base_prompt, model, base_url, api_key_enc, default_language FROM ai_assistant_configs WHERE id = $1 AND status = 'active'",
            vec![assistant_id.into()],
        ))
        .await?;
    Ok(row.map(|r| ChatConfig {
        id: r.try_get("", "id").unwrap_or(0),
        base_prompt: opt_str(&r, "base_prompt").unwrap_or_else(|| "You are a helpful assistant.".to_string()),
        model: opt_str(&r, "model").unwrap_or_else(|| "gpt-4o".to_string()),
        base_url: opt_str(&r, "base_url").unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        api_key_enc: opt_str(&r, "api_key_enc"),
        default_language: opt_str(&r, "default_language").unwrap_or_else(|| "en".to_string()),
    }))
}

/// RAG retrieval: vector search when an embedding key resolves, else
/// keyword (ILIKE) fallback. Returns (context_block, sources).
pub(crate) async fn rag_search(
    db: &sea_orm::DatabaseConnection,
    assistant_id: i64,
    query: &str,
    top_k: i64,
) -> (String, Vec<Value>) {
    // embedding credentials: dedicated env first, then assistant config
    let emb_base = std::env::var("AI_EMBEDDING_BASE_URL").unwrap_or_default();
    let emb_key = std::env::var("AI_EMBEDDING_API_KEY").unwrap_or_default();
    let emb_model = std::env::var("AI_EMBEDDING_MODEL").unwrap_or_else(|_| "text-embedding-3-small".to_string());
    let (mut base_url, mut api_key) = (emb_base, emb_key);
    if base_url.is_empty() || api_key.is_empty() {
        if let Ok(Some(cfg)) = load_chat_config(db, assistant_id).await {
            if base_url.is_empty() {
                base_url = cfg.base_url;
            }
            if api_key.is_empty() {
                if let KeyState::Ready(k) = resolve_api_key(cfg.api_key_enc) {
                    api_key = k;
                }
            }
        }
    }
    if !base_url.is_empty() && !api_key.is_empty() {
        match embed_batch(&base_url, &api_key, &emb_model, &[query.to_string()], "rag-query").await {
            Ok(vecs) if !vecs.is_empty() && !vecs[0].is_empty() => {
                let lit = format!("[{}]", vecs[0].iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
                let rows = db
                    .query_all_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "SELECT c.document_id, c.content, c.chunk_index, (c.embedding <=> $1::vector)::float8 AS distance, d.original_filename AS filename FROM ai_knowledge_chunks c JOIN ai_knowledge_base d ON d.id = c.document_id WHERE c.assistant_id = $2 ORDER BY distance ASC LIMIT $3",
                        vec![lit.into(), assistant_id.into(), top_k.into()],
                    ))
                    .await;
                if let Ok(rows) = rows {
                    if !rows.is_empty() {
                        let ctx_block = "\n\nRelevant knowledge base context:\n".to_string()
                            + &rows
                                .iter()
                                .enumerate()
                                .map(|(i, r)| format!("[{}] {}", i + 1, opt_str(r, "content").unwrap_or_default()))
                                .collect::<Vec<_>>()
                                .join("\n\n");
                        let sources: Vec<Value> = rows
                            .iter()
                            .map(|r| {
                                json!({
                                    "documentId": r.try_get::<i64>("", "document_id").unwrap_or(0),
                                    "filename": opt_str(r, "filename"),
                                    "chunkContent": opt_str(r, "content").unwrap_or_default().chars().take(200).collect::<String>(),
                                })
                            })
                            .collect();
                        return (ctx_block, sources);
                    }
                    return (String::new(), vec![]);
                }
                // vector search failed (e.g. pgvector missing) → fall through
            }
            _ => {}
        }
    }
    // keyword fallback
    let rows = db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT c.document_id, c.content, c.chunk_index, d.original_filename AS filename FROM ai_knowledge_chunks c JOIN ai_knowledge_base d ON d.id = c.document_id WHERE c.assistant_id = $1 AND c.content ILIKE $2 ORDER BY c.chunk_index ASC LIMIT $3",
            vec![assistant_id.into(), format!("%{query}%").into(), top_k.into()],
        ))
        .await
        .unwrap_or_default();
    if rows.is_empty() {
        return (String::new(), vec![]);
    }
    let ctx_block = "\n\nRelevant knowledge base context:\n".to_string()
        + &rows
            .iter()
            .enumerate()
            .map(|(i, r)| format!("[{}] {}", i + 1, opt_str(r, "content").unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("\n\n");
    let sources: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "documentId": r.try_get::<i64>("", "document_id").unwrap_or(0),
                "filename": opt_str(r, "filename"),
                "chunkContent": opt_str(r, "content").unwrap_or_default().chars().take(200).collect::<String>(),
            })
        })
        .collect();
    (ctx_block, sources)
}

fn chat_url(base_url: &str) -> Result<String, String> {
    let b = base_url.trim_end_matches('/').to_string();
    if b.ends_with("/responses") || b.ends_with("/messages") {
        return Err("this client speaks OpenAI chat-completions only; baseUrl points at an unsupported endpoint".to_string());
    }
    if b.ends_with("/chat/completions") {
        Ok(b)
    } else {
        Ok(format!("{b}/chat/completions"))
    }
}

/// Non-streaming chat completion (buffered; see header re: `stream`).
/// Returns (full_text, total_tokens).
pub(crate) async fn llm_complete(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    session: &str,
    timeout_ms: u64,
) -> Result<(String, i64), String> {
    let url = chat_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("User-Agent", "contact-system-ai-assistant/1.0");
    if !session.is_empty() {
        req = req.header("x-opencode-session", session);
    }
    let resp = req
        .json(&json!({ "model": model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("LLM API error: {}", t.chars().take(500).collect::<String>()));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    let tokens = v.get("usage").and_then(|u| u.get("total_tokens")).and_then(|t| t.as_i64()).unwrap_or(0);
    Ok((text, tokens))
}

/// Buffered SSE parse: POSTs with stream:true, reads the whole SSE body,
/// and returns the ordered text deltas + usage (embed replays them as SSE).
pub(crate) async fn llm_stream_buffered(
    base_url: &str,
    api_key: &str,
    model: &str,
    messages: &[Value],
    session: &str,
    timeout_ms: u64,
) -> Result<(Vec<String>, i64), String> {
    let url = chat_url(base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .header("User-Agent", "contact-system-ai-assistant/1.0")
        .header("Accept", "text/event-stream");
    if !session.is_empty() {
        req = req.header("x-opencode-session", session);
    }
    let resp = req
        .json(&json!({ "model": model, "messages": messages, "stream": true }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        let t = resp.text().await.unwrap_or_default();
        return Err(format!("LLM API error: {}", t.chars().take(500).collect::<String>()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let mut deltas: Vec<String> = vec![];
    let mut tokens: i64 = 0;
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t == "data: [DONE]" {
            continue;
        }
        let Some(payload) = t.strip_prefix("data: ") else { continue };
        let Ok(chunk) = serde_json::from_str::<Value>(payload) else { continue };
        if let Some(c) = chunk.get("choices").and_then(|c| c.get(0)).and_then(|c| c.get("delta")).and_then(|d| d.get("content")).and_then(|c| c.as_str()) {
            deltas.push(c.to_string());
        }
        if let Some(u) = chunk.get("usage").and_then(|u| u.get("total_tokens")).and_then(|t| t.as_i64()) {
            tokens = u;
        }
    }
    Ok((deltas, tokens))
}

// ---------------------------------------------------------------------------
// POST /:id/test-chat (NEW — see header)
// ---------------------------------------------------------------------------

async fn test_chat(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> Response {
    let user = match auth_required(&u) {
        Ok(x) => x,
        Err(r) => return r,
    };
    if id <= 0 {
        return err(StatusCode::BAD_REQUEST, "Invalid id");
    }
    let message = body.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if message.is_empty() || message.len() > 2000 {
        return err(StatusCode::BAD_REQUEST, "Message must be 1..2000 characters");
    }
    let res: Result<Response, sea_orm::DbErr> = (async {
        match scoped_config_project(&ctx.db, &user, id).await? {
            Err(r) => return Ok(r),
            Ok(_) => {}
        }
        let Some(cfg) = load_chat_config(&ctx.db, id).await? else {
            return Ok(err(StatusCode::NOT_FOUND, "AI assistant config not found"));
        };
        let api_key = match resolve_api_key(cfg.api_key_enc) {
            KeyState::Ready(k) => k,
            KeyState::Missing => return Ok(err(StatusCode::BAD_REQUEST, "AI configuration is not properly set up.")),
            KeyState::EncryptedUnavailable => {
                return Ok(err(StatusCode::INTERNAL_SERVER_ERROR, "encryption unavailable: cannot decrypt stored API key (re-save the key to continue)"))
            }
        };
        let lang = body
            .get("lang")
            .and_then(|v| v.as_str())
            .filter(|s| s.len() >= 2 && s.len() <= 10)
            .unwrap_or(&cfg.default_language)
            .to_string();
        let (rag_ctx, sources) = rag_search(&ctx.db, id, &message, 5).await;
        let system = format!("{}{}\n\nRespond in {lang}.", cfg.base_prompt, rag_ctx);
        let messages = vec![
            json!({ "role": "system", "content": system }),
            json!({ "role": "user", "content": message }),
        ];
        match llm_complete(&cfg.base_url, &api_key, &cfg.model, &messages, &format!("test-{id}"), 30_000).await {
            Ok((reply, tokens)) => Ok((
                StatusCode::OK,
                Json(json!({ "reply": reply, "tokensUsed": tokens, "sources": sources, "language": lang })),
            )
                .into_response()),
            Err(e) => {
                tracing::error!("[ai-assistant/test-chat] {e}");
                Ok(err(StatusCode::BAD_GATEWAY, format!("LLM request failed: {e}")))
            }
        }
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => db_err(e),
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/ai-assistant")
        .add("/", get(list_configs))
        .add("/by-project/{projectId}", get(config_by_project))
        .add("/{id}", get(get_config))
        .add("/{id}", put(update_config))
        .add("/{id}", delete(delete_config))
        .add("/{id}/snippet", get(snippet))
        .add("/{id}/knowledge", get(list_knowledge))
        .add("/{id}/knowledge", post(upload_knowledge))
        .add("/{id}/knowledge/{docId}/chunks", get(list_chunks))
        .add("/{id}/knowledge/{docId}", delete(delete_knowledge))
        .add("/{id}/avatar", post(upload_avatar))
        .add("/{id}/avatar", delete(delete_avatar))
        .add("/{id}/sessions", get(list_sessions))
        .add("/{id}/sessions/{sessionId}", get(session_messages))
        .add("/{id}/test-chat", post(test_chat))
}
