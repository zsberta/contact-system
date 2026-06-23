// Startup-time safety assertions. Crashes the process if the config is unsafe.
// This is intentionally fail-fast: it's better to refuse to start than to serve
// requests with a known-insecure configuration.

import process from "node:process";

const WEAK_SAMESITE = new Set(["none", ""]);

export function assertSafeStartup() {
  const isProd = process.env.NODE_ENV === "production";

  // SameSite must be Lax or Strict. "None" disables CSRF defense (needs Secure + HTTPS).
  const samesite = (process.env.COOKIE_SAMESITE || "Lax").toLowerCase();
  if (WEAK_SAMESITE.has(samesite)) {
    console.error(
      `Refusing to start: COOKIE_SAMESITE="${samesite}" is unsafe (must be "Lax" or "Strict").`,
    );
    process.exit(1);
  }

  // In production, refuse the dev defaults.
  if (isProd) {
    if (process.env.COOKIE_SECURE !== "true") {
      console.error(
        'Refusing to start in production with COOKIE_SECURE="false". Set COOKIE_SECURE=true (requires HTTPS).',
      );
      process.exit(1);
    }
    const pw = process.env.ADMIN_PASSWORD || "";
    if (pw.length < 16) {
      console.error(
        `Refusing to start in production with ADMIN_PASSWORD shorter than 16 chars (got ${pw.length}).`,
      );
      process.exit(1);
    }
    if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
      console.error(
        "Refusing to start in production with JWT_SECRET shorter than 32 chars.",
      );
      process.exit(1);
    }
  }
}