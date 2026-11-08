//! Port of old_backend/routes/payment_attachments.js — owned by module team.
//! Status: scaffold (501). Real SQL-backed handlers land per-module.

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use serde_json::json;

async fn todo_handler(State(_ctx): State<AppContext>) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "errorMessage": "Not implemented yet (payment_attachments)" })),
    )
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api/payments").add("/", get(todo_handler))
}
