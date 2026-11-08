//! Public by-domain service reads for landing pages. Port of old_backend/routes/service-public.js.
//!
//! Routes (under /api/public/service, NO auth — Host header is the auth):
//!   GET /by-domain/:domain/items   - all published items, sort_order order
//!
//! Response: { items: [{ titleHu, titleEn, descriptionHu, descriptionEn, priceHu, priceEn, sortOrder }] }
//!
//! Simplifications vs the Express original:
//!   - No in-memory TTL cache; relies on Cache-Control headers + nginx/CDN.
//!   - No express-rate-limit (burst 30/min, sustained 600/h).

use axum::{
    extract::Path,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[service-public/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

async fn items(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(domain): Path<String>,
) -> Response {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let host = host.split(':').next().unwrap_or("").to_string();
    let domain_lc = domain.to_lowercase();

    let mut project: Option<(i64, Option<String>)> = None;
    let mut candidates = vec![];
    if !host.is_empty() {
        candidates.push(host);
    }
    if !domain_lc.is_empty() && !candidates.contains(&domain_lc) {
        candidates.push(domain_lc.clone());
    }
    for c in candidates {
        match ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT id, domain_address FROM projects WHERE domain_address = $1 OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $1 LIMIT 1",
                vec![c.into()],
            ))
            .await
        {
            Ok(Some(r)) => {
                let id: i64 = match r.try_get("", "id") {
                    Ok(v) => v,
                    Err(e) => return internal("resolve", e),
                };
                project = Some((id, r.try_get("", "domain_address").ok().flatten()));
                break;
            }
            Ok(None) => {}
            Err(e) => return internal("resolve", e),
        }
    }
    let Some((project_id, domain_address)) = project else {
        return err(StatusCode::NOT_FOUND, "Unknown host");
    };
    let normalized = domain_address
        .as_deref()
        .unwrap_or("")
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_lowercase();
    if normalized != domain_lc {
        return err(StatusCode::NOT_FOUND, "Unknown host");
    }

    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT title_hu, title_en, description_hu, description_en, price_hu, price_en, sort_order FROM service_items WHERE project_id = $1 AND status = 'published' ORDER BY sort_order ASC, id ASC",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("list", e),
    };
    let items: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "titleHu": r.try_get::<String>("", "title_hu").unwrap_or_default(),
                "titleEn": r.try_get::<String>("", "title_en").unwrap_or_default(),
                "descriptionHu": r.try_get::<String>("", "description_hu").unwrap_or_default(),
                "descriptionEn": r.try_get::<String>("", "description_en").unwrap_or_default(),
                "priceHu": r.try_get::<String>("", "price_hu").unwrap_or_default(),
                "priceEn": r.try_get::<String>("", "price_en").unwrap_or_default(),
                "sortOrder": r.try_get::<i32>("", "sort_order").unwrap_or(0),
            })
        })
        .collect();
    let mut resp = (StatusCode::OK, Json(json!({ "items": items }))).into_response();
    if let (Ok(cc), Ok(vary)) = (
        "public, max-age=300, stale-while-revalidate=300".parse(),
        "Origin, Accept-Encoding".parse(),
    ) {
        resp.headers_mut().insert("cache-control", cc);
        resp.headers_mut().insert("vary", vary);
    }
    resp
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/service")
        .add("/by-domain/:domain/items", get(items))
}
