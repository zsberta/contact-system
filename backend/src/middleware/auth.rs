//! Auth extractor: mirrors old_backend/middleware/jwtAuth.js.
//!
//! Reads the `token` cookie (HS256 JWT signed at signin/refresh with
//! `{ sub, email, role, projectIds }`). Missing/invalid token -> `None`
//! (public routes); helpers below enforce 401/403 JSON errors with the
//! exact `{ errorMessage }` shape the React frontend expects.

use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use jsonwebtoken::{decode, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,
    pub email: String,
    #[serde(default = "default_role")]
    pub role: String,
    #[serde(default, rename = "projectIds")]
    pub project_ids: Vec<i64>,
    pub exp: usize,
}

fn default_role() -> String {
    "admin".to_string()
}

#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: i64,
    pub email: String,
    pub role: String,
    pub project_ids: Vec<i64>,
}

#[derive(Debug, Clone)]
pub struct MaybeUser(pub Option<CurrentUser>);

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-only-secret-change-me-32chars!!".to_string())
}

fn token_from_cookies(parts: &Parts) -> Option<String> {
    let header = parts.headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for pair in header.split(';') {
        let pair = pair.trim();
        if let Some(v) = pair.strip_prefix("token=") {
            return Some(v.to_string());
        }
    }
    None
}

fn decode_user(token: &str) -> Option<CurrentUser> {
    let mut validation = Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.validate_exp = true;
    let data = decode::<Claims>(
        token,
        &DecodingKey::from_secret(jwt_secret().as_bytes()),
        &validation,
    )
    .ok()?;
    let c = data.claims;
    let project_ids = c
        .project_ids
        .into_iter()
        .filter(|n| *n > 0)
        .collect::<Vec<_>>();
    Some(CurrentUser {
        id: c.sub,
        email: c.email,
        role: if c.role.is_empty() {
            "admin".to_string()
        } else {
            c.role
        },
        project_ids,
    })
}

impl<S> FromRequestParts<S> for MaybeUser
where
    S: Send + Sync,
{
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        let user = token_from_cookies(parts).and_then(|t| decode_user(&t));
        Ok(MaybeUser(user))
    }
}

impl<S> FromRequestParts<S> for CurrentUser
where
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        match token_from_cookies(parts).and_then(|t| decode_user(&t)) {
            Some(u) => Ok(u),
            None => Err((
                StatusCode::UNAUTHORIZED,
                Json(json!({ "errorMessage": "Unauthorized" })),
            )
                .into_response()),
        }
    }
}

/// Enforce admin role: 401 when anonymous, 403 when non-admin.
/// Mirrors `requireAdmin` (endusers get 403, not 401).
pub fn require_admin(user: &Option<CurrentUser>) -> Result<&CurrentUser, Response> {
    match user {
        None => Err((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "errorMessage": "Unauthorized" })),
        )
            .into_response()),
        Some(u) if u.role != "admin" => Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "errorMessage": "Admin access required" })),
        )
            .into_response()),
        Some(u) => Ok(u),
    }
}

pub fn scoped_project_ids(user: &CurrentUser) -> Option<Vec<i64>> {
    if user.role == "admin" {
        None
    } else {
        Some(user.project_ids.clone())
    }
}
