//! Public by-domain read API for landing pages. Port of old_backend/routes/blog-public.js.
//!
//! Routes (under /api/public/blog, NO auth — Host header is the auth):
//!   GET /by-domain/:domain/posts            - published posts (?locale=&since=&limit=)
//!   GET /by-domain/:domain/posts/slugs     - lightweight slug list
//!   GET /by-domain/:domain/posts/:slug      - single post with body
//!   GET /attachments/:filename              - serve cover/inline images
//!
//! Simplifications vs the Express original:
//!   - No in-memory TTL cache (single-process Map in the old code); relies
//!     on Cache-Control headers + nginx/CDN like the old code's mid-tier.
//!   - No express-rate-limit (burst 30/min, sustained 600/h). Add a
//!     tower-governor/tower limit layer if abuse appears.
//!   - Errors keep the `{ errorMessage }` shape and status codes.

use std::collections::HashMap;

use axum::{
    body::Body,
    extract::{Path, Query},
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
    tracing::error!("[blog-public/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn is_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > 50 {
        return false;
    }
    let b = s.as_bytes();
    if b[0] == b'-' || b[b.len() - 1] == b'-' {
        return false;
    }
    let mut prev_hyphen = false;
    for &c in b {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            prev_hyphen = false;
        } else if c == b'-' {
            if prev_hyphen {
                return false;
            }
            prev_hyphen = true;
        } else {
            return false;
        }
    }
    true
}

fn is_locale(s: &str) -> bool {
    let b = s.as_bytes();
    match b.len() {
        2 => b.iter().all(|c| c.is_ascii_lowercase()),
        5 => {
            b[0].is_ascii_lowercase()
                && b[1].is_ascii_lowercase()
                && b[2] == b'-'
                && b[3].is_ascii_uppercase()
                && b[4].is_ascii_uppercase()
        }
        _ => false,
    }
}

struct ResolvedProject {
    id: i64,
    domain_address: Option<String>,
}

async fn resolve_project(
    db: &sea_orm::DatabaseConnection,
    headers: &HeaderMap,
    domain: &str,
) -> Result<Option<ResolvedProject>, sea_orm::DbErr> {
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let host = host.split(':').next().unwrap_or("").to_string();
    let domain = domain.to_lowercase();
    let mut candidates: Vec<String> = vec![];
    if !host.is_empty() {
        candidates.push(host);
    }
    if !domain.is_empty() && !candidates.contains(&domain) {
        candidates.push(domain);
    }
    for c in candidates {
        let row = db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT id, domain_address FROM projects WHERE domain_address = $1 OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $1 LIMIT 1",
                vec![c.into()],
            ))
            .await?;
        if let Some(r) = row {
            return Ok(Some(ResolvedProject {
                id: r.try_get("", "id")?,
                domain_address: r.try_get("", "domain_address").ok().flatten(),
            }));
        }
    }
    Ok(None)
}

fn domain_matches(project: &ResolvedProject, domain: &str) -> bool {
    let normalized = project
        .domain_address
        .as_deref()
        .unwrap_or("")
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_lowercase();
    normalized == domain.to_lowercase()
}

fn with_cache(mut resp: Response, max_age: u32, swr: u32) -> Response {
    if let (Ok(cc), Ok(vary)) = (
        format!("public, max-age={max_age}, stale-while-revalidate={swr}").parse(),
        "Origin, Accept-Encoding".parse(),
    ) {
        resp.headers_mut().insert("cache-control", cc);
        resp.headers_mut().insert("vary", vary);
    }
    resp
}

fn parse_since(raw: Option<&str>) -> Result<Option<String>, Response> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    // Accept RFC3339, naive datetime (assumed UTC), or plain date.
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(raw) {
        return Ok(Some(dt.with_timezone(&chrono::Utc).to_rfc3339()));
    }
    if let Ok(ndt) = chrono::NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S%.f") {
        return Ok(Some(
            ndt.and_utc().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ));
    }
    if let Ok(nd) = chrono::NaiveDate::parse_from_str(raw, "%Y-%m-%d") {
        return Ok(Some(
            ndt_midnight(nd).to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ));
    }
    Err(err(StatusCode::BAD_REQUEST, "since must be a valid ISO-8601 timestamp"))
}

fn ndt_midnight(d: chrono::NaiveDate) -> chrono::DateTime<chrono::Utc> {
    d.and_hms_opt(0, 0, 0)
        .unwrap()
        .and_utc()
}

const PUBLIC_FIELDS: &str = "b.slug, b.locale, b.title, b.excerpt, b.cover_image_url, b.body_html, b.seo_title, b.seo_description, b.seo_keywords, b.og_image_url, b.canonical_url, b.published_at, b.updated_at, b.translation_group_id::text AS translation_group_id";

fn public_dto(r: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let published: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "published_at")?;
    let updated: chrono::DateTime<chrono::Utc> = r.try_get("", "updated_at")?;
    let keywords: Vec<String> = r.try_get("", "seo_keywords").unwrap_or_default();
    let og: Option<String> = r.try_get("", "og_image_url").ok().flatten();
    let cover: Option<String> = r.try_get("", "cover_image_url").ok().flatten();
    Ok(json!({
        "slug": r.try_get::<String>("", "slug")?,
        "locale": r.try_get::<String>("", "locale")?,
        "title": r.try_get::<String>("", "title")?,
        "excerpt": r.try_get::<Option<String>>("", "excerpt")?,
        "coverImageUrl": cover,
        "bodyHtml": r.try_get::<String>("", "body_html")?,
        "seoTitle": r.try_get::<Option<String>>("", "seo_title")?,
        "seoDescription": r.try_get::<Option<String>>("", "seo_description")?,
        "seoKeywords": keywords,
        "ogImageUrl": og.or(cover.clone()),
        "canonicalUrl": r.try_get::<Option<String>>("", "canonical_url")?,
        "publishedAt": published.map(iso),
        "updatedAt": iso(updated),
        "translationGroupId": r.try_get::<Option<String>>("", "translation_group_id")?,
    }))
}

/// Batch-fetch published translations for the given groups (N+1-free).
/// Returns map group_id -> { locale -> { slug, title } }.
async fn translations_for_groups(
    db: &sea_orm::DatabaseConnection,
    project_id: i64,
    groups: &[String],
) -> HashMap<String, HashMap<String, serde_json::Value>> {
    let mut out: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    if groups.is_empty() {
        return out;
    }
    let mut params: Vec<sea_orm::Value> = vec![project_id.into()];
    let mut phs: Vec<String> = vec![];
    for g in groups {
        params.push(g.clone().into());
        phs.push(format!("${}::uuid", params.len()));
    }
    let sql = format!(
        "SELECT translation_group_id::text AS g, slug, locale, title FROM blog_posts WHERE project_id = $1 AND translation_group_id IN ({}) AND status = 'published' ORDER BY locale ASC",
        phs.join(", ")
    );
    let rows = match db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &sql,
            params,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[blog-public/translations] {e:?}");
            return out;
        }
    };
    for r in &rows {
        let g: String = match r.try_get("", "g") {
            Ok(v) => v,
            Err(_) => continue,
        };
        let loc: String = match r.try_get("", "locale") {
            Ok(v) => v,
            Err(_) => continue,
        };
        let slug: String = r.try_get("", "slug").unwrap_or_default();
        let title: String = r.try_get("", "title").unwrap_or_default();
        out.entry(g)
            .or_default()
            .insert(loc, json!({ "slug": slug, "title": title }));
    }
    out
}

async fn list_posts(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(domain): Path<String>,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> Response {
    let locale = q
        .get("locale")
        .and_then(|v| v.first())
        .map(|s| s.as_str())
        .unwrap_or("hu");
    if !is_locale(locale) {
        return err(StatusCode::BAD_REQUEST, "Invalid locale");
    }
    let since = match parse_since(q.get("since").and_then(|v| v.first()).map(|s| s.as_str())) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let limit: i64 = q
        .get("limit")
        .and_then(|v| v.first())
        .and_then(|s| s.parse().ok())
        .map(|n: i64| n.clamp(1, 500))
        .unwrap_or(100);

    let project = match resolve_project(&ctx.db, &headers, &domain).await {
        Ok(Some(p)) => p,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Unknown host"),
        Err(e) => return internal("list", e),
    };
    if !domain_matches(&project, &domain) {
        return err(StatusCode::NOT_FOUND, "Unknown host");
    }

    let mut params: Vec<sea_orm::Value> = vec![project.id.into(), locale.to_string().into()];
    let mut where_sql =
        "b.project_id = $1 AND b.locale = $2 AND b.status = 'published'".to_string();
    if let Some(s) = since {
        params.push(s.into());
        where_sql.push_str(&format!(" AND b.updated_at >= ${}", params.len()));
    }
    params.push(limit.into());
    let lp = params.len();

    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!(
                "SELECT {PUBLIC_FIELDS} FROM blog_posts b WHERE {where_sql} ORDER BY b.updated_at DESC LIMIT ${lp}"
            ),
            params,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("list", e),
    };

    let groups: Vec<String> = {
        let mut g: Vec<String> = rows
            .iter()
            .filter_map(|r| {
                r.try_get::<Option<String>>("", "translation_group_id")
                    .ok()
                    .flatten()
            })
            .collect();
        g.sort();
        g.dedup();
        g
    };
    let by_group = translations_for_groups(&ctx.db, project.id, &groups).await;

    let mut posts = vec![];
    for r in &rows {
        let mut dto = match public_dto(r) {
            Ok(d) => d,
            Err(e) => return internal("list", e),
        };
        let g: Option<String> = r
            .try_get::<Option<String>>("", "translation_group_id")
            .ok()
            .flatten();
        let loc: String = r.try_get("", "locale").unwrap_or_default();
        let mut tr = serde_json::Map::new();
        if let Some(gid) = g {
            if let Some(map) = by_group.get(&gid) {
                for (l, v) in map {
                    if l != &loc {
                        tr.insert(l.clone(), v.clone());
                    }
                }
            }
        }
        dto["translations"] = serde_json::Value::Object(tr);
        posts.push(dto);
    }
    with_cache(
        (StatusCode::OK, Json(json!({ "posts": posts }))).into_response(),
        30,
        120,
    )
}

async fn list_slugs(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path(domain): Path<String>,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> Response {
    let locale = q
        .get("locale")
        .and_then(|v| v.first())
        .map(|s| s.as_str())
        .unwrap_or("hu");
    if !is_locale(locale) {
        return err(StatusCode::BAD_REQUEST, "Invalid locale");
    }
    let since = match parse_since(q.get("since").and_then(|v| v.first()).map(|s| s.as_str())) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let limit: i64 = q
        .get("limit")
        .and_then(|v| v.first())
        .and_then(|s| s.parse().ok())
        .map(|n: i64| n.clamp(1, 1000))
        .unwrap_or(1000);

    let project = match resolve_project(&ctx.db, &headers, &domain).await {
        Ok(Some(p)) => p,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Unknown host"),
        Err(e) => return internal("slugs", e),
    };
    if !domain_matches(&project, &domain) {
        return err(StatusCode::NOT_FOUND, "Unknown host");
    }

    let mut params: Vec<sea_orm::Value> = vec![project.id.into(), locale.to_string().into()];
    let mut where_sql =
        "b.project_id = $1 AND b.locale = $2 AND b.status = 'published'".to_string();
    if let Some(s) = since {
        params.push(s.into());
        where_sql.push_str(&format!(" AND b.updated_at >= ${}", params.len()));
    }
    params.push(limit.into());
    let lp = params.len();

    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!(
                "SELECT b.slug, b.locale, b.updated_at FROM blog_posts b WHERE {where_sql} ORDER BY b.updated_at DESC LIMIT ${lp}"
            ),
            params,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("slugs", e),
    };
    let mut slugs = vec![];
    for r in &rows {
        let updated: chrono::DateTime<chrono::Utc> = match r.try_get("", "updated_at") {
            Ok(v) => v,
            Err(e) => return internal("slugs", e),
        };
        slugs.push(json!({
            "slug": r.try_get::<String>("", "slug").unwrap_or_default(),
            "locale": r.try_get::<String>("", "locale").unwrap_or_default(),
            "updatedAt": iso(updated),
        }));
    }
    with_cache(
        (StatusCode::OK, Json(json!({ "slugs": slugs }))).into_response(),
        60,
        300,
    )
}

async fn get_post(
    State(ctx): State<AppContext>,
    headers: HeaderMap,
    Path((domain, slug)): Path<(String, String)>,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> Response {
    if !is_slug(&slug) {
        return err(StatusCode::BAD_REQUEST, "Invalid slug");
    }
    let locale = q
        .get("locale")
        .and_then(|v| v.first())
        .map(|s| s.as_str())
        .unwrap_or("hu");
    if !is_locale(locale) {
        return err(StatusCode::BAD_REQUEST, "Invalid locale");
    }
    let project = match resolve_project(&ctx.db, &headers, &domain).await {
        Ok(Some(p)) => p,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Unknown host"),
        Err(e) => return internal("get", e),
    };
    if !domain_matches(&project, &domain) {
        return err(StatusCode::NOT_FOUND, "Unknown host");
    }

    let row = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &format!(
                "SELECT {PUBLIC_FIELDS} FROM blog_posts b WHERE b.project_id = $1 AND b.slug = $2 AND b.locale = $3 AND b.status = 'published' LIMIT 1"
            ),
            vec![
                project.id.into(),
                slug.into(),
                locale.to_string().into(),
            ],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("get", e),
    };
    let Some(r) = row else {
        return err(StatusCode::NOT_FOUND, "Blog post not found");
    };
    let mut dto = match public_dto(&r) {
        Ok(d) => d,
        Err(e) => return internal("get", e),
    };
    let group: Option<String> = r
        .try_get::<Option<String>>("", "translation_group_id")
        .ok()
        .flatten();
    let mut tr = serde_json::Map::new();
    if let Some(gid) = group {
        let by_group = translations_for_groups(&ctx.db, project.id, &[gid]).await;
        for map in by_group.values() {
            for (l, v) in map {
                if l != locale {
                    tr.insert(l.clone(), v.clone());
                }
            }
        }
    }
    dto["translations"] = serde_json::Value::Object(tr);
    with_cache((StatusCode::OK, Json(dto)).into_response(), 300, 600)
}

fn upload_root() -> String {
    std::env::var("UPLOADS_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "/app/uploads".to_string())
}

fn valid_attachment_filename(name: &str) -> bool {
    let Some(dot) = name.rfind('.') else {
        return false;
    };
    let (base, ext) = (&name[..dot], &name[dot + 1..]);
    if base.len() != 36 {
        return false;
    }
    for (i, c) in base.chars().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if c != '-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    ["webp", "png", "jpg", "jpeg", "avif"].contains(&ext.to_lowercase().as_str())
}

fn content_type_for(ext: &str) -> &'static str {
    match ext.to_lowercase().as_str() {
        "webp" => "image/webp",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

async fn serve_attachment(
    State(ctx): State<AppContext>,
    Path(filename): Path<String>,
) -> Response {
    if !valid_attachment_filename(&filename) {
        return err(StatusCode::BAD_REQUEST, "Invalid filename");
    }
    // Filenames are unguessable UUIDs; the DB maps filename -> post_id so
    // the on-disk layout (UPLOADS_DIR/blog/<post_id>/) stays out of URLs.
    let post_id: i64 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT post_id FROM blog_attachments WHERE stored_filename = $1 LIMIT 1",
            vec![filename.clone().into()],
        ))
        .await
    {
        Ok(Some(r)) => match r.try_get("", "post_id") {
            Ok(id) => id,
            Err(e) => return internal("attachment", e),
        },
        Ok(None) => return err(StatusCode::NOT_FOUND, "Attachment not found"),
        Err(e) => return internal("attachment", e),
    };
    let mut root = upload_root();
    if root == "/app/uploads" && !std::path::Path::new(&root).exists() {
        root = "./uploads".to_string();
    }
    let full = format!("{root}/blog/{post_id}/{filename}");
    let data = tokio::task::spawn_blocking(move || std::fs::read(&full)).await;
    let bytes: Vec<u8> = match data {
        Ok(Ok(b)) => b,
        Ok(Err(_)) => return err(StatusCode::GONE, "File is no longer available"),
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "Failed to read file"),
    };
    let ext = filename.rsplit('.').next().unwrap_or("");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", content_type_for(ext))
        .header("content-length", bytes.len().to_string())
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("vary", "Origin, Accept-Encoding")
        .body(Body::from(bytes))
        .unwrap()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/blog")
        .add("/by-domain/:domain/posts", get(list_posts))
        .add("/by-domain/:domain/posts/slugs", get(list_slugs))
        .add("/by-domain/:domain/posts/:slug", get(get_post))
        .add("/attachments/:filename", get(serve_attachment))
}
