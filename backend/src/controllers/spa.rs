//! SPA + upload static serving.
//!
//! ```js
//! app.use("/uploads", express.static(uploadsDir)); // + CORP header
//! app.use(express.static(distDir));
//! app.get("*", (req, res, next) => {
//!   if (req.path.startsWith("/api/")) return next();
//!   res.setHeader("Cache-Control", "no-store");
//!   res.sendFile(path.join(distDir, "index.html"));
//! });
//! ```
//!
//! Explicit routes (not a fallback service) so Loco's own fallback
//! middleware can never override the status: every non-API GET returns
//! 200 (the React Router `*` route renders the
//! in-app 404 page for unknown paths, e.g. the unregistered /settings).

use axum::{
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;

fn dist_dir() -> String {
    std::env::var("FRONTEND_DIST").unwrap_or_else(|_| "dist".to_string())
}

fn uploads_dir() -> String {
    let root =
        std::env::var("UPLOADS_DIR").unwrap_or_else(|_| "/app/uploads".to_string());
    if root == "/app/uploads" && !std::path::Path::new(&root).exists() {
        return "./uploads".to_string();
    }
    root
}

async fn file_response(full: &str) -> Option<Response> {
    let bytes = tokio::fs::read(full).await.ok()?;
    let mime = mime_guess::from_path(full).first_or_octet_stream();
    let mut resp = bytes.into_response();
    if let Ok(ct) = mime.as_ref().parse() {
        resp.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    Some(resp)
}

async fn serve_index() -> Response {
    let file = format!("{}/index.html", dist_dir());
    match file_response(&file).await {
        Some(mut resp) => {
            resp.headers_mut().insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );
            *resp.status_mut() = StatusCode::OK;
            resp
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "errorMessage": "Not found" })),
        )
            .into_response(),
    }
}

async fn spa_root() -> Response {
    serve_index().await
}

async fn spa_path(Path(path): Path<String>) -> Response {
    if path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "errorMessage": "Not found" })),
        )
            .into_response();
    }
    let full = format!("{}/{}", dist_dir(), path);
    if let Some(mut resp) = file_response(&full).await {
        *resp.status_mut() = StatusCode::OK;
        return resp;
    }
    serve_index().await
}

async fn upload_file(Path(path): Path<String>) -> Response {
    if path.contains("..") {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "errorMessage": "Not found" })),
        )
            .into_response();
    }
    let full = format!("{}/{}", uploads_dir(), path);
    match file_response(&full).await {
        Some(mut resp) => {
            // The uploads mount overrides the default same-origin CORP so
            // cross-origin pages (landing sites, AI avatars) can load files.
            resp.headers_mut().insert(
                "Cross-Origin-Resource-Policy",
                HeaderValue::from_static("cross-origin"),
            );
            resp
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "errorMessage": "Not found" })),
        )
            .into_response(),
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .add("/", get(spa_root))
        .add("/uploads/{*path}", get(upload_file))
        .add("/{*path}", get(spa_path))
}
