//! Admin CRUD for blog posts. Port of old_backend/routes/blog.js.
//!
//! Routes (all under /api/blog, auth required; mutations admin-only):
//!   GET    /api/blog                      - paged list (endusers scoped)
//!   GET    /api/blog/slug-check           - slug availability (?slug=&projectId=&locale=)
//!   GET    /api/blog/:id                  - single post
//!   POST   /api/blog                      - create (auto-slug, module registry)
//!   PUT    /api/blog/:id                  - partial update (projectId/locale immutable)
//!   POST   /api/blog/:id/publish          - flip to published + landing flag
//!   POST   /api/blog/:id/unpublish        - flip to draft + landing flag
//!   DELETE /api/blog/:id                  - hard delete + landing flag
//!
//! Simplifications vs the Express original:
//!   - Activity logging (logActivity/diffObjects) is skipped: no shared
//!     activity-log helper exists in the Rust port yet.
//!   - body_html sanitization is a hand-rolled allowlist sanitizer
//!     (same tag/attribute policy as lib/sanitize.js); DOMPurify-equivalent
//!     fidelity would need an extra crate (e.g. ammonia).
//!   - Mutations are admin-only (require_admin -> 401/403). The old code
//!     allowed scoped enduser writes; reads stay scoped to assigned projects.
//!   - Landing rebuild flags are written synchronously best-effort
//!     (never fail the request).

use std::collections::HashMap;

use axum::{
    extract::{Path, Query},
    http::StatusCode,
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use serde_json::json;

use crate::middleware::auth::{CurrentUser, MaybeUser, require_admin, scoped_project_ids};

// ---------------------------------------------------------------------------
// Small response helpers
// ---------------------------------------------------------------------------

fn err(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "errorMessage": msg.into() }))).into_response()
}

fn bad(msg: impl Into<String>) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

fn internal(ctx: &str, e: impl std::fmt::Debug) -> Response {
    tracing::error!("[blog/{ctx}] {e:?}");
    err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
}

fn parse_id(raw: &str) -> Option<i64> {
    raw.parse::<i64>().ok().filter(|n| *n > 0)
}

fn iso(ts: chrono::DateTime<chrono::Utc>) -> String {
    ts.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------
// Validation (mirrors validateBlogPostBody)
// ---------------------------------------------------------------------------

const SLUG_MAX: usize = 50;
const TITLE_MAX: usize = 200;
const EXCERPT_MAX: usize = 500;
const URL_MAX: usize = 2000;
const SEO_TITLE_MAX: usize = 70;
const SEO_DESC_MAX: usize = 200;

fn is_slug(s: &str) -> bool {
    if s.is_empty() || s.len() > SLUG_MAX {
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

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &c) in b.iter().enumerate() {
        if i == 8 || i == 13 || i == 18 || i == 23 {
            if c != b'-' {
                return false;
            }
        } else if !c.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn body_get<'a>(body: &'a serde_json::Value, camel: &str, snake: &str) -> Option<&'a serde_json::Value> {
    body.get(camel).or_else(|| body.get(snake))
}

fn null_or_blank(v: &serde_json::Value) -> bool {
    v.is_null() || v.as_str().map(|s| s.trim().is_empty()).unwrap_or(false)
}

// Validated fields, keyed by DB column name.
struct ValidPost {
    fields: HashMap<String, serde_json::Value>,
}

fn validate_post(body: &serde_json::Value, partial: bool) -> Result<ValidPost, String> {
    let mut out: HashMap<String, serde_json::Value> = HashMap::new();
    let mut errors: Vec<String> = vec![];

    // projectId: required on POST, rejected on PUT.
    match body_get(body, "projectId", "project_id") {
        Some(v) => {
            if partial {
                errors.push("projectId cannot be changed".to_string());
            } else {
                let n = v
                    .as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()));
                match n {
                    Some(n) if n > 0 => {
                        out.insert("project_id".to_string(), json!(n));
                    }
                    _ => errors.push("projectId must be a positive integer".to_string()),
                }
            }
        }
        None => {
            if !partial {
                errors.push("projectId is required".to_string());
            }
        }
    }

    // locale: defaults to 'hu' on POST; never written on PUT (old code
    // 400s when locale is absent on PUT, validates-but-ignores when present).
    match body.get("locale") {
        Some(v) => {
            if v.as_str().map(is_locale).unwrap_or(false) {
                if !partial {
                    out.insert("locale".to_string(), json!(v.as_str().unwrap()));
                }
            } else {
                errors.push(
                    "locale must match /^[a-z]{2}(-[A-Z]{2})?$/ (e.g. 'hu', 'en', 'en-US')"
                        .to_string(),
                );
            }
        }
        None => {
            if !partial {
                out.insert("locale".to_string(), json!("hu"));
            } else {
                errors.push("locale cannot be changed".to_string());
            }
        }
    }

    // title
    match body.get("title") {
        Some(v) => match v.as_str() {
            Some(s) => {
                let t = s.trim();
                if t.is_empty() || t.len() > TITLE_MAX {
                    errors.push(format!("title must be 1..{TITLE_MAX} chars"));
                } else {
                    out.insert("title".to_string(), json!(t));
                }
            }
            None => errors.push("title must be a string".to_string()),
        },
        None => {
            if !partial {
                errors.push("title is required".to_string());
            }
        }
    }

    // slug (optional)
    if let Some(v) = body.get("slug") {
        match v.as_str() {
            Some(s) => {
                let t = s.trim();
                if !is_slug(t) {
                    errors.push(format!(
                        "slug must be 1..{SLUG_MAX} chars, lowercase kebab-case (a-z, 0-9, hyphens)"
                    ));
                } else {
                    out.insert("slug".to_string(), json!(t));
                }
            }
            None => errors.push("slug must be a string".to_string()),
        }
    }

    // excerpt / coverImageUrl / seoTitle / seoDescription / ogImageUrl /
    // canonicalUrl: optional, empty -> null, length-capped.
    let capped: &[(&str, &str, usize, &str)] = &[
        ("excerpt", "excerpt", EXCERPT_MAX, "excerpt"),
        ("coverImageUrl", "cover_image_url", URL_MAX, "coverImageUrl"),
        ("seoTitle", "seo_title", SEO_TITLE_MAX, "seoTitle"),
        ("seoDescription", "seo_description", SEO_DESC_MAX, "seoDescription"),
        ("ogImageUrl", "og_image_url", URL_MAX, "ogImageUrl"),
        ("canonicalUrl", "canonical_url", URL_MAX, "canonicalUrl"),
    ];
    for (camel, col, max, label) in capped {
        let snake = col;
        match body_get(body, camel, snake) {
            Some(v) => {
                if null_or_blank(v) {
                    out.insert(col.to_string(), serde_json::Value::Null);
                } else if let Some(s) = v.as_str() {
                    if s.trim().len() > *max {
                        errors.push(format!("{label} must be at most {max} chars"));
                    } else {
                        out.insert(col.to_string(), json!(s.trim()));
                    }
                } else {
                    errors.push(format!("{label} must be a string"));
                }
            }
            None => {
                if !partial {
                    out.insert(col.to_string(), serde_json::Value::Null);
                }
            }
        }
    }

    // bodyHtml (required on POST, sanitized at write time)
    match body_get(body, "bodyHtml", "body_html") {
        Some(v) => match v.as_str() {
            Some(s) => {
                if s.is_empty() {
                    errors.push("bodyHtml must not be empty".to_string());
                } else {
                    out.insert("body_html".to_string(), json!(sanitize_blog_body(s)));
                }
            }
            None => errors.push("bodyHtml must be a string".to_string()),
        },
        None => {
            if !partial {
                errors.push("bodyHtml is required".to_string());
            }
        }
    }

    // bodyJson (optional object)
    match body_get(body, "bodyJson", "body_json") {
        Some(v) => {
            if v.is_null() {
                if !partial {
                    out.insert("body_json".to_string(), serde_json::Value::Null);
                }
            } else if v.is_object() {
                out.insert("body_json".to_string(), v.clone());
            } else {
                errors.push("bodyJson must be a JSON object".to_string());
            }
        }
        None => {
            if !partial {
                out.insert("body_json".to_string(), serde_json::Value::Null);
            }
        }
    }

    // status
    match body.get("status") {
        Some(v) => match v.as_str() {
            Some(s) if ["draft", "published", "archived"].contains(&s) => {
                out.insert("status".to_string(), json!(s));
            }
            _ => errors.push("status must be one of draft, published, archived".to_string()),
        },
        None => {
            if !partial {
                out.insert("status".to_string(), json!("draft"));
            }
        }
    }

    // seoKeywords
    match body_get(body, "seoKeywords", "seo_keywords") {
        Some(v) => match v.as_array() {
            Some(arr) => {
                if arr.len() > 20 {
                    errors.push("seoKeywords: maximum 20 entries".to_string());
                } else {
                    let cleaned: Vec<String> = arr
                        .iter()
                        .filter_map(|k| k.as_str())
                        .map(|k| k.trim().to_string())
                        .filter(|k| !k.is_empty())
                        .map(|k| k.chars().take(50).collect())
                        .collect();
                    out.insert("seo_keywords".to_string(), json!(cleaned));
                }
            }
            None => errors.push("seoKeywords must be an array of strings".to_string()),
        },
        None => {
            if !partial {
                out.insert("seo_keywords".to_string(), json!([]));
            }
        }
    }

    // translationGroupId (optional UUID)
    if let Some(v) = body_get(body, "translationGroupId", "translation_group_id") {
        if !v.is_null() {
            match v.as_str() {
                Some(s) if is_uuid(s) => {
                    out.insert("translation_group_id".to_string(), json!(s));
                }
                _ => errors.push("translationGroupId must be a UUID".to_string()),
            }
        }
    }

    if errors.is_empty() {
        Ok(ValidPost { fields: out })
    } else {
        Err(errors.join("; "))
    }
}

// ---------------------------------------------------------------------------
// Hungarian-friendly slugify (mirrors old slugify; accent folding covers
// Hungarian + common Latin letters instead of full NFKD)
// ---------------------------------------------------------------------------

fn fold_char(c: char) -> Option<char> {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' => Some('a'),
        'é' | 'è' | 'ê' | 'ë' => Some('e'),
        'í' | 'ì' | 'î' | 'ï' => Some('i'),
        'ó' | 'ò' | 'ô' | 'õ' => Some('o'),
        'ö' | 'ø' | 'ő' => Some('o'),
        'ú' | 'ù' | 'û' => Some('u'),
        'ü' | 'ű' => Some('u'),
        'ñ' => Some('n'),
        'ç' | 'č' | 'ć' => Some('c'),
        'š' | 'ś' => Some('s'),
        'ž' | 'ź' | 'ż' => Some('z'),
        'ý' | 'ÿ' => Some('y'),
        'ď' | 'đ' => Some('d'),
        'ť' => Some('t'),
        'ň' => Some('n'),
        'ľ' | 'ł' => Some('l'),
        'ř' => Some('r'),
        _ => {
            if c.is_ascii_alphanumeric() {
                Some(c)
            } else {
                None
            }
        }
    }
}

fn slugify(title: &str) -> String {
    let lowered = title.to_lowercase();
    let mut tmp = String::with_capacity(lowered.len());
    for c in lowered.chars() {
        if c == 'ß' {
            tmp.push_str("ss");
        } else if c.is_ascii_alphanumeric() {
            tmp.push(c);
        } else if let Some(f) = fold_char(c) {
            tmp.push(f);
        } else {
            tmp.push('-');
        }
    }
    // collapse runs + trim leading hyphens
    let mut out = String::with_capacity(tmp.len());
    let mut prev_hyphen = true;
    for c in tmp.chars() {
        if c == '-' {
            if !prev_hyphen {
                out.push('-');
                prev_hyphen = true;
            }
        } else {
            out.push(c);
            prev_hyphen = false;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.len() <= SLUG_MAX {
        return out;
    }
    let trunc: String = out.chars().take(SLUG_MAX).collect();
    match trunc.rfind('-') {
        Some(i) if i > 10 => trunc[..i].to_string(),
        _ => trunc,
    }
}

// ---------------------------------------------------------------------------
// Minimal HTML sanitizer mirroring lib/sanitize.js policy
// ---------------------------------------------------------------------------

const ALLOWED_TAGS: &[&str] = &[
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "ul",
    "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "figure", "figcaption", "img",
    "div", "article", "section", "a", "span", "strong", "em", "b", "i", "u", "s", "mark",
    "small", "sub", "sup",
];

const ALLOWED_ATTRS: &[&str] = &[
    "href", "title", "target", "rel", "src", "alt", "width", "height", "loading", "srcset",
    "sizes", "class", "id", "lang", "colspan", "rowspan", "datetime", "data-id", "data-type",
    "data-language", "data-checked",
];

// Tags whose *content* is dropped entirely (scripts, styles, embeds).
const DROP_WITH_CONTENT: &[&str] = &["script", "style", "iframe", "object", "embed"];

fn allowed_url(value: &str) -> bool {
    let v = value.trim_start();
    // block dangerous schemes (data: blocked too — stricter than the old
    // img hook, which only stripped javascript:/vbscript:)
    let lower: String = v.chars().take(12).collect::<String>().to_lowercase();
    for scheme in ["javascript:", "vbscript:", "data:"] {
        if lower.starts_with(scheme) {
            return false;
        }
    }
    // scheme present? must be allowlisted
    if let Some(colon) = v.find(':') {
        let before = &v[..colon];
        if !before.contains('/')
            && !before.contains('?')
            && !before.contains('#')
            && !before.contains(' ')
        {
            let s = before.to_lowercase();
            return ["http", "https", "mailto", "tel", "ftp"].contains(&s.as_str());
        }
    }
    true
}

fn sanitize_attr(tag: &str, name: &str, value: &str) -> Option<(String, String)> {
    let n = name.to_lowercase();
    if !ALLOWED_ATTRS.contains(&n.as_str()) {
        return None;
    }
    if n.starts_with("on") || n == "style" || n == "xmlns" {
        return None;
    }
    if (n == "href" || n == "src" || n == "srcset") && !allowed_url(value) {
        return None;
    }
    let _ = tag;
    Some((n, value.to_string()))
}

fn escape_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn sanitize_blog_body(html: &str) -> String {
    let bytes = html.as_bytes();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    let mut skip_tag: Option<String> = None; // inside script/style/... content
    while i < bytes.len() {
        if skip_tag.is_some() {
            if bytes[i] == b'<' && i + 1 < bytes.len() && bytes[i + 1] == b'/' {
                if let Some(end) = html[i..].find('>') {
                    let name: String = html[i + 2..i + end]
                        .trim()
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric())
                        .collect::<String>()
                        .to_lowercase();
                    if Some(&name) == skip_tag.as_ref() {
                        skip_tag = None;
                    }
                    i += end + 1;
                    continue;
                }
            }
            i += 1;
            continue;
        }
        if bytes[i] != b'<' {
            let next = html[i..].find('<').map(|p| i + p).unwrap_or(html.len());
            out.push_str(&html[i..next]);
            i = next;
            continue;
        }
        if html[i..].starts_with("<!--") {
            if let Some(end) = html[i..].find("-->") {
                i += end + 3;
            } else {
                break;
            }
            continue;
        }
        // find tag end (respect quotes)
        let mut j = i + 1;
        let mut quote: Option<u8> = None;
        while j < bytes.len() {
            let c = bytes[j];
            if let Some(qm) = quote {
                if c == qm {
                    quote = None;
                }
            } else if c == b'"' || c == b'\'' {
                quote = Some(c);
            } else if c == b'>' {
                break;
            }
            j += 1;
        }
        if j >= bytes.len() {
            out.push_str(&html[i..]);
            break;
        }
        let inner = &html[i + 1..j];
        i = j + 1;
        let t = inner.trim();
        let is_close = t.starts_with('/');
        let name: String = t
            .trim_start_matches('/')
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('/')
            .to_lowercase();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        if DROP_WITH_CONTENT.contains(&name.as_str()) {
            if !is_close {
                skip_tag = Some(name);
            }
            continue;
        }
        if !ALLOWED_TAGS.contains(&name.as_str()) {
            continue; // drop tag, keep content
        }
        if is_close {
            out.push_str(&format!("</{name}>"));
            continue;
        }
        // parse attributes
        let rest = t[name.len()..].trim().trim_end_matches('/').trim();
        let mut attrs: Vec<(String, String)> = vec![];
        let rb = rest.as_bytes();
        let mut k = 0usize;
        while k < rb.len() {
            while k < rb.len() && rb[k].is_ascii_whitespace() {
                k += 1;
            }
            if k >= rb.len() {
                break;
            }
            let ns = k;
            while k < rb.len() && !rb[k].is_ascii_whitespace() && rb[k] != b'=' {
                k += 1;
            }
            let aname = rest[ns..k].to_string();
            while k < rb.len() && rb[k].is_ascii_whitespace() {
                k += 1;
            }
            let mut aval = String::new();
            if k < rb.len() && rb[k] == b'=' {
                k += 1;
                while k < rb.len() && rb[k].is_ascii_whitespace() {
                    k += 1;
                }
                if k < rb.len() && (rb[k] == b'"' || rb[k] == b'\'') {
                    let qm = rb[k];
                    k += 1;
                    let vs = k;
                    while k < rb.len() && rb[k] != qm {
                        k += 1;
                    }
                    aval = rest[vs..k].to_string();
                    if k < rb.len() {
                        k += 1;
                    }
                } else {
                    let vs = k;
                    while k < rb.len() && !rb[k].is_ascii_whitespace() {
                        k += 1;
                    }
                    aval = rest[vs..k].to_string();
                }
            }
            if !aname.is_empty() {
                if let Some((n, v)) = sanitize_attr(&name, &aname, &aval) {
                    if !attrs.iter().any(|(a, _)| a == &n) {
                        attrs.push((n, v));
                    }
                }
            }
        }
        // force safe rel on target=_blank
        if name == "a" && attrs.iter().any(|(n, v)| n == "target" && v == "_blank") {
            match attrs.iter_mut().find(|(n, _)| n == "rel") {
                Some((_, v)) => *v = "noopener noreferrer".to_string(),
                None => attrs.push(("rel".to_string(), "noopener noreferrer".to_string())),
            }
        }
        out.push('<');
        out.push_str(&name);
        for (n, v) in &attrs {
            out.push(' ');
            out.push_str(n);
            out.push_str("=\"");
            out.push_str(&escape_attr(v));
            out.push('"');
        }
        if ["br", "hr", "img"].contains(&name.as_str()) {
            out.push_str(" />");
        } else {
            out.push('>');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Landing rebuild flag (best-effort, never fails the request)
// ---------------------------------------------------------------------------

fn flag_dir() -> String {
    if let Ok(d) = std::env::var("LANDING_FLAGS_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    if let Ok(d) = std::env::var("LANDING_REBUILD_FLAG_DIR") {
        if !d.trim().is_empty() {
            return d;
        }
    }
    "/var/triggers/landing-rebuild".to_string()
}

fn write_landing_flag(
    domain: &str,
    repo_dir: &str,
    build_command: Option<String>,
    reason: String,
) {
    if domain.trim().is_empty() || repo_dir.trim().is_empty() {
        return;
    }
    let primary = flag_dir();
    let dir = if std::fs::create_dir_all(&primary).is_ok() {
        primary
    } else if std::fs::create_dir_all("./.landing-flags").is_ok() {
        "./.landing-flags".to_string()
    } else {
        return;
    };
    let ts = chrono::Utc::now().timestamp_millis();
    let mut nonce = String::with_capacity(8);
    for b in ts.to_le_bytes().iter().take(4) {
        nonce.push_str(&format!("{b:02x}"));
    }
    let safe: String = domain
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let path = format!("{dir}/{safe}-{ts}-{nonce}.flag");
    let payload = json!({
        "domain": domain,
        "repoDir": repo_dir,
        "buildCommand": build_command.unwrap_or_else(|| "npm run build:content-only".to_string()),
        "reason": reason,
        "buildEnv": {},
        "queuedAt": iso(chrono::Utc::now()),
    });
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&payload).unwrap_or_default());
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

const POST_SELECT: &str = "b.id, b.project_id, p.name AS project_name, b.slug, b.locale, b.title, b.excerpt, b.cover_image_url, b.body_html, b.body_json, b.status, b.seo_title, b.seo_description, b.seo_keywords, b.og_image_url, b.canonical_url, b.published_at, b.created_at, b.updated_at, b.created_by, b.translation_group_id::text AS translation_group_id";

fn dto_from_row(r: &sea_orm::QueryResult) -> Result<serde_json::Value, sea_orm::DbErr> {
    let published: Option<chrono::DateTime<chrono::Utc>> = r.try_get("", "published_at")?;
    let created: chrono::DateTime<chrono::Utc> = r.try_get("", "created_at")?;
    let updated: chrono::DateTime<chrono::Utc> = r.try_get("", "updated_at")?;
    let body_json: Option<serde_json::Value> = r.try_get("", "body_json")?;
    let keywords: Vec<String> = r.try_get("", "seo_keywords").unwrap_or_default();
    Ok(json!({
        "id": r.try_get::<i64>("", "id")?,
        "projectId": r.try_get::<i64>("", "project_id")?,
        "projectName": r.try_get::<Option<String>>("", "project_name")?,
        "slug": r.try_get::<String>("", "slug")?,
        "locale": r.try_get::<String>("", "locale")?,
        "title": r.try_get::<String>("", "title")?,
        "excerpt": r.try_get::<Option<String>>("", "excerpt")?,
        "coverImageUrl": r.try_get::<Option<String>>("", "cover_image_url")?,
        "bodyHtml": r.try_get::<String>("", "body_html")?,
        "bodyJson": body_json,
        "status": r.try_get::<String>("", "status")?,
        "seoTitle": r.try_get::<Option<String>>("", "seo_title")?,
        "seoDescription": r.try_get::<Option<String>>("", "seo_description")?,
        "seoKeywords": keywords,
        "ogImageUrl": r.try_get::<Option<String>>("", "og_image_url")?,
        "canonicalUrl": r.try_get::<Option<String>>("", "canonical_url")?,
        "publishedAt": published.map(iso),
        "createdAt": iso(created),
        "updatedAt": iso(updated),
        "createdBy": r.try_get::<Option<i64>>("", "created_by")?,
        "translationGroupId": r.try_get::<Option<String>>("", "translation_group_id")?,
    }))
}

async fn fetch_post(
    db: &sea_orm::DatabaseConnection,
    id: i64,
) -> Result<Option<serde_json::Value>, sea_orm::DbErr> {
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        &format!(
            "SELECT {POST_SELECT} FROM blog_posts b JOIN projects p ON p.id = b.project_id WHERE b.id = $1"
        ),
        vec![id.into()],
    );
    let row = db.query_one_raw(stmt).await?;
    match row {
        None => Ok(None),
        Some(r) => Ok(Some(dto_from_row(&r)?)),
    }
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

fn first<'a>(q: &'a HashMap<String, Vec<String>>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| q.get(*k))
        .and_then(|v| v.first())
        .map(|s| s.as_str())
}

fn queries_of(q: &HashMap<String, Vec<String>>) -> Vec<String> {
    q.get("queries")
        .map(|v| {
            v.iter()
                .filter(|s| !s.trim().is_empty())
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

fn scoped_clause(scoped: &Option<Vec<i64>>, params: &mut Vec<sea_orm::Value>) -> String {
    match scoped {
        None => String::new(),
        Some(ids) => {
            use sea_orm::sea_query::{ArrayType, Value as QV};
            params.push(QV::Array(
                ArrayType::BigInt,
                Some(Box::new(
                    ids.iter().map(|x| QV::BigInt(Some(*x))).collect(),
                )),
            ));
            format!("b.project_id = ANY(${}::bigint[])", params.len())
        }
    }
}

fn is_unique_violation(e: &sea_orm::DbErr) -> bool {
    format!("{e:?}").contains("23505")
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async fn list(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> impl IntoResponse {
    let page = first(&q, &["page"])
        .and_then(|s| s.parse().ok())
        .map(|n: i64| n.max(0))
        .unwrap_or(0);
    let size = first(&q, &["size"])
        .and_then(|s| s.parse::<i64>().ok())
        .map(|n| n.clamp(1, 100))
        .unwrap_or(10);
    let sort_field = first(&q, &["sortField"]).unwrap_or("updatedAt");
    let sort_order = if first(&q, &["sortOrder"]) == Some("asc") {
        "asc"
    } else {
        "desc"
    };
    let queries = queries_of(&q);
    let filter_type = first(&q, &["filterType"]).unwrap_or("any");
    let scoped = scoped_project_ids(&user);

    let sort_col = match sort_field {
        "id" => "id",
        "title" => "title",
        "slug" => "slug",
        "status" => "status",
        "locale" => "locale",
        "publishedAt" => "published_at",
        "createdAt" => "created_at",
        _ => "updated_at",
    };
    let dir = if sort_order == "asc" { "ASC" } else { "DESC" };

    let mut conds: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];

    if let Some(pid) = first(&q, &["projectId", "project_id"])
        .and_then(|s| s.parse::<i64>().ok())
        .filter(|n| *n > 0)
    {
        params.push(pid.into());
        conds.push(format!("b.project_id = ${}", params.len()));
    }
    if let Some(s) = first(&q, &["status"]) {
        if !s.is_empty() {
            if !["draft", "published", "archived"].contains(&s) {
                return bad("Invalid filter parameter");
            }
            params.push(s.to_string().into());
            conds.push(format!("b.status = ${}", params.len()));
        }
    }
    if let Some(s) = first(&q, &["locale"]) {
        if !s.is_empty() {
            if !is_locale(s) {
                return bad("Invalid filter parameter");
            }
            params.push(s.to_string().into());
            conds.push(format!("b.locale = ${}", params.len()));
        }
    }
    let conj = if filter_type == "all" { " AND " } else { " OR " };
    let mut search_parts: Vec<String> = vec![];
    for term in &queries {
        params.push(format!("%{term}%").into());
        let ph = format!("${}", params.len());
        search_parts.push(format!(
            "(b.title ILIKE {ph} OR b.slug ILIKE {ph} OR b.excerpt ILIKE {ph})"
        ));
    }
    if !search_parts.is_empty() {
        conds.push(search_parts.join(conj));
    }
    let scope_sql = scoped_clause(&scoped, &mut params);
    if !scope_sql.is_empty() {
        conds.push(scope_sql);
    }
    let where_sql = if conds.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conds.join(" AND "))
    };
    let order = format!("ORDER BY {sort_col} {dir}, id DESC");
    let offset = page * size;

    let count_sql = format!(
        "SELECT COUNT(*)::int AS total FROM blog_posts b JOIN projects p ON p.id = b.project_id {where_sql}"
    );
    let total: i64 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &count_sql,
            params.clone(),
        ))
        .await
    {
        Ok(Some(r)) => r.try_get::<i32>("", "total").map(|n| n as i64).unwrap_or(0),
        Ok(None) => 0,
        Err(e) => return internal("list", e),
    };
    let mut dparams = params;
    dparams.push(size.into());
    dparams.push(offset.into());
    let lp = dparams.len() - 1;
    let op = dparams.len();
    let data_sql = format!(
        "SELECT {POST_SELECT} FROM blog_posts b JOIN projects p ON p.id = b.project_id {where_sql} {order} LIMIT ${lp} OFFSET ${op}"
    );
    let rows = match ctx
        .db
        .query_all_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &data_sql,
            dparams,
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("list", e),
    };
    let mut content = vec![];
    for r in &rows {
        match dto_from_row(r) {
            Ok(d) => content.push(d),
            Err(e) => return internal("list", e),
        }
    }
    let total_pages = (((total.max(0)) as f64) / (size as f64)).ceil() as i64;
    let total_pages = total_pages.max(1);
    let sorted = first(&q, &["sortField"]).is_some();
    (
        StatusCode::OK,
        Json(json!({
            "totalPages": total_pages,
            "totalElements": total,
            "pageable": { "paged": true, "pageSize": size, "pageNumber": page, "unpaged": false, "offset": offset, "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false } },
            "numberOfElements": content.len(),
            "size": size,
            "content": content,
            "number": page,
            "sort": { "sorted": sorted, "unsorted": !sorted, "empty": false },
            "first": page == 0,
            "last": page == total_pages - 1,
            "empty": content.is_empty(),
        })),
    )
        .into_response()
}

async fn slug_check(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Query(q): Query<HashMap<String, Vec<String>>>,
) -> impl IntoResponse {
    let slug = first(&q, &["slug"]).unwrap_or("").trim().to_string();
    let project_id = first(&q, &["projectId", "project_id"]).and_then(|s| s.parse::<i64>().ok());
    let locale = first(&q, &["locale"]).unwrap_or("hu");
    if !is_slug(&slug) {
        return bad("Invalid slug");
    }
    let Some(pid) = project_id.filter(|n| *n > 0) else {
        return bad("Invalid projectId");
    };
    if !is_locale(locale) {
        return bad("Invalid locale");
    }
    if user.role != "admin" && !user.project_ids.contains(&pid) {
        return err(StatusCode::NOT_FOUND, "Project not found");
    }
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "SELECT 1 AS one FROM blog_posts WHERE project_id = $1 AND slug = $2 AND locale = $3 LIMIT 1",
        vec![pid.into(), slug.clone().into(), locale.to_string().into()],
    );
    match ctx.db.query_one_raw(stmt).await {
        Ok(row) => (
            StatusCode::OK,
            Json(json!({ "available": row.is_none(), "slug": slug })),
        )
            .into_response(),
        Err(e) => internal("slug-check", e),
    }
}

async fn get_one(
    State(ctx): State<AppContext>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let Some(pid) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let scoped = scoped_project_ids(&user);
    let mut params: Vec<sea_orm::Value> = vec![pid.into()];
    let mut sql = format!(
        "SELECT {POST_SELECT} FROM blog_posts b JOIN projects p ON p.id = b.project_id WHERE b.id = $1"
    );
    let scope_sql = scoped_clause(&scoped, &mut params);
    if !scope_sql.is_empty() {
        sql.push_str(&format!(" AND {scope_sql}"));
    }
    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &sql,
            params,
        ))
        .await
    {
        Ok(Some(r)) => match dto_from_row(&r) {
            Ok(d) => (StatusCode::OK, Json(d)).into_response(),
            Err(e) => internal("get", e),
        },
        Ok(None) => err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => internal("get", e),
    }
}

async fn create(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let admin = match require_admin(&u) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let body = if body.is_object() { body } else { json!({}) };
    let v = match validate_post(&body, false) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    let project_id = v.fields["project_id"].as_i64().unwrap();

    match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM projects WHERE id = $1",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(Some(_)) => {}
        Ok(None) => return err(StatusCode::NOT_FOUND, "Project not found"),
        Err(e) => return internal("create", e),
    }

    let mut slug = v
        .fields
        .get("slug")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    if slug.is_empty() {
        slug = slugify(v.fields["title"].as_str().unwrap_or(""));
        if slug.is_empty() {
            return bad("title contains no slugifiable characters; supply a slug explicitly");
        }
    }
    let status = v.fields["status"].as_str().unwrap_or("draft");
    // passed as text; PG coerces to timestamptz on insert
    let published_at: sea_orm::Value = if status == "published" {
        iso(chrono::Utc::now()).into()
    } else {
        sea_orm::Value::String(None)
    };

    // module registry row
    let module_id: i64 = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "INSERT INTO project_modules (project_id, module_type) VALUES ($1, 'blog') ON CONFLICT (project_id, module_type) DO NOTHING RETURNING id",
            vec![project_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => r.try_get("", "id").unwrap_or(0),
        Ok(None) => {
            match ctx
                .db
                .query_one_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT id FROM project_modules WHERE project_id = $1 AND module_type = 'blog'",
                    vec![project_id.into()],
                ))
                .await
            {
                Ok(Some(r)) => r.try_get("", "id").unwrap_or(0),
                Ok(None) => return internal("create", "module registry missing"),
                Err(e) => return internal("create", e),
            }
        }
        Err(e) => return internal("create", e),
    };

    let keywords: Vec<String> = v
        .fields
        .get("seo_keywords")
        .and_then(|k| k.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let body_json: Option<serde_json::Value> =
        v.fields.get("body_json").cloned().filter(|b| !b.is_null());
    let group: Option<String> = v
        .fields
        .get("translation_group_id")
        .and_then(|g| g.as_str())
        .map(|s| s.to_string());
    let str_or_null = |k: &str| -> sea_orm::Value {
        v.fields
            .get(k)
            .and_then(|x| x.as_str())
            .map(|s| s.to_string().into())
            .unwrap_or(sea_orm::Value::String(None))
    };
    use sea_orm::sea_query::{ArrayType, Value as QV};
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "INSERT INTO blog_posts (project_id, module_id, slug, locale, title, excerpt, cover_image_url, body_html, body_json, status, seo_title, seo_description, seo_keywords, og_image_url, canonical_url, published_at, created_by, translation_group_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,COALESCE($18, gen_random_uuid())) RETURNING id",
        vec![
            project_id.into(),
            module_id.into(),
            slug.into(),
            v.fields["locale"].as_str().unwrap_or("hu").to_string().into(),
            v.fields["title"].as_str().unwrap_or("").to_string().into(),
            str_or_null("excerpt"),
            str_or_null("cover_image_url"),
            v.fields["body_html"].as_str().unwrap_or("").to_string().into(),
            body_json.into(),
            status.to_string().into(),
            str_or_null("seo_title"),
            str_or_null("seo_description"),
            QV::Array(
                ArrayType::String,
                Some(Box::new(
                    keywords.into_iter().map(|s| QV::String(Some(s))).collect(),
                )),
            ),
            str_or_null("og_image_url"),
            str_or_null("canonical_url"),
            published_at,
            admin.id.into(),
            group.map(|s| s.into()).unwrap_or(sea_orm::Value::String(None)),
        ],
    );
    let new_id: i64 = match ctx.db.query_one_raw(stmt).await {
        Ok(Some(r)) => r.try_get("", "id").unwrap_or(0),
        Ok(None) => return internal("create", "insert returned nothing"),
        Err(e) => {
            if is_unique_violation(&e) {
                return err(
                    StatusCode::CONFLICT,
                    "A blog post with this slug already exists for this project and locale",
                );
            }
            return internal("create", e);
        }
    };
    match fetch_post(&ctx.db, new_id).await {
        Ok(Some(d)) => (StatusCode::CREATED, Json(d)).into_response(),
        Ok(None) => internal("create", "re-read missing"),
        Err(e) => internal("create", e),
    }
}

async fn update(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let _admin = match require_admin(&u) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let exists = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT id FROM blog_posts WHERE id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(r) => r,
        Err(e) => return internal("update", e),
    };
    if exists.is_none() {
        return err(StatusCode::NOT_FOUND, "Blog post not found");
    }
    let body = if body.is_object() { body } else { json!({}) };
    let v = match validate_post(&body, true) {
        Ok(v) => v,
        Err(e) => return bad(e),
    };
    if v.fields.is_empty() {
        return bad("No fields to update");
    }
    // Build SET clause in fixed column order (validator strips danger).
    let mut sets: Vec<String> = vec![];
    let mut params: Vec<sea_orm::Value> = vec![];
    fn push_set(
        sets: &mut Vec<String>,
        params: &mut Vec<sea_orm::Value>,
        col: &str,
        val: sea_orm::Value,
    ) {
        params.push(val);
        sets.push(format!("{col} = ${}", params.len()));
    }
    if let Some(x) = v.fields.get("title") {
        push_set(&mut sets, &mut params, "title", x.as_str().unwrap_or("").to_string().into());
    }
    if let Some(x) = v.fields.get("slug") {
        push_set(&mut sets, &mut params, "slug", x.as_str().unwrap_or("").to_string().into());
    }
    if let Some(x) = v.fields.get("excerpt") {
        push_set(
            &mut sets,
            &mut params,
            "excerpt",
            x.as_str()
                .map(|s| s.to_string().into())
                .unwrap_or(sea_orm::Value::String(None)),
        );
    }
    if let Some(x) = v.fields.get("cover_image_url") {
        push_set(
            &mut sets,
            &mut params,
            "cover_image_url",
            x.as_str()
                .map(|s| s.to_string().into())
                .unwrap_or(sea_orm::Value::String(None)),
        );
    }
    if let Some(x) = v.fields.get("body_html") {
        push_set(&mut sets, &mut params, "body_html", x.as_str().unwrap_or("").to_string().into());
    }
    if let Some(x) = v.fields.get("body_json") {
        let bj: Option<serde_json::Value> =
            if x.is_null() { None } else { Some(x.clone()) };
        push_set(&mut sets, &mut params, "body_json", bj.into());
    }
    if let Some(x) = v.fields.get("status") {
        push_set(
            &mut sets,
            &mut params,
            "status",
            x.as_str().unwrap_or("draft").to_string().into(),
        );
        if x.as_str() == Some("published") {
            sets.push("published_at = COALESCE(published_at, now())".to_string());
        }
    }
    for (k, col) in [
        ("seo_title", "seo_title"),
        ("seo_description", "seo_description"),
        ("og_image_url", "og_image_url"),
        ("canonical_url", "canonical_url"),
    ] {
        if let Some(x) = v.fields.get(k) {
            push_set(
                &mut sets,
                &mut params,
                col,
                x.as_str()
                    .map(|s| s.to_string().into())
                    .unwrap_or(sea_orm::Value::String(None)),
            );
        }
    }
    if let Some(x) = v.fields.get("seo_keywords") {
        use sea_orm::sea_query::{ArrayType, Value as QV};
        let kw: Vec<String> = x
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|y| y.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        push_set(
            &mut sets,
            &mut params,
            "seo_keywords",
            QV::Array(
                ArrayType::String,
                Some(Box::new(
                    kw.into_iter().map(|s| QV::String(Some(s))).collect(),
                )),
            ),
        );
    }
    if let Some(x) = v.fields.get("translation_group_id") {
        // text -> uuid coercion on write
        push_set(
            &mut sets,
            &mut params,
            "translation_group_id",
            x.as_str().unwrap_or("").to_string().into(),
        );
    }
    params.push(post_id.into());
    let wp = params.len();
    let sql = format!(
        "UPDATE blog_posts SET {} WHERE id = ${wp} RETURNING id",
        sets.join(", ")
    );
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            &sql,
            params,
        ))
        .await
    {
        Ok(_) => {}
        Err(e) => {
            if is_unique_violation(&e) {
                return err(
                    StatusCode::CONFLICT,
                    "A blog post with this slug already exists for this project and locale",
                );
            }
            return internal("update", e);
        }
    }
    match fetch_post(&ctx.db, post_id).await {
        Ok(Some(d)) => (StatusCode::OK, Json(d)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => internal("update", e),
    }
}

async fn publish(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let _admin = match require_admin(&u) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let stmt = Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        "UPDATE blog_posts b SET status = 'published', published_at = COALESCE(b.published_at, now()), updated_at = now() FROM projects p WHERE b.id = $1 AND b.project_id = p.id RETURNING b.id, b.project_id, p.domain_address, p.landing_enabled, p.landing_repo_dir, p.landing_build_command",
        vec![post_id.into()],
    );
    let proj = match ctx.db.query_one_raw(stmt).await {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => return internal("publish", e),
    };
    let enabled: bool = proj.try_get("", "landing_enabled").unwrap_or(false);
    let repo: Option<String> = proj.try_get("", "landing_repo_dir").ok().flatten();
    if enabled {
        if let Some(repo_dir) = repo {
            let domain: String = proj.try_get("", "domain_address").unwrap_or_default();
            let cmd: Option<String> = proj.try_get("", "landing_build_command").ok().flatten();
            write_landing_flag(&domain, &repo_dir, cmd, format!("publish:post:{post_id}"));
        }
    }
    match fetch_post(&ctx.db, post_id).await {
        Ok(Some(d)) => (StatusCode::OK, Json(d)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => internal("publish", e),
    }
}

async fn unpublish(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let _admin = match require_admin(&u) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };
    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "UPDATE blog_posts SET status = 'draft', updated_at = now() WHERE id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            return err(StatusCode::NOT_FOUND, "Blog post not found")
        }
        Ok(_) => {}
        Err(e) => return internal("unpublish", e),
    }
    // Best-effort rebuild lookup (never fails the response).
    if let Ok(Some(meta)) = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT b.project_id, p.domain_address, p.landing_enabled, p.landing_repo_dir, p.landing_build_command FROM blog_posts b JOIN projects p ON p.id = b.project_id WHERE b.id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        let enabled: bool = meta.try_get("", "landing_enabled").unwrap_or(false);
        let repo: Option<String> = meta.try_get("", "landing_repo_dir").ok().flatten();
        if enabled {
            if let Some(repo_dir) = repo {
                let domain: String = meta.try_get("", "domain_address").unwrap_or_default();
                let cmd: Option<String> =
                    meta.try_get("", "landing_build_command").ok().flatten();
                write_landing_flag(&domain, &repo_dir, cmd, format!("unpublish:post:{post_id}"));
            }
        }
    }
    match fetch_post(&ctx.db, post_id).await {
        Ok(Some(d)) => (StatusCode::OK, Json(d)).into_response(),
        Ok(None) => err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => internal("unpublish", e),
    }
}

async fn delete_one(
    State(ctx): State<AppContext>,
    MaybeUser(u): MaybeUser,
    Path(id): Path<String>,
) -> impl IntoResponse {
    let _admin = match require_admin(&u) {
        Ok(a) => a,
        Err(r) => return r,
    };
    let Some(post_id) = parse_id(&id) else {
        return bad("Invalid id");
    };
    let meta = match ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "SELECT b.project_id, b.title, p.domain_address, p.landing_enabled, p.landing_repo_dir, p.landing_build_command, b.slug, b.module_id FROM blog_posts b JOIN projects p ON p.id = b.project_id WHERE b.id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(Some(r)) => r,
        Ok(None) => return err(StatusCode::NOT_FOUND, "Blog post not found"),
        Err(e) => return internal("delete", e),
    };
    let module_id: Option<i64> = meta.try_get("", "module_id").ok().flatten();
    let slug: String = meta.try_get("", "slug").unwrap_or_default();
    let domain: String = meta.try_get("", "domain_address").unwrap_or_default();
    let enabled: bool = meta.try_get("", "landing_enabled").unwrap_or(false);
    let repo: Option<String> = meta.try_get("", "landing_repo_dir").ok().flatten();
    let cmd: Option<String> = meta.try_get("", "landing_build_command").ok().flatten();

    match ctx
        .db
        .execute_raw(Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            "DELETE FROM blog_posts WHERE id = $1",
            vec![post_id.into()],
        ))
        .await
    {
        Ok(r) if r.rows_affected() == 0 => {
            return err(StatusCode::NOT_FOUND, "Blog post not found")
        }
        Ok(_) => {}
        Err(e) => return internal("delete", e),
    }
    if let Some(mid) = module_id {
        let left: i64 = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT COUNT(*)::int AS c FROM blog_posts WHERE module_id = $1",
                vec![mid.into()],
            ))
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i32>("", "c").ok())
            .unwrap_or(1) as i64;
        if left == 0 {
            let _ = ctx
                .db
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "DELETE FROM project_modules WHERE id = $1",
                    vec![mid.into()],
                ))
                .await;
        }
    }
    if enabled {
        if let Some(repo_dir) = repo {
            write_landing_flag(&domain, &repo_dir, cmd, format!("delete:post:{slug}"));
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/blog")
        .add("/", get(list))
        .add("/", post(create))
        .add("/slug-check", get(slug_check))
        .add("/:id", get(get_one))
        .add("/:id", put(update))
        .add("/:id", delete(delete_one))
        .add("/:id/publish", post(publish))
        .add("/:id/unpublish", post(unpublish))
}
