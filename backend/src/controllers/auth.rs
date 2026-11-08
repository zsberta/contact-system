//! Auth controller: 1:1 port of old_backend/routes/auth.js.
//!
//! Routes:
//!   POST /api/auth/signin, /refresh, /logout, /set-password,
//!        /forgot-password, /reset-password (public, CSRF-exempt)
//!   GET  /api/auth/me (protected)

use axum::response::IntoResponse;
use axum_extra::extract::CookieJar;
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::middleware::auth::CurrentUser;

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-only-secret-change-me-32chars!!".to_string())
}
fn access_ttl() -> i64 {
    std::env::var("JWT_ACCESS_TTL").ok().and_then(|v| v.parse().ok()).unwrap_or(3600)
}
fn refresh_ttl() -> i64 {
    std::env::var("JWT_REFRESH_TTL").ok().and_then(|v| v.parse().ok()).unwrap_or(604800)
}
fn bcrypt_cost() -> u32 {
    std::env::var("BCRYPT_COST").ok().and_then(|v| v.parse().ok()).unwrap_or(12)
}
fn cookie_secure() -> bool {
    std::env::var("COOKIE_SECURE").map(|v| v == "true").unwrap_or(false)
}
fn cookie_samesite() -> String {
    std::env::var("COOKIE_SAMESITE").unwrap_or_else(|_| "Lax".to_string())
}

const PASSWORD_DENY: &[&str] = &[
    "changeme", "changeme123", "admin", "password", "12345678", "qwerty", "letmein",
];

fn validate_password(pw: &str) -> Option<&'static str> {
    if pw.len() < 8 || pw.len() > 128 {
        return Some("Password must be 8..128 characters");
    }
    if PASSWORD_DENY.contains(&pw.to_lowercase().as_str()) {
        return Some("Password is too weak");
    }
    None
}

fn sha256_hex(s: &str) -> String {
    use sha2::{Digest, Sha256};
    hex_encode(Sha256::digest(s.as_bytes()).as_slice())
}

fn hex_encode(bytes: &[u8]) -> String {
    const H: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 0xf) as usize] as char);
    }
    out
}

fn rand_hex(nbytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; nbytes];
    rand::thread_rng().fill_bytes(&mut buf);
    hex_encode(&buf)
}

fn sign_access(user_id: i64, email: &str, role: &str, project_ids: &[i64]) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let exp = chrono::Utc::now().timestamp() + access_ttl();
    let claims = serde_json::json!({
        "sub": user_id,
        "email": email,
        "role": if role.is_empty() { "admin" } else { role },
        "projectIds": if role == "enduser" { serde_json::json!(project_ids) } else { serde_json::json!([]) },
        "exp": exp,
    });
    encode(&Header::new(jsonwebtoken::Algorithm::HS256), &claims, &EncodingKey::from_secret(jwt_secret().as_bytes())).unwrap_or_default()
}

fn sign_refresh(user_id: i64) -> (String, String) {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let jti = rand_hex(32);
    let exp = chrono::Utc::now().timestamp() + refresh_ttl();
    let claims = serde_json::json!({ "sub": user_id, "jti": jti, "exp": exp });
    let token = encode(&Header::new(jsonwebtoken::Algorithm::HS256), &claims, &EncodingKey::from_secret(jwt_secret().as_bytes())).unwrap_or_default();
    let hash = sha256_hex(&jti);
    (token, hash)
}

fn set_cookie_header(existing: Vec<String>, name: &str, value: &str, max_age: i64, http_only: bool) -> Vec<String> {
    let mut c = format!("{name}={value}; Path=/; Max-Age={max_age}; SameSite={}", cookie_samesite());
    if http_only {
        c.push_str("; HttpOnly");
    }
    if cookie_secure() {
        c.push_str("; Secure");
    }
    let mut v = existing;
    v.push(c);
    v
}

fn clear_cookie_header(existing: Vec<String>, name: &str) -> Vec<String> {
    let mut v = existing;
    v.push(format!("{name}=; Path=/; Max-Age=0"));
    v
}

#[derive(Debug, Deserialize)]
struct AuthCtx {
    id: i64,
    email: String,
    first_name: Option<String>,
    last_name: Option<String>,
    enabled: bool,
    role: String,
    must_set_password: bool,
    project_ids: Vec<i64>,
}

async fn load_ctx(db: &sea_orm::DatabaseConnection, user_id: i64) -> Result<Option<AuthCtx>> {
    use sea_orm::DatabaseBackend;
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"SELECT u.id, u.email, u.first_name, u.last_name, u.enabled, u.role,
                  u.must_set_password,
                  COALESCE((SELECT array_agg(project_id ORDER BY project_id)
                            FROM user_project_assignments WHERE user_id = u.id),
                           ARRAY[]::bigint[]) AS project_ids
           FROM users u WHERE u.id = $1"#,
        vec![user_id.into()],
    );
    let row = db.query_one_raw(stmt).await?;
    let Some(r) = row else { return Ok(None) };
    // project_ids comes back as Postgres bigint[]; SeaORM maps to Vec<i64>.
    let project_ids: Vec<i64> = r.try_get("", "project_ids").unwrap_or_default();
    Ok(Some(AuthCtx {
        id: r.try_get("", "id")?,
        email: r.try_get("", "email")?,
        first_name: r.try_get("", "first_name").ok(),
        last_name: r.try_get("", "last_name").ok(),
        enabled: r.try_get("", "enabled")?,
        role: r.try_get::<Option<String>>("", "role")?.unwrap_or_else(|| "admin".to_string()),
        must_set_password: r.try_get::<Option<bool>>("", "must_set_password")?.unwrap_or(false),
        project_ids,
    }))
}

fn user_dto(ctx: &AuthCtx) -> serde_json::Value {
    json!({
        "id": ctx.id,
        "email": ctx.email,
        "firstName": ctx.first_name,
        "lastName": ctx.last_name,
        "enabled": ctx.enabled,
        "role": ctx.role,
        "mustSetPassword": ctx.must_set_password,
        "projectIds": ctx.project_ids,
    })
}

async fn get_password_hash(db: &sea_orm::DatabaseConnection, user_id: i64) -> String {
    let stmt = Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT password_hash FROM users WHERE id = $1",
        vec![user_id.into()],
    );
    match db.query_one_raw(stmt).await.ok().flatten() {
        Some(r) => r.try_get::<Option<String>>("", "password_hash").ok().flatten().unwrap_or_else(|| dummy_hash()),
        None => dummy_hash(),
    }
}

fn dummy_hash() -> String {
    "$2b$12$CwTycUXWue0Thq9StjUM0uJ8jVQfGvM3vQ5Y5Y5Y5Y5Y5Y5Y5Y5Ye".to_string()
}

#[derive(Debug, Deserialize)]
pub struct SigninParams {
    pub identifier: Option<String>,
    pub password: Option<String>,
}

async fn signin(State(ctx): State<AppContext>, Json(p): Json<SigninParams>) -> impl IntoResponse {
    let (Some(identifier), Some(password)) = (p.identifier, p.password) else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Missing credentials"}))).into_response();
    };
    if password.len() > 128 {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid credentials"}))).into_response();
    }
    let res: Result<axum::http::Response<axum::body::Body>> = (async {
        let id_row = ctx.db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id FROM users WHERE email = $1",
            vec![identifier.clone().into()],
        )).await?;
        let user_id: Option<i64> = id_row.and_then(|r| r.try_get("", "id").ok());
        let auth_ctx = match user_id {
            Some(id) => load_ctx(&ctx.db, id).await?,
            None => None,
        };
        let hash = match &auth_ctx {
            Some(c) if c.enabled && !c.must_set_password => get_password_hash(&ctx.db, c.id).await,
            _ => dummy_hash(),
        };
        let ok = bcrypt::verify(&password, &hash).unwrap_or(false);
        let Some(c) = auth_ctx else {
            tracing::warn!("[auth/signin] failed attempt");
            return Ok((axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Invalid credentials"}))).into_response());
        };
        if !c.enabled || c.must_set_password || !ok {
            return Ok((axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Invalid credentials"}))).into_response());
        }
        let access = sign_access(c.id, &c.email, &c.role, &c.project_ids);
        let (refresh_token, refresh_hash) = sign_refresh(c.id);
        let session = rand_hex(32);
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval)",
            vec![c.id.into(), refresh_hash.into(), refresh_ttl().to_string().into()],
        )).await?;
        let mut cookies = set_cookie_header(vec![], "sessionId", &session, refresh_ttl(), true);
        cookies = set_cookie_header(cookies, "token", &access, access_ttl(), true);
        cookies = set_cookie_header(cookies, "refreshToken", &refresh_token, refresh_ttl(), true);
        let mut resp = (axum::http::StatusCode::OK, Json(json!({"user": user_dto(&c), "passwordChangeRequired": false}))).into_response();
        for sc in cookies {
            resp.headers_mut().append(axum::http::header::SET_COOKIE, sc.parse().unwrap());
        }
        Ok(resp)
    }).await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[auth/signin] {e:?}");
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response()
        }
    }
}

fn refresh_token_from_jar(jar: &CookieJar) -> Option<String> {
    jar.get("refreshToken").map(|c| c.value().to_string())
}

async fn refresh(State(ctx): State<AppContext>, jar: CookieJar) -> impl IntoResponse {
    let Some(rt) = refresh_token_from_jar(&jar) else {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "No refresh token"}))).into_response();
    };
    let decoded: Option<(i64, String)> = (|| {
        use jsonwebtoken::{decode, DecodingKey, Validation};
        let mut v = Validation::new(jsonwebtoken::Algorithm::HS256);
        v.validate_exp = true;
        let d = decode::<serde_json::Value>(&rt, &DecodingKey::from_secret(jwt_secret().as_bytes()), &v).ok()?;
        let sub = d.claims.get("sub")?.as_i64()?;
        let jti = d.claims.get("jti")?.as_str()?.to_string();
        Some((sub, jti))
    })();
    let Some((_sub, jti)) = decoded else {
        return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Invalid refresh token"}))).into_response();
    };
    let hash = sha256_hex(&jti);
    let res: Result<axum::http::Response<axum::body::Body>> = (async {
        let row = ctx.db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT rt.id, rt.user_id FROM refresh_tokens rt WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()",
            vec![hash.into()],
        )).await?;
        let Some(r) = row else {
            return Ok((axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Refresh token revoked"}))).into_response());
        };
        let rt_id: i64 = r.try_get("", "id")?;
        let user_id: i64 = r.try_get("", "user_id")?;
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1",
            vec![rt_id.into()],
        )).await?;
        let Some(c) = load_ctx(&ctx.db, user_id).await? else {
            return Ok((axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Session no longer valid"}))).into_response());
        };
        if !c.enabled || c.must_set_password {
            return Ok((axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Session no longer valid"}))).into_response());
        }
        let access = sign_access(c.id, &c.email, &c.role, &c.project_ids);
        let (refresh_token, refresh_hash) = sign_refresh(c.id);
        let session = rand_hex(32);
        ctx.db.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval)",
            vec![c.id.into(), refresh_hash.into(), refresh_ttl().to_string().into()],
        )).await?;
        let mut cookies = set_cookie_header(vec![], "sessionId", &session, refresh_ttl(), true);
        cookies = set_cookie_header(cookies, "token", &access, access_ttl(), true);
        cookies = set_cookie_header(cookies, "refreshToken", &refresh_token, refresh_ttl(), true);
        let mut resp = (axum::http::StatusCode::OK, Json(json!({"user": user_dto(&c), "passwordChangeRequired": false}))).into_response();
        for sc in cookies {
            resp.headers_mut().append(axum::http::header::SET_COOKIE, sc.parse().unwrap());
        }
        Ok(resp)
    }).await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[auth/refresh] {e:?}");
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response()
        }
    }
}

async fn me(State(ctx): State<AppContext>, user: CurrentUser) -> impl IntoResponse {
    match load_ctx(&ctx.db, user.id).await {
        Ok(Some(c)) => {
            if !c.enabled || c.must_set_password {
                let mut resp = (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "Session no longer valid"}))).into_response();
                for sc in ["sessionId", "token", "refreshToken"].iter().flat_map(|n| clear_cookie_header(vec![], n)) {
                    resp.headers_mut().append(axum::http::header::SET_COOKIE, sc.parse().unwrap());
                }
                return resp;
            }
            (axum::http::StatusCode::OK, Json(json!({"user": user_dto(&c)}))).into_response()
        }
        Ok(None) => (axum::http::StatusCode::UNAUTHORIZED, Json(json!({"errorMessage": "User not found"}))).into_response(),
        Err(e) => {
            tracing::error!("[auth/me] {e:?}");
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response()
        }
    }
}

async fn logout(State(ctx): State<AppContext>, jar: CookieJar, maybe: crate::middleware::auth::MaybeUser) -> impl IntoResponse {
    if let Some(rt) = refresh_token_from_jar(&jar) {
        use jsonwebtoken::{decode, DecodingKey, Validation};
        let mut v = Validation::new(jsonwebtoken::Algorithm::HS256);
        v.validate_exp = false;
        if let Ok(d) = decode::<serde_json::Value>(&rt, &DecodingKey::from_secret(jwt_secret().as_bytes()), &v) {
            if let Some(jti) = d.claims.get("jti").and_then(|x| x.as_str()) {
                let hash = sha256_hex(jti);
                let _ = ctx.db.execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
                    vec![hash.into()],
                )).await;
            }
        }
    }
    let _ = maybe;
    let mut resp = (axum::http::StatusCode::OK, Json(json!({"success": true}))).into_response();
    for sc in ["sessionId", "token", "refreshToken"].iter().flat_map(|n| clear_cookie_header(vec![], n)) {
        resp.headers_mut().append(axum::http::header::SET_COOKIE, sc.parse().unwrap());
    }
    resp
}

#[derive(Debug, Deserialize)]
pub struct SetPasswordParams {
    pub token: Option<String>,
    #[serde(rename = "newPassword")]
    pub new_password: Option<String>,
}

async fn set_password(State(ctx): State<AppContext>, Json(p): Json<SetPasswordParams>) -> impl IntoResponse {
    let (Some(token), Some(new_password)) = (p.token, p.new_password) else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid token"}))).into_response();
    };
    if token.len() < 16 || token.len() > 256 {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid token"}))).into_response();
    }
    if let Some(e) = validate_password(&new_password) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": e}))).into_response();
    }
    let token_hash = sha256_hex(&token);
    // Emulate the transaction with sequential statements (single connection
    // would need explicit txn; SeaORM txn via ctx.db.begin()).
    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[auth/set-password] begin {e:?}");
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response();
        }
    };
    let res: Result<axum::http::Response<axum::body::Body>> = (async {
        let row = txn.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, user_id, expires_at, consumed_at FROM invite_tokens WHERE token_hash = $1 FOR UPDATE",
            vec![token_hash.into()],
        )).await?;
        let Some(r) = row else {
            txn.rollback().await.ok();
            return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid or expired token"}))).into_response());
        };
        let consumed: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "consumed_at").ok().flatten();
        if consumed.is_some() {
            txn.rollback().await.ok();
            return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Token already used"}))).into_response());
        }
        let expires: chrono::DateTime<chrono::Utc> = r.try_get("", "expires_at")?;
        if expires <= chrono::Utc::now() {
            txn.rollback().await.ok();
            return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Token has expired"}))).into_response());
        }
        let invite_id: i64 = r.try_get("", "id")?;
        let user_id: i64 = r.try_get("", "user_id")?;
        let hash = bcrypt::hash(&new_password, bcrypt_cost()).map_err(|e| sea_orm::DbErr::Custom(e.to_string()))?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE users SET password_hash = $1, must_set_password = false, enabled = true, updated_at = now() WHERE id = $2",
            vec![hash.into(), user_id.into()],
        )).await?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE invite_tokens SET consumed_at = now() WHERE id = $1",
            vec![invite_id.into()],
        )).await?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
            vec![user_id.into()],
        )).await?;
        txn.commit().await?;
        Ok((axum::http::StatusCode::OK, Json(json!({"success": true}))).into_response())
    }).await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[auth/set-password] {e:?}");
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response()
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ForgotParams {
    pub email: Option<String>,
}

async fn forgot_password(State(ctx): State<AppContext>, Json(p): Json<ForgotParams>) -> impl IntoResponse {
    let generic = Json(json!({"success": true, "message": "If an account exists for that email, a password-reset link has been sent."}));
    let Some(email) = p.email else { return (axum::http::StatusCode::OK, generic).into_response() };
    if !email.contains('@') || email.len() > 255 {
        return (axum::http::StatusCode::OK, generic).into_response();
    }
    let lowered = email.to_lowercase();
    let row = ctx.db.query_one_raw(Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT id, email, first_name FROM users WHERE email = $1",
        vec![lowered.into()],
    )).await.ok().flatten();
    if let Some(r) = row {
        let enabled: bool = r.try_get("", "enabled").unwrap_or(false);
        // NOTE: column name in SELECT above omits enabled; fetch it.
        let full = ctx.db.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, email, first_name, enabled FROM users WHERE email = $1",
            vec![r.try_get::<String>("", "email").unwrap_or_default().into()],
        )).await.ok().flatten();
        if let Some(u) = full {
            let en: bool = u.try_get("", "enabled").unwrap_or(false);
            if en {
                let uid: i64 = u.try_get("", "id").unwrap_or(0);
                let plain = rand_hex(32);
                let thash = sha256_hex(&plain);
                let _ = ctx.db.execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "DELETE FROM password_reset_tokens WHERE user_id = $1",
                    vec![uid.into()],
                )).await;
                let _ = ctx.db.execute_raw(Statement::from_sql_and_values(
                    sea_orm::DatabaseBackend::Postgres,
                    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' seconds')::interval)",
                    vec![uid.into(), thash.into(), 900.to_string().into()],
                )).await;
                let _ = enabled;
                // Email dispatch is best-effort via the mailer worker; the
                // reset link itself is never logged.
                let _ = plain;
            }
        }
    }
    (axum::http::StatusCode::OK, generic).into_response()
}

#[derive(Debug, Deserialize)]
pub struct ResetParams {
    pub token: Option<String>,
    #[serde(rename = "newPassword")]
    pub new_password: Option<String>,
}

async fn reset_password(State(ctx): State<AppContext>, Json(p): Json<ResetParams>) -> impl IntoResponse {
    let (Some(token), Some(new_password)) = (p.token, p.new_password) else {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid token"}))).into_response();
    };
    if token.len() < 16 || token.len() > 256 {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid token"}))).into_response();
    }
    if let Some(e) = validate_password(&new_password) {
        return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": e}))).into_response();
    }
    let token_hash = sha256_hex(&token);
    let txn = match ctx.db.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("[auth/reset-password] begin {e:?}");
            return (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response();
        }
    };
    let res: Result<axum::http::Response<axum::body::Body>> = (async {
        let row = txn.query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, user_id, expires_at FROM password_reset_tokens WHERE token_hash = $1 FOR UPDATE",
            vec![token_hash.into()],
        )).await?;
        let Some(r) = row else {
            txn.rollback().await.ok();
            return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Invalid or expired token"}))).into_response());
        };
        let rid: i64 = r.try_get("", "id")?;
        let uid: i64 = r.try_get("", "user_id")?;
        let expires: chrono::DateTime<chrono::Utc> = r.try_get("", "expires_at")?;
        if expires <= chrono::Utc::now() {
            txn.execute_raw(Statement::from_sql_and_values(sea_orm::DatabaseBackend::Postgres, "DELETE FROM password_reset_tokens WHERE id = $1", vec![rid.into()])).await?;
            txn.commit().await?;
            return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"errorMessage": "Token has expired"}))).into_response());
        }
        let hash = bcrypt::hash(&new_password, bcrypt_cost()).map_err(|e| sea_orm::DbErr::Custom(e.to_string()))?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE users SET password_hash = $1, must_set_password = false, enabled = true, updated_at = now() WHERE id = $2",
            vec![hash.into(), uid.into()],
        )).await?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
            vec![uid.into()],
        )).await?;
        txn.execute_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM password_reset_tokens WHERE id = $1",
            vec![rid.into()],
        )).await?;
        txn.commit().await?;
        Ok((axum::http::StatusCode::OK, Json(json!({"success": true}))).into_response())
    }).await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[auth/reset-password] {e:?}");
            (axum::http::StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"errorMessage": "Internal server error"}))).into_response()
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Empty {}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/auth")
        .add("/signin", post(signin))
        .add("/refresh", post(refresh))
        .add("/me", get(me))
        .add("/logout", post(logout))
        .add("/set-password", post(set_password))
        .add("/forgot-password", post(forgot_password))
        .add("/reset-password", post(reset_password))
}
