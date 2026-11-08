//! Port of old_backend/routes/form_embed.js — owned by module team.
//! Status: scaffold (501). Real SQL-backed handlers land per-module.

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use serde_json::json;

async fn todo_handler(State(_ctx): State<AppContext>) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "errorMessage": "Not implemented yet (form_embed)" })),
    )
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api/public/forms").add("/", get(todo_handler))
}
