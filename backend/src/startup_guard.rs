//! Port of old_backend/lib/startup-guard.js assertSafeStartup.
//!
//! Startup-time safety assertions. Crashes the process if the config is
//! unsafe — fail-fast by design: refusing to start beats serving requests
//! with a known-insecure configuration.
//!
//! NOTE: intentionally NOT wired into app.rs — the lead owns boot hooks and
//! wires this in. Call [`assert_safe_startup`] first thing at boot.

/// SameSite values that disable CSRF defense (mirrors WEAK_SAMESITE).
const WEAK_SAMESITE: [&str; 2] = ["none", ""];

/// Production is `LOCO_ENV == "production"` (the Rust port's env name).
/// `NODE_ENV == "production"` is honored too so a production deploy using
/// the old variable name still fails safe instead of booting insecure.
fn is_production() -> bool {
    std::env::var("LOCO_ENV").as_deref() == Ok("production")
        || std::env::var("NODE_ENV").as_deref() == Ok("production")
}

/// Assert the process config is safe to serve with, else `process::exit(1)`
/// with the same messages as the Node guard:
///
/// * SameSite must be Lax or Strict — always checked.
/// * In production: COOKIE_SECURE=true, ADMIN_PASSWORD>=16 chars,
///   JWT_SECRET>=32 chars (when set).
pub fn assert_safe_startup() {
    // SameSite must be Lax or Strict. "None" disables CSRF defense.
    let samesite = std::env::var("COOKIE_SAMESITE")
        .unwrap_or_else(|_| "Lax".to_string())
        .to_lowercase();
    if WEAK_SAMESITE.contains(&samesite.as_str()) {
        eprintln!(
            "Refusing to start: COOKIE_SAMESITE=\"{samesite}\" is unsafe (must be \"Lax\" or \"Strict\")."
        );
        std::process::exit(1);
    }

    // In production, refuse the dev defaults.
    if is_production() {
        if std::env::var("COOKIE_SECURE").as_deref() != Ok("true") {
            eprintln!(
                "Refusing to start in production with COOKIE_SECURE=\"false\". Set COOKIE_SECURE=true (requires HTTPS)."
            );
            std::process::exit(1);
        }
        let pw = std::env::var("ADMIN_PASSWORD").unwrap_or_default();
        let pw_len = pw.chars().count();
        if pw_len < 16 {
            eprintln!(
                "Refusing to start in production with ADMIN_PASSWORD shorter than 16 chars (got {pw_len})."
            );
            std::process::exit(1);
        }
        let jwt = std::env::var("JWT_SECRET").unwrap_or_default();
        if !jwt.is_empty() && jwt.chars().count() < 32 {
            eprintln!(
                "Refusing to start in production with JWT_SECRET shorter than 32 chars."
            );
            std::process::exit(1);
        }
    }
}
