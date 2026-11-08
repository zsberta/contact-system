//! Tolerant multi-value query extractor.
//!
//! `axum::extract::Query<HashMap<String, Vec<String>>>` rejects ordinary
//! single-value query strings (`?page=0` fails with "expected a sequence"),
//! which breaks every filtered/paginated admin list. `MultiQuery` parses the
//! raw query string into `HashMap<String, Vec<String>>`, accepting both
//! single (`?slug=x`) and repeated (`?queries=a&queries=b`) keys.

use axum::{extract::FromRequestParts, http::request::Parts};
use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct MultiQuery(pub HashMap<String, Vec<String>>);

impl std::ops::Deref for MultiQuery {
    type Target = HashMap<String, Vec<String>>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<S> FromRequestParts<S> for MultiQuery
where
    S: Send + Sync,
{
    type Rejection = (axum::http::StatusCode, String);

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        if let Some(q) = parts.uri.query() {
            let pairs: Vec<(String, String)> = serde_urlencoded::from_str(q).map_err(|e| {
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    format!("Invalid query string: {e}"),
                )
            })?;
            for (k, v) in pairs {
                map.entry(k).or_default().push(v);
            }
        }
        Ok(MultiQuery(map))
    }
}
