//! Port of old_backend/routes/submissions.js — owned by module team.
//! Status: scaffold (501). Real SQL-backed handlers land per-module.

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use serde_json::json;

async fn todo_handler(State(_ctx): State<AppContext>) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "errorMessage": "Not implemented yet (submissions)" })),
    )
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api/submissions").add("/", get(todo_handler))
}
