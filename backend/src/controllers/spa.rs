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

/// True for the public widget shell (`/embed/...`), which customer sites
/// load inside an `<iframe>`.
fn is_embed_path(path: &str) -> bool {
    path == "embed" || path.starts_with("embed/")
}

/// Frame policy for the public embed shell.
///
/// The host reverse-proxy stamps `X-Frame-Options: SAMEORIGIN` on every
/// response (correct for the admin UI — clickjacking protection must stay
/// there). That header also lands on `/embed/...`, so Firefox/Zen/Chrome
/// refuse to show the booking widget inside customer sites:
/// "will not allow ... to display the page if another site has embedded it".
///
/// The proxy header cannot be stripped from inside the app, but every
/// modern browser **ignores `X-Frame-Options` when the document carries a
/// `Content-Security-Policy` with `frame-ancestors`** — so this response
/// header re-allows framing for the embed shell only. Loco's
/// `SecureHeaders` middleware (currently disabled) only fills in headers
/// that are missing, so it never overwrites this.
///
/// Security: the shell HTML itself carries no data. Read access is still
/// gated by the 22-char secret token in the URL plus the per-reservation
/// `allowed_origins` check on every `/api/public/reservations/*` call.
fn with_embed_frame_policy(mut resp: Response) -> Response {
    resp.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("frame-ancestors *"),
    );
    resp
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
        return if is_embed_path(&path) {
            with_embed_frame_policy(resp)
        } else {
            resp
        };
    }
    let index = serve_index().await;
    if is_embed_path(&path) {
        with_embed_frame_policy(index)
    } else {
        index
    }
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
