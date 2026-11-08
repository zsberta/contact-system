//! Port of old_backend/routes/service_public.js — owned by module team.
//! Status: scaffold (501). Real SQL-backed handlers land per-module.

use axum::response::IntoResponse;
use loco_rs::prelude::*;
use serde_json::json;

async fn todo_handler(State(_ctx): State<AppContext>) -> impl IntoResponse {
    (
        axum::http::StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "errorMessage": "Not implemented yet (service_public)" })),
    )
}

pub fn routes() -> Routes {
    Routes::new().prefix("/api/public/service").add("/", get(todo_handler))
}
