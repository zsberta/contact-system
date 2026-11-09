//! Public analytics embed.
//!
//! Public, NO auth (capability is the 22-char secret_token in the path).
//!   GET  /api/public/analytics/:secret_token/script.js — loader script
//!   POST /api/public/analytics/:secret_token/collect  — event ingestion
//!
//! Notes:
//! - Per-IP burst/sustained rate limiting is left to the global middleware.
//! - The POST accepts both application/json and text/plain bodies (the raw
//!   body is JSON-parsed manually).

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use loco_rs::prelude::*;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(json!({ "errorMessage": msg }))).into_response()
}

const EVENT_TYPES: &[&str] = &["pageview", "event"];
const PATH_MAX_LEN: usize = 2000;
const REFERRER_MAX_LEN: usize = 2000;
const LOCALE_MAX_LEN: usize = 10;
const SESSION_ID_MAX_LEN: usize = 64;
const VISITOR_ID_MAX_LEN: usize = 64;
const USER_AGENT_MAX_LEN: usize = 500;
const SCREEN_MAX: i64 = 32768;
const RAW_MAX_KEYS_PER_LEVEL: usize = 30;
const RAW_MAX_DEPTH: usize = 3;
const RAW_MAX_BYTES: usize = 10 * 1024;

fn measure_bag(v: &serde_json::Value, depth: usize, acc: &mut (usize, usize)) {
    if let Some(map) = v.as_object() {
        if map.len() > acc.0 {
            acc.0 = map.len();
        }
        if depth > acc.1 {
            acc.1 = depth;
        }
        if depth > RAW_MAX_DEPTH {
            acc.1 = RAW_MAX_DEPTH + 1;
            return;
        }
        for (_, child) in map {
            if child.is_object() {
                measure_bag(child, depth + 1, acc);
            }
        }
    }
}

fn trim_or_null(v: Option<&serde_json::Value>, max: usize) -> Option<String> {
    let s = v?.as_str()?;
    if s.is_empty() {
        return None;
    }
    Some(if s.len() > max { s[..max].to_string() } else { s.to_string() })
}

fn int_or_null(v: Option<&serde_json::Value>) -> Option<i64> {
    match v {
        Some(serde_json::Value::Number(n)) => {
            let i = n.as_i64()?;
            if i < 0 {
                None
            } else {
                Some(i.min(SCREEN_MAX))
            }
        }
        Some(serde_json::Value::String(s)) if s.chars().all(|c| c.is_ascii_digit()) => {
            let n: i64 = s.parse().ok()?;
            if n < 0 {
                None
            } else {
                Some(n.min(SCREEN_MAX))
            }
        }
        _ => None,
    }
}

fn is_origin_allowed(request_origin: &str, allowed: &[String]) -> bool {
    if request_origin.is_empty() {
        return false;
    }
    let host_of = |s: &str| -> String {
        let lower = s.trim().trim_end_matches('/').to_lowercase();
        let no_scheme = lower
            .strip_prefix("http://")
            .or_else(|| lower.strip_prefix("https://"))
            .unwrap_or(&lower);
        no_scheme
            .split('/')
            .next()
            .unwrap_or("")
            .to_string()
    };
    let req_host = host_of(request_origin);
    if req_host.is_empty() {
        return false;
    }
    for entry in allowed {
        let e = entry.trim().trim_end_matches('/').to_lowercase();
        if e.is_empty() {
            continue;
        }
        if host_of(&e) == req_host {
            return true;
        }
        if let Some(star) = e.find("*.") {
            let suffix = e[star + 2..]
                .trim_start_matches("http://")
                .trim_start_matches("https://");
            let suffix_host = suffix.split(':').next().unwrap_or(suffix);
            let req_bare = req_host.split(':').next().unwrap_or(&req_host);
            if *req_bare == *suffix_host {
                continue;
            }
            if req_bare.len() > suffix_host.len()
                && req_bare.ends_with(&format!(".{suffix_host}"))
            {
                return true;
            }
        }
    }
    false
}

fn allowed_of(row: &sea_orm::QueryResult) -> Vec<String> {
    row.try_get::<Option<Vec<String>>>("", "allowed_origins")
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Loader template. Placeholders __TOKEN__ and __COLLECT_FALLBACK__ are
/// substituted at serve time (avoids format! brace-escaping on ~190 lines).
const LOADER_TEMPLATE: &str = r#"/*! analytics-loader v1.0 — token=__TOKEN__ */
(function(){
  if (window.__analyticsLoaderInstalled) return;
  window.__analyticsLoaderInstalled = true;
  var TOKEN = "__TOKEN__";
  var SCRIPT_SRC = (document.currentScript && document.currentScript.src) || "";
  var COLLECT_URL;
  try {
    var u = new URL(SCRIPT_SRC);
    var p = u.pathname;
    if (p.length > 10 && p.slice(-10) === "/script.js") {
      u.pathname = p.slice(0, -10) + "/collect";
    }
    u.search = "";
    u.hash = "";
    COLLECT_URL = u.toString();
  } catch (e) {
    COLLECT_URL = "__COLLECT_FALLBACK__";
  }
  var VISITOR_KEY = "analytics.visitorId";
  var SESSION_KEY = "analytics.sessionId";
  var ACTIVATED = false;
  function uuid(){
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    var b = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(b);
    } else {
      for (var i=0;i<16;i++) b[i] = Math.floor(Math.random()*256);
    }
    var s = "";
    for (var j=0;j<16;j++) s += (b[j]+256).toString(16).slice(1);
    return s;
  }
  function getOrCreate(key, make){
    try {
      var v = window.localStorage.getItem(key);
      if (!v) {
        v = make();
        try { window.localStorage.setItem(key, v); } catch(e) {}
      }
      return v;
    } catch(e) {
      return make();
    }
  }
  function getSessionId(){
    try {
      var v = window.sessionStorage.getItem(SESSION_KEY);
      if (!v) {
        v = uuid();
        try { window.sessionStorage.setItem(SESSION_KEY, v); } catch(e) {}
      }
      return v;
    } catch(e) { return uuid(); }
  }
  function send(type, extra){
    try {
      var payload = {
        type: type,
        path: window.location.pathname + window.location.search,
        referrer: document.referrer || null,
        screenWidth: window.screen && window.screen.width || null,
        screenHeight: window.screen && window.screen.height || null,
        locale: (navigator.language || "").slice(0, 10) || null,
        sessionId: getSessionId(),
        visitorId: getOrCreate(VISITOR_KEY, uuid),
        ts: Date.now()
      };
      if (extra && typeof extra === "object") {
        for (var k in extra) {
          if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
        }
      }
      var body = JSON.stringify(payload);
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: "application/json" });
        if (navigator.sendBeacon(COLLECT_URL, blob)) return;
      }
      if (window.fetch) {
        try { fetch(COLLECT_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=UTF-8" }, body: body, keepalive: true, credentials: "omit" }); } catch(e) {}
      }
    } catch(e) {}
  }
  function emitPageview(){
    send("pageview", { name: document.title || null });
  }
  var _origPush = history.pushState;
  var _origReplace = history.replaceState;
  function installSpaHooks(){
    history.pushState = function(){
      var rv = _origPush.apply(this, arguments);
      window.dispatchEvent(new Event("analytics:locationchange"));
      return rv;
    };
    history.replaceState = function(){
      var rv = _origReplace.apply(this, arguments);
      window.dispatchEvent(new Event("analytics:locationchange"));
      return rv;
    };
    window.addEventListener("popstate", function(){
      window.dispatchEvent(new Event("analytics:locationchange"));
    });
    window.addEventListener("analytics:locationchange", function(){
      if (!ACTIVATED) return;
      setTimeout(emitPageview, 0);
    });
  }
  function uninstallSpaHooks(){
    if (typeof _origPush === "function") history.pushState = _origPush;
    if (typeof _origReplace === "function") history.replaceState = _origReplace;
  }
  function clearStoredIds(){
    try { window.localStorage.removeItem(VISITOR_KEY); } catch(e) {}
    try { window.sessionStorage.removeItem(SESSION_KEY); } catch(e) {}
  }
  function activate(){
    if (ACTIVATED) return;
    ACTIVATED = true;
    installSpaHooks();
    if (document.readyState === "complete") {
      setTimeout(emitPageview, 0);
    } else {
      window.addEventListener("load", function once(){
        window.removeEventListener("load", once);
        emitPageview();
      });
    }
  }
  function deactivate(){
    if (!ACTIVATED) return;
    ACTIVATED = false;
    uninstallSpaHooks();
    clearStoredIds();
  }
  window.analytics = {
    activate: activate,
    deactivate: deactivate,
    event: function(name, props){
      if (!ACTIVATED) return;
      if (typeof name !== "string" || name.length === 0) return;
      var safeName = name.slice(0, 64);
      var safeProps = (props && typeof props === "object" && !Array.isArray(props)) ? props : {};
      send("event", { name: safeName, props: safeProps });
    }
  };
})();
"#;

// ---------------------------------------------------------------------------
// GET /:secret_token/script.js
// ---------------------------------------------------------------------------

async fn script_js(
    State(ctx): State<AppContext>,
    Path(secret_token): Path<String>,
) -> Response {
    if secret_token.len() != 22 {
        return script_text(StatusCode::NOT_FOUND, "// analytics: not found");
    }
    let row = ctx
        .db
        .query_one_raw(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "SELECT id, status FROM analytics_configs WHERE trim(secret_token) = $1",
            vec![secret_token.clone().into()],
        ))
        .await;
    let active = match row {
        Ok(Some(r)) => {
            let status: Option<String> = r.try_get("", "status").ok().flatten();
            status.as_deref() == Some("active")
        }
        _ => false,
    };
    if !active {
        return script_text(StatusCode::NOT_FOUND, "// analytics: not found");
    }
    // The token is 22-char base64url by construction; JSON-quote it anyway.
    let token_js = serde_json::to_string(&secret_token).unwrap_or_default();
    let token_js_inner = token_js.trim_matches('"');
    let fallback = format!("/api/public/analytics/{secret_token}/collect");
    let script = LOADER_TEMPLATE
        .replace("__TOKEN__", token_js_inner)
        .replace("__COLLECT_FALLBACK__", &fallback);
    axum::response::Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/javascript; charset=utf-8")
        .header("Cache-Control", "public, max-age=300")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(axum::body::Body::from(script))
        .unwrap()
}

fn script_text(status: StatusCode, text: &str) -> Response {
    axum::response::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(axum::body::Body::from(text.to_string()))
        .unwrap()
}

// ---------------------------------------------------------------------------
// POST /:secret_token/collect
// ---------------------------------------------------------------------------

async fn collect(
    State(ctx): State<AppContext>,
    Path(secret_token): Path<String>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if secret_token.len() != 22 {
        return err(StatusCode::BAD_REQUEST, "Invalid secret token");
    }
    let parsed: serde_json::Value = if body.trim().is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_str(&body) {
            Ok(v) => v,
            Err(_) => return err(StatusCode::BAD_REQUEST, "Invalid JSON body"),
        }
    };
    let body_obj = parsed.as_object();
    let ev_type = body_obj
        .and_then(|o| o.get("type"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !EVENT_TYPES.contains(&ev_type) {
        return err(
            StatusCode::BAD_REQUEST,
            "type must be 'pageview' or 'event'",
        );
    }
    let mut path: Option<String> = None;
    if let Some(p) = body_obj.and_then(|o| o.get("path")).and_then(|v| v.as_str()) {
        if !p.is_empty() {
            if p.len() > PATH_MAX_LEN {
                return err(
                    StatusCode::BAD_REQUEST,
                    &format!("path must be <= {PATH_MAX_LEN} chars"),
                );
            }
            let bad = p.chars().any(|c| c.is_whitespace())
                || p.starts_with("//")
                || path_has_scheme(p);
            if bad {
                return err(
                    StatusCode::BAD_REQUEST,
                    "path must be a relative URL path",
                );
            }
            path = Some(p.to_string());
        }
    }
    let mut event_name: Option<String> = None;
    let mut event_props: Option<String> = None;
    if ev_type == "event" {
        if let Some(n) = body_obj
            .and_then(|o| o.get("name"))
            .and_then(|v| v.as_str())
        {
            if !n.is_empty() {
                event_name = Some(n.chars().take(64).collect());
            }
        }
        if let Some(props) = body_obj.and_then(|o| o.get("props")) {
            if props.is_object() {
                let mut m = (0usize, 0usize);
                measure_bag(props, 1, &mut m);
                if m.1 > RAW_MAX_DEPTH {
                    return err(
                        StatusCode::BAD_REQUEST,
                        &format!("props exceeds max depth {RAW_MAX_DEPTH}"),
                    );
                }
                if m.0 > RAW_MAX_KEYS_PER_LEVEL {
                    return err(
                        StatusCode::BAD_REQUEST,
                        &format!("props exceeds max {RAW_MAX_KEYS_PER_LEVEL} keys per level"),
                    );
                }
                match serde_json::to_string(props) {
                    Ok(s) => {
                        if s.len() > RAW_MAX_BYTES {
                            return err(
                                StatusCode::BAD_REQUEST,
                                &format!("props exceeds max {RAW_MAX_BYTES} bytes"),
                            );
                        }
                        event_props = Some(s);
                    }
                    Err(_) => {
                        return err(StatusCode::BAD_REQUEST, "props is not serialisable");
                    }
                }
            }
        }
    }
    let referrer = trim_or_null(body_obj.and_then(|o| o.get("referrer")), REFERRER_MAX_LEN);
    let locale = trim_or_null(body_obj.and_then(|o| o.get("locale")), LOCALE_MAX_LEN);
    let session_id = trim_or_null(body_obj.and_then(|o| o.get("sessionId")), SESSION_ID_MAX_LEN);
    let visitor_id = trim_or_null(body_obj.and_then(|o| o.get("visitorId")), VISITOR_ID_MAX_LEN);
    let screen_width = int_or_null(body_obj.and_then(|o| o.get("screenWidth")));
    let screen_height = int_or_null(body_obj.and_then(|o| o.get("screenHeight")));

    let mut occurred_at: Option<String> = None;
    if let Some(ts) = body_obj.and_then(|o| o.get("ts")).and_then(|v| v.as_i64()) {
        let now_ms = chrono::Utc::now().timestamp_millis();
        if ts >= now_ms - 7 * 24 * 60 * 60 * 1000 && ts <= now_ms + 60 * 1000 {
            occurred_at = chrono::DateTime::from_timestamp_millis(ts)
                .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        }
    }
    let raw = {
        let obj = json!({ "name": event_name, "props": event_props
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()) });
        let s = serde_json::to_string(&obj).unwrap_or_else(|_| "{}".to_string());
        if s.len() > RAW_MAX_BYTES {
            None
        } else {
            serde_json::from_str::<serde_json::Value>(&s).ok()
        }
    };

    let res: Result<Response, sea_orm::DbErr> = (async {
        let row = ctx
            .db
            .query_one_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT id, status, allowed_origins
                 FROM analytics_configs WHERE trim(secret_token) = $1",
                vec![secret_token.into()],
            ))
            .await?;
        let Some(r) = row else {
            return Ok(err(StatusCode::NOT_FOUND, "Not found"));
        };
        let status: Option<String> = r.try_get("", "status").ok().flatten();
        if status.as_deref() != Some("active") {
            return Ok(err(StatusCode::NOT_FOUND, "Not found"));
        }
        let config_id: i64 = r.try_get("", "id")?;
        let allowed = allowed_of(&r);
        if !allowed.is_empty() {
            let origin = headers
                .get("origin")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("");
            if !is_origin_allowed(origin, &allowed) {
                return Ok(err(StatusCode::NOT_FOUND, "Not found"));
            }
        }
        let ua = headers
            .get("user-agent")
            .and_then(|h| h.to_str().ok())
            .map(|s| s.chars().take(USER_AGENT_MAX_LEN).collect::<String>());
        let ip: Option<String> = headers
            .get("x-forwarded-for")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().chars().take(45).collect::<String>())
            .filter(|s| !s.is_empty());
        ctx.db
            .execute_raw(Statement::from_sql_and_values(
                sea_orm::DatabaseBackend::Postgres,
                "INSERT INTO analytics_events
                   (config_id, event_type, occurred_at, session_id, visitor_id,
                    path, referrer, screen_width, screen_height, locale,
                    user_agent, ip_address, raw)
                 VALUES ($1, $2, COALESCE($3::timestamptz, NOW()), $4, $5,
                         $6, $7, $8, $9, $10, $11, $12::inet, $13::jsonb)",
                vec![
                    config_id.into(),
                    ev_type.to_string().into(),
                    occurred_at.into(),
                    session_id.into(),
                    visitor_id.into(),
                    path.into(),
                    referrer.into(),
                    screen_width.into(),
                    screen_height.into(),
                    locale.into(),
                    ua.into(),
                    ip.into(),
                    raw.into(),
                ],
            ))
            .await?;
        Ok(StatusCode::NO_CONTENT.into_response())
    })
    .await;
    match res {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("[analytics-embed/collect] {e:?}");
            err(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error")
        }
    }
}

/// Cheap absolute-URL guard: `scheme://` at the start.
fn path_has_scheme(p: &str) -> bool {
    if let Some(colon) = p.find("://") {
        let scheme = &p[..colon];
        !scheme.is_empty()
            && scheme.len() <= 16
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.')
    } else {
        false
    }
}

pub fn routes() -> Routes {
    Routes::new()
        .prefix("/api/public/analytics")
        .add("/{secret_token}/script.js", get(script_js))
        .add("/{secret_token}/collect", post(collect))
}
