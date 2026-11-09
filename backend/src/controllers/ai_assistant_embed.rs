//! Public AI-assistant embed.
//! Mounted at /api/public/ai-assistant (CSRF-exempt, no auth — the 22-char
//! `secret_token` is the capability).
//!
//! Endpoints:
//! - GET  /:secret_token/script.js — widget loader with placeholders filled
//! - GET  /:secret_token/config — lightweight widget config
//! - POST /:secret_token/chat — RAG + LLM reply as SSE (buffered replay)
//! - POST /:secret_token/language — switch session language
//!
//! Notes / degradations:
//! - The widget JS itself is compile-time embedded from
//!   `public/ai-assistant-widget.js` (`include_str!`) with
//!   `{{PLACEHOLDER}}` values filled server-side.
//! - RAG + LLM + key-resolution logic is shared with the admin
//!   `ai_assistant` controller (`pub(crate)` helpers). SSE is a
//!   server-side-buffered replay (reqwest has no `stream` feature here);
//!   clients still receive valid `text/event-stream` with `[DONE]`.
//! - Encryption: pre-existing AES-256-GCM blobs cannot be decrypted
//!   (`aes-gcm` not in deps); chat with such a config returns the graceful
//!   SSE "AI configuration is not properly set up." message instead of 500.
//! - No rate-limit middleware on these endpoints yet — hardening TODO.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::{json, Value};

use crate::controllers::ai_assistant as A;

const WIDGET_JS: &str = include_str!("../../../public/ai-assistant-widget.js");

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn js_not_found() -> Response {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/javascript")
        .body(Body::from("// not found"))
        .unwrap()
}

fn origin_host(origin: &str) -> Option<String> {
    let o = origin.trim().to_lowercase();
    let no_scheme = o
        .strip_prefix("https://")
        .or_else(|| o.strip_prefix("http://"))
        .unwrap_or(&o);
    let host = no_scheme.split('/').next().unwrap_or("").to_string();
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn is_origin_allowed(request_origin: &str, allowed: &[String]) -> bool {
    if request_origin.is_empty() {
        return false;
    }
    let req_host = match origin_host(request_origin) {
        Some(h) => h,
        None => return false,
    };
    for e in allowed {
        let en = e.trim().trim_end_matches('/').to_lowercase();
        let entry_host = match origin_host(&en) {
            Some(h) => h,
            None => continue,
        };
        if entry_host == req_host {
            return true;
        }
        if let Some(suffix) = en.split_once("*.").map(|x| x.1) {
            let suffix_host = suffix.split('/').next().unwrap_or("").split(':').next().unwrap_or("");
            let req_base = req_host.split(':').next().unwrap_or("");
            if req_base == suffix_host {
                continue;
            }
            if req_base.len() > suffix_host.len() && req_base.ends_with(&format!(".{suffix_host}")) {
                return true;
            }
        }
    }
    false
}

fn parse_origins(row: &sea_orm::QueryResult) -> Vec<String> {
    if let Ok(a) = row.try_get::<Vec<String>>("", "allowed_origins") {
        return a.into_iter().filter(|s| !s.is_empty()).collect();
    }
    if let Ok(Some(s)) = row.try_get::<Option<String>>("", "allowed_origins") {
        if let Ok(a) = serde_json::from_str::<Vec<String>>(&s) {
            return a;
        }
    }
    vec![]
}

fn parse_langs(row: &sea_orm::QueryResult) -> Vec<String> {
    if let Ok(a) = row.try_get::<Vec<String>>("", "supported_languages") {
        if !a.is_empty() {
            return a;
        }
    }
    if let Ok(Some(s)) = row.try_get::<Option<String>>("", "supported_languages") {
        if let Ok(a) = serde_json::from_str::<Vec<String>>(&s) {
            if !a.is_empty() {
                return a;
            }
        }
    }
    vec!["en".to_string()]
}

fn parse_translations(row: &sea_orm::QueryResult) -> Value {
    if let Ok(Some(v)) = row.try_get::<Option<Value>>("", "translations_data") {
        return v;
    }
    if let Ok(Some(s)) = row.try_get::<Option<String>>("", "translations_data") {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            return v;
        }
    }
    json!([])
}

fn opt_str(row: &sea_orm::QueryResult, col: &str) -> Option<String> {
    row.try_get::<Option<String>>("", col).ok().flatten()
}

fn escape_js(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('<', "\\x3c")
}

fn app_origin(headers: &HeaderMap) -> String {
    std::env::var("APP_PUBLIC_URL").unwrap_or_else(|_| {
        let host = headers.get("host").and_then(|v| v.to_str().ok()).unwrap_or("localhost");
        format!("http://{host}")
    })
}

async fn script_js(
    State(ctx): State<AppContext>,
    Path(secret): Path<String>,
    headers: HeaderMap,
) -> Response {
    if secret.len() != 22 {
        return js_not_found();
    }
    let status: Option<String> = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT status FROM ai_assistant_configs WHERE trim(secret_token) = $1",
            vec![secret.clone().into()],
        ))
        .await
        .ok()
        .flatten()
        .and_then(|r| opt_str(&r, "status"));
    if status.as_deref() != Some("active") {
        return js_not_found();
    }
    let row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT c.display_name, c.primary_color, c.secondary_color, c.default_language, c.greeting_message, c.legal_message, c.popup_message, c.position, c.avatar_url, c.supported_languages, (SELECT COALESCE(json_agg(json_build_object('language', t.language, 'displayName', t.display_name, 'greetingMessage', t.greeting_message, 'placeholder', t.placeholder)), '[]'::json) FROM ai_assistant_translations t WHERE t.assistant_id = c.id) AS translations_data FROM ai_assistant_configs c WHERE trim(c.secret_token) = $1",
            vec![secret.clone().into()],
        ))
        .await
        .ok()
        .flatten();
    let Some(cfg) = row else {
        return js_not_found();
    };
    let origin = app_origin(&headers);
    let langs = parse_langs(&cfg);
    let mut script = WIDGET_JS.to_string();
    let rep = [
        ("{{SECRET_TOKEN}}", secret.clone()),
        ("{{BASE_URL}}", origin.clone()),
        ("{{DEFAULT_LANGUAGE}}", opt_str(&cfg, "default_language").unwrap_or_else(|| "en".to_string())),
        ("{{DISPLAY_NAME}}", escape_js(&opt_str(&cfg, "display_name").unwrap_or_else(|| "AI Assistant".to_string()))),
        ("{{PRIMARY_COLOR}}", opt_str(&cfg, "primary_color").unwrap_or_else(|| "#3b82f6".to_string())),
        ("{{SECONDARY_COLOR}}", opt_str(&cfg, "secondary_color").unwrap_or_else(|| "#ffffff".to_string())),
        ("{{GREETING_MESSAGE}}", escape_js(&opt_str(&cfg, "greeting_message").unwrap_or_else(|| "Hello! How can I help you today?".to_string()))),
        ("{{LEGAL_MESSAGE}}", escape_js(&opt_str(&cfg, "legal_message").unwrap_or_default())),
        ("{{POPUP_MESSAGE}}", escape_js(&opt_str(&cfg, "popup_message").unwrap_or_default())),
        ("{{POSITION}}", opt_str(&cfg, "position").unwrap_or_else(|| "bottom-right".to_string())),
        ("{{AVATAR_URL}}", opt_str(&cfg, "avatar_url").unwrap_or_default()),
        ("{{SUPPORTED_LANGUAGES}}", serde_json::to_string(&langs).unwrap_or_else(|_| "[\"en\"]".to_string())),
        ("{{TRANSLATIONS}}", serde_json::to_string(&parse_translations(&cfg)).unwrap_or_else(|_| "[]".to_string())),
    ];
    for (k, v) in rep {
        script = script.replace(k, &v);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "text/javascript")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .header("Cache-Control", "public, max-age=10")
        .body(Body::from(script))
        .unwrap_or_else(|_| js_not_found())
}

async fn public_config(State(ctx): State<AppContext>, Path(secret): Path<String>) -> Response {
    if secret.len() != 22 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT c.*, (SELECT COALESCE(json_agg(json_build_object('language', t.language, 'displayName', t.display_name, 'greetingMessage', t.greeting_message, 'placeholder', t.placeholder)), '[]'::json) FROM ai_assistant_translations t WHERE t.assistant_id = c.id) AS translations_data FROM ai_assistant_configs c WHERE trim(c.secret_token) = $1 AND c.status = 'active'",
            vec![secret.into()],
        ))
        .await;
    match row {
        Ok(Some(r)) => (
            StatusCode::OK,
            axum::Json(json!({
                "displayName": opt_str(&r, "display_name"),
                "primaryColor": opt_str(&r, "primary_color"),
                "secondaryColor": opt_str(&r, "secondary_color"),
                "defaultLanguage": opt_str(&r, "default_language").unwrap_or_else(|| "en".to_string()),
                "supportedLanguages": parse_langs(&r),
                "translations": parse_translations(&r),
                "greetingMessage": opt_str(&r, "greeting_message"),
                "legalMessage": opt_str(&r, "legal_message"),
                "position": opt_str(&r, "position"),
                "avatarUrl": opt_str(&r, "avatar_url"),
            })),
        )
            .into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => {
            tracing::error!("[ai-assistant-embed/config] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

fn sse_chunk(payload: &Value) -> String {
    format!("data: {}\n\n", payload.to_string())
}

async fn chat(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(secret): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    if secret.len() != 22 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    // This router accepts text/plain and parses JSON manually.
    let parsed: Value = if body.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(Value::String(s)) => serde_json::from_str(&s).unwrap_or(json!({})),
            Ok(v) => v,
            Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
        }
    };
    let message = parsed.get("message").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if message.is_empty() || message.len() > 2000 {
        return err(StatusCode::BAD_REQUEST, "Message must be 1..2000 characters");
    }
    let cfg_row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, status, base_prompt, model, base_url, api_key_enc, default_language, allowed_origins FROM ai_assistant_configs WHERE trim(secret_token) = $1",
            vec![secret.into()],
        ))
        .await;
    let cfg_row = match cfg_row {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => {
            tracing::error!("[ai-assistant-embed/chat] {e:?}");
            return err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
        }
    };
    if opt_str(&cfg_row, "status").as_deref() != Some("active") {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let assistant_id: i64 = cfg_row.try_get("", "id").unwrap_or(0);
    let allowed = parse_origins(&cfg_row);
    if !allowed.is_empty() {
        let origin = headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("");
        if !is_origin_allowed(origin, &allowed) {
            return err(StatusCode::NOT_FOUND, "Not found");
        }
    }
    let base_prompt = opt_str(&cfg_row, "base_prompt").unwrap_or_else(|| "You are a helpful assistant.".to_string());
    let model = opt_str(&cfg_row, "model").unwrap_or_else(|| "gpt-4o".to_string());
    let base_url = opt_str(&cfg_row, "base_url").unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let api_key_enc = opt_str(&cfg_row, "api_key_enc");
    let default_lang = opt_str(&cfg_row, "default_language").unwrap_or_else(|| "en".to_string());
    let lang = parsed
        .get("lang")
        .and_then(|v| v.as_str())
        .filter(|s| s.len() >= 2 && s.len() <= 10)
        .unwrap_or(&default_lang)
        .to_string();
    let requested_session = parsed.get("sessionId").and_then(|v| v.as_str()).map(|s| s.to_string());
    // resolve or create session
    let mut session_pk: Option<i64> = None;
    let mut external_session = requested_session.clone().unwrap_or_default();
    if let Some(req_sid) = requested_session {
        if let Ok(Some(s)) = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id FROM ai_chat_sessions WHERE session_id = $1 AND assistant_id = $2",
                vec![req_sid.clone().into(), assistant_id.into()],
            ))
            .await
        {
            session_pk = s.try_get::<i64>("", "id").ok();
            external_session = req_sid;
            if let Some(pk) = session_pk {
                let _ = ctx
                    .db
                    .execute_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "UPDATE ai_chat_sessions SET language = $1 WHERE id = $2",
                        vec![lang.clone().into(), pk.into()],
                    ))
                    .await;
            }
        }
    }
    if session_pk.is_none() {
        let new_sid = if external_session.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            external_session.clone()
        };
        let ip: Option<String> = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.split(',').next().unwrap_or("").trim().to_string());
        let ua: String = headers
            .get("user-agent")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .chars()
            .take(500)
            .collect();
        match ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO ai_chat_sessions (assistant_id, session_id, visitor_id, language, ip_address, user_agent) VALUES ($1,$2,NULL,$3,$4::inet,$5) RETURNING id",
                vec![assistant_id.into(), new_sid.clone().into(), lang.clone().into(), ip.into(), ua.clone().into()],
            ))
            .await
        {
            Ok(Some(s)) => {
                session_pk = s.try_get::<i64>("", "id").ok();
                external_session = new_sid;
            }
            _ => {
                // ip cast may fail for garbage; retry without ip
                if let Ok(Some(s)) = ctx
                    .db
                    .query_one_raw(Statement::from_sql_and_values(
                        sea_orm::DatabaseBackend::Postgres,
                        "INSERT INTO ai_chat_sessions (assistant_id, session_id, visitor_id, language, user_agent) VALUES ($1,$2,NULL,$3,$4) RETURNING id",
                        vec![assistant_id.into(), new_sid.clone().into(), lang.clone().into(), ua.clone().into()],
                    ))
                    .await
                {
                    session_pk = s.try_get::<i64>("", "id").ok();
                    external_session = new_sid;
                } else {
                    return err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error");
                }
            }
        }
    }
    let session_pk = session_pk.unwrap_or(0);
    let _ = ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO ai_chat_messages (session_id, assistant_id, role, content, language) VALUES ($1,$2,'user',$3,$4)",
            vec![session_pk.into(), assistant_id.into(), message.clone().into(), lang.clone().into()],
        ))
        .await;
    let history: Vec<(String, String)> = ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT role, content FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC",
            vec![session_pk.into()],
        ))
        .await
        .map(|rows| {
            let mut h: Vec<(String, String)> = rows
                .iter()
                .map(|r| {
                    (
                        r.try_get::<String>("", "role").unwrap_or_else(|_| "user".to_string()),
                        r.try_get::<String>("", "content").unwrap_or_default(),
                    )
                })
                .collect();
            if h.len() > 20 {
                h = h.split_off(h.len() - 20);
            }
            h
        })
        .unwrap_or_default();
    let (rag_ctx, rag_sources) = A::rag_search(&ctx.db, assistant_id, &message, 5).await;
    let system = format!("{base_prompt}\n\nRespond in {lang}.{rag_ctx}");
    let mut llm_messages = vec![json!({ "role": "system", "content": system })];
    for (role, content) in &history {
        let r = if role == "system" { "user" } else { role.as_str() };
        llm_messages.push(json!({ "role": r, "content": content }));
    }
    // key check (graceful SSE message on missing key)
    let api_key = match A::resolve_api_key(api_key_enc) {
        A::KeyState::Ready(k) => k,
        _ => {
            let body = format!(
                "{}{}",
                sse_chunk(&json!({ "content": "AI configuration is not properly set up.", "sessionId": external_session })),
                "data: [DONE]\n\n"
            );
            return Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .header("X-Session-Id", external_session.clone())
                .body(Body::from(body))
                .unwrap();
        }
    };
    let ext = external_session.clone();
    match A::llm_stream_buffered(&base_url, &api_key, &model, &llm_messages, &ext, 30_000).await {
        Ok((deltas, tokens)) => {
            let full: String = deltas.concat();
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO ai_chat_messages (session_id, assistant_id, role, content, language, tokens_used, rag_sources) VALUES ($1,$2,'assistant',$3,$4,$5,$6::jsonb)",
                    vec![
                        session_pk.into(),
                        assistant_id.into(),
                        full.clone().into(),
                        lang.into(),
                        (tokens as i32).into(),
                        if rag_sources.is_empty() { None } else { Some(serde_json::to_string(&rag_sources).unwrap_or_default()) }.into(),
                    ],
                ))
                .await;
            let mut body = String::new();
            for d in &deltas {
                body.push_str(&sse_chunk(&json!({ "content": d })));
            }
            body.push_str(&sse_chunk(&json!({ "sessionId": ext, "done": true })));
            body.push_str("data: [DONE]\n\n");
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .header("X-Session-Id", ext)
                .body(Body::from(body))
                .unwrap()
        }
        Err(e) => {
            tracing::error!("[ai-assistant-embed] LLM error: {e}");
            let body = format!(
                "{}{}",
                sse_chunk(&json!({ "content": "Sorry, something went wrong. Please try again." })),
                "data: [DONE]\n\n"
            );
            Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", "text/event-stream")
                .header("Cache-Control", "no-cache")
                .header("Connection", "keep-alive")
                .header("X-Session-Id", ext)
                .body(Body::from(body))
                .unwrap()
        }
    }
}

async fn language(
    State(ctx): State<AppContext>,
    Path(secret): Path<String>,
    body: axum::body::Bytes,
) -> Response {
    if secret.len() != 22 {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let (Some(sid), Some(lang_req)) = (
        parsed.get("sessionId").and_then(|v| v.as_str()),
        parsed.get("lang").and_then(|v| v.as_str()),
    ) else {
        return err(StatusCode::BAD_REQUEST, "sessionId and lang are required");
    };
    let row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, supported_languages, default_language FROM ai_assistant_configs WHERE trim(secret_token) = $1 AND status = 'active'",
            vec![secret.into()],
        ))
        .await;
    match row {
        Ok(Some(r)) => {
            let langs = parse_langs(&r);
            let def = opt_str(&r, "default_language").unwrap_or_else(|| "en".to_string());
            let lang = if langs.iter().any(|l| l == lang_req) { lang_req.to_string() } else { def };
            let aid: i64 = r.try_get("", "id").unwrap_or(0);
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "UPDATE ai_chat_sessions SET language = $1 WHERE session_id = $2 AND assistant_id = $3",
                    vec![lang.clone().into(), sid.to_string().into(), aid.into()],
                ))
                .await;
            (StatusCode::OK, axum::Json(json!({ "ok": true, "language": lang }))).into_response()
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "Not found"),
        Err(e) => {
            tracing::error!("[ai-assistant-embed/language] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/ai-assistant")
        .add("/{secret_token}/script.js", get(script_js))
        .add("/{secret_token}/config", get(public_config))
        .add("/{secret_token}/chat", post(chat))
        .add("/{secret_token}/language", post(language))
}
