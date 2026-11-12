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

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(qs: &str) -> HashMap<String, Vec<String>> {
        let mut map: HashMap<String, Vec<String>> = HashMap::new();
        if qs.is_empty() {
            return map;
        }
        let pairs: Vec<(String, String)> =
            serde_urlencoded::from_str(qs).expect("test query strings must parse");
        for (k, v) in pairs {
            map.entry(k).or_default().push(v);
        }
        map
    }

    fn queries_of(q: &HashMap<String, Vec<String>>) -> Vec<String> {
        let mut out: Vec<String> = q.get("queries").cloned().unwrap_or_default();
        if let Some(extra) = q.get("queries[]") {
            out.extend(extra.clone());
        }
        out.into_iter().filter(|t| !t.trim().is_empty()).collect()
    }

    #[test]
    fn single_queries_value_is_accepted() {
        // Regression: `Query<T>` with `queries: Option<Vec<String>>` rejects
        // `?queries=kupi` with `invalid type: string "kupi", expected a sequence`.
        #[derive(Debug, serde::Deserialize)]
        #[allow(dead_code)]
        struct Old {
            queries: Option<Vec<String>>,
        }
        let err = serde_urlencoded::from_str::<Old>("queries=kupi").unwrap_err();
        assert!(
            err.to_string().contains("expected a sequence"),
            "expected the legacy failure, got: {err}"
        );

        let q = parse("page=0&size=10&filterType=any&projectId=10&queries=kupi");
        assert_eq!(queries_of(&q), vec!["kupi".to_string()]);
    }

    #[test]
    fn multiple_queries_values_are_all_kept() {
        let q = parse("page=0&size=10&filterType=any&projectId=10&queries=kupi&queries=ramona");
        assert_eq!(queries_of(&q), vec!["kupi".to_string(), "ramona".to_string()]);
    }

    #[test]
    fn no_queries_param_yields_no_terms() {
        let q = parse("page=0&size=10&filterType=any&projectId=10");
        assert!(queries_of(&q).is_empty());
    }

    #[test]
    fn bracketed_queries_alias_is_merged() {
        let q = parse("queries=kupi&queries[]=ramona");
        assert_eq!(queries_of(&q), vec!["kupi".to_string(), "ramona".to_string()]);
    }
}
