//! Admin-only proxy to the nexus-gateway billing API.
//! 1:1 port of old_backend/routes/gateway.js.
//!
//! The operator token never leaves the server: the browser talks to
//! /api/gateway/* with its cookie session, this controller forwards to the
//! gateway with the server-side GATEWAY_API_TOKEN.

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use serde::Deserialize;
use serde_json::json;

use crate::middleware::auth::MaybeUser;

fn base_url() -> String {
    std::env::var("GATEWAY_API_URL")
        .unwrap_or_else(|_| "http://host.docker.internal:9006/api/v1".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn gateway_token() -> String {
    std::env::var("GATEWAY_API_TOKEN").unwrap_or_default()
}

fn admin_only(user: &Option<crate::middleware::auth::CurrentUser>) -> Option<Response> {
    match user {
        None => Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "errorMessage": "Unauthorized" })),
            )
                .into_response(),
        ),
        Some(u) if u.role != "admin" => Some(
            (
                StatusCode::FORBIDDEN,
                Json(json!({ "errorMessage": "Admin access required" })),
            )
                .into_response(),
        ),
        _ => None,
    }
}

async fn forward(
    method: Method,
    gateway_path: String,
    query: Option<String>,
    body: Option<serde_json::Value>,
) -> Response {
    let token = gateway_token();
    if token.is_empty() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "errorMessage": "Billing gateway is not configured (GATEWAY_API_TOKEN missing)" })),
        )
            .into_response();
    }
    let url = match query {
        Some(q) if !q.is_empty() => format!("{}{gateway_path}?{q}", base_url()),
        _ => format!("{}{gateway_path}", base_url()),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client
        .request(method.clone(), &url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json");
    if !matches!(method, Method::GET | Method::HEAD | Method::DELETE) {
        req = req
            .header("Content-Type", "application/json")
            .body(body.map(|b| b.to_string()).unwrap_or_else(|| "{}".to_string()));
    }
    let upstream = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let reason = if e.is_timeout() { "timed out" } else { "unreachable" };
            tracing::error!("[gateway] {method} {gateway_path} {reason}");
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "errorMessage": format!("Billing gateway {reason}") })),
            )
                .into_response();
        }
    };
    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let text = upstream.text().await.unwrap_or_default();
    match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => (status, Json(v)).into_response(),
        Err(_) => Response::builder()
            .status(status)
            .header("Content-Type", "text/plain")
            .body(Body::from(text))
            .unwrap(),
    }
}

#[derive(Debug, Deserialize)]
struct Paging {
    page: Option<String>,
    per_page: Option<String>,
    status: Option<String>,
    owner_type: Option<String>,
}

fn encode_params(pairs: &[(&str, &Option<String>)]) -> Option<String> {
    let parts: Vec<String> = pairs
        .iter()
        .filter_map(|(k, v)| v.as_ref().map(|val| format!("{k}={val}")))
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("&"))
    }
}

async fn list_projects(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Query(q): Query<Paging>) -> Response {
    if let Some(r) = admin_only(&u) {
        return r;
    }
    let qs = encode_params(&[("page", &q.page), ("per_page", &q.per_page)]);
    forward(Method::GET, "/projects".into(), qs, None).await
}

async fn create_project(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, "/projects".into(), None, Some(b)).await
}

async fn get_project(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::GET, format!("/projects/{id}"), None, None).await
}

async fn update_project(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::PUT, format!("/projects/{id}"), None, Some(b)).await
}

async fn delete_project(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::DELETE, format!("/projects/{id}"), None, None).await
}

async fn project_token(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, format!("/projects/{id}/tokens"), None, Some(b)).await
}

async fn project_test_email(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, format!("/projects/{id}/test-email"), None, Some(b)).await
}

async fn list_merchants(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Query(q): Query<Paging>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    let qs = encode_params(&[("page", &q.page), ("per_page", &q.per_page)]);
    forward(Method::GET, "/merchants".into(), qs, None).await
}

async fn update_merchant(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::PUT, format!("/merchants/{id}"), None, Some(b)).await
}

async fn delete_merchant(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::DELETE, format!("/merchants/{id}"), None, None).await
}

async fn merchant_credentials(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, "/merchants/credentials".into(), None, Some(b)).await
}

async fn merchant_blocks_preview(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, "/merchants/blocks-preview".into(), None, Some(b)).await
}

async fn merchant_billingo_blocks(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::GET, format!("/merchants/{id}/billingo-blocks"), None, None).await
}

async fn project_billingo_blocks(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::GET, format!("/projects/{id}/billingo-blocks"), None, None).await
}

async fn merchant_test_email(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>, Json(b): Json<serde_json::Value>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, format!("/merchants/{id}/test-email"), None, Some(b)).await
}

async fn list_transactions(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, headers: HeaderMap, Query(q): Query<Paging>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    let _ = headers;
    let qs = encode_params(&[("page", &q.page), ("per_page", &q.per_page), ("status", &q.status), ("owner_type", &q.owner_type)]);
    forward(Method::GET, "/transactions".into(), qs, None).await
}

async fn get_transaction(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::GET, format!("/transactions/{id}"), None, None).await
}

async fn resend_transaction(State(_ctx): State<AppContext>, MaybeUser(u): MaybeUser, Path(id): Path<String>) -> Response {
    if let Some(r) = admin_only(&u) { return r; }
    forward(Method::POST, format!("/transactions/{id}/resend"), None, Some(json!({}))).await
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/gateway")
        .add("/projects", get(list_projects))
        .add("/projects", post(create_project))
        .add("/projects/{id}", get(get_project))
        .add("/projects/{id}", put(update_project))
        .add("/projects/{id}", delete(delete_project))
        .add("/projects/{id}/tokens", post(project_token))
        .add("/projects/{id}/test-email", post(project_test_email))
        .add("/projects/{id}/billingo-blocks", get(project_billingo_blocks))
        .add("/merchants", get(list_merchants))
        .add("/merchants/{id}", put(update_merchant))
        .add("/merchants/{id}", delete(delete_merchant))
        .add("/merchants/credentials", post(merchant_credentials))
        .add("/merchants/blocks-preview", post(merchant_blocks_preview))
        .add("/merchants/{id}/billingo-blocks", get(merchant_billingo_blocks))
        .add("/merchants/{id}/test-email", post(merchant_test_email))
        .add("/transactions", get(list_transactions))
        .add("/transactions/{id}", get(get_transaction))
        .add("/transactions/{id}/resend", post(resend_transaction))
}
