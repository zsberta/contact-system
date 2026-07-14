#!/usr/bin/env node
/**
 * analytics-smoke.mjs
 *
 * End-to-end smoke test for the analytics module. Hits the running
 * server on http://localhost (the docker compose stack) and exercises:
 *   1. signin
 *   2. list projects
 *   3. lazy-create the analytics config for a project (GET by-project)
 *   4. fetch the snippet
 *   5. fetch the JS loader
 *   6. POST a synthetic pageview to /api/public/analytics/.../collect
 *   7. POST a synthetic custom event
 *   8. fetch stats
 *   9. PUT the config (toggle status)
 *  10. delete the config
 *
 * Run: node scripts/analytics-smoke.mjs
 */
import { setTimeout as sleep } from "node:timers/promises";

const BASE = process.env.SMOKE_BASE || "http://localhost";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

let cookieJar = "";

function captureCookies(res) {
  const setCookie = res.headers.getSetCookie?.() || res.headers.raw?.()["set-cookie"] || [];
  for (const c of setCookie) {
    const pair = c.split(";")[0];
    const name = pair.split("=")[0];
    cookieJar = cookieJar
      .split("; ")
      .filter((p) => p && !p.startsWith(name + "="))
      .concat(pair)
      .filter(Boolean)
      .join("; ");
  }
}

async function api(path, opts = {}) {
  const url = `${BASE}${path}`;
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (cookieJar) headers["Cookie"] = cookieJar;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    redirect: "manual",
  });
  captureCookies(res);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

let passed = 0;
let failed = 0;
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
    failed++;
  }
}

async function main() {
  if (!ADMIN_PASSWORD) {
    console.error("Set ADMIN_PASSWORD in .env (or pass it as an env var).");
    process.exit(2);
  }

  console.log("1. signin");
  const signin = await api("/api/auth/signin", {
    method: "POST",
    body: { identifier: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  check("signin returns 200", signin.status === 200, JSON.stringify(signin.body).slice(0, 200));
  if (signin.status !== 200) {
    process.exit(1);
  }

  // Issue a CSRF token. signin doesn't set one; mutations need it.
  const csrf = await api("/api/csrf");
  check("csrf returns 200", csrf.status === 200);
  const csrfToken = csrf.body?.token;
  // Build a request helper that injects the CSRF header.
  const apiAuthed = (path, opts = {}) =>
    api(path, { ...opts, headers: { "X-XSRF-TOKEN": csrfToken, ...(opts.headers || {}) } });

  console.log("2. list projects");
  const projects = await api("/api/projects?size=1");
  check("projects returns 200", projects.status === 200);
  const firstProject = projects.body?.content?.[0];
  check("at least one project exists", !!firstProject);
  if (!firstProject) {
    console.error("No project in the DB — seed first.");
    process.exit(1);
  }
  const projectId = firstProject.id;
  console.log(`  using project #${projectId} (${firstProject.name})`);

  console.log("3. lazy-create analytics config via GET /by-project/:id");
  const cfg = await api(`/api/analytics/by-project/${projectId}`);
  check("config returns 200", cfg.status === 200, JSON.stringify(cfg.body).slice(0, 200));
  check("config has 22-char secret_token",
    typeof cfg.body?.secretToken === "string" && cfg.body.secretToken.length === 22,
    `token=${cfg.body?.secretToken}`);
  check("config status is active", cfg.body?.status === "active");
  const configId = cfg.body?.id;
  const secretToken = cfg.body?.secretToken;

  console.log("4. fetch snippet");
  const snippet = await api(`/api/analytics/${configId}/snippet`);
  check("snippet returns 200", snippet.status === 200);
  check("snippet html is a <script> tag",
    typeof snippet.body?.html === "string" && snippet.body.html.includes("<script async src=") && snippet.body.html.includes(secretToken),
    snippet.body?.html?.slice(0, 120));
  check("snippet origin is the public URL",
    snippet.body?.origin === (process.env.APP_PUBLIC_URL || "http://localhost"));

  console.log("5. fetch the JS loader");
  const loader = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/script.js`,
    { headers: { Origin: "http://localhost" } },
  );
  const loaderBody = await loader.text();
  check("loader returns 200", loader.status === 200);
  check("loader has correct Content-Type",
    (loader.headers.get("content-type") || "").includes("application/javascript"));
  check("loader contains the secret_token", loaderBody.includes(secretToken));
  check("loader contains the collect URL",
    loaderBody.includes(`/api/public/analytics/${secretToken}/collect`));
  check("loader is a self-contained IIFE",
    loaderBody.includes("(function()") && loaderBody.includes("navigator.sendBeacon"));

  console.log("6. POST a synthetic pageview");
  const pageview = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "User-Agent": "smoke-test/1.0",
      },
      body: JSON.stringify({
        type: "pageview",
        path: "/",
        referrer: "https://google.com",
        screenWidth: 1920,
        screenHeight: 1080,
        locale: "hu",
        sessionId: "smoke-session-1",
        visitorId: "smoke-visitor-1",
        ts: Date.now(),
      }),
    },
  );
  check("pageview returns 204", pageview.status === 204, `body=${await pageview.text()}`);

  console.log("7. POST a synthetic custom event");
  const event = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://localhost",
        "User-Agent": "smoke-test/1.0",
      },
      body: JSON.stringify({
        type: "event",
        path: "/pricing",
        name: "cta_click",
        props: { plan: "pro", value: 99 },
        sessionId: "smoke-session-1",
        visitorId: "smoke-visitor-1",
        ts: Date.now(),
      }),
    },
  );
  check("event returns 204", event.status === 204, `body=${await event.text()}`);

  console.log("8. fetch stats");
  await sleep(200);
  const stats = await api(`/api/analytics/${configId}/stats?days=30`);
  check("stats returns 200", stats.status === 200);
  check("stats totals include our pageview",
    stats.body?.totals?.pageviews >= 1, JSON.stringify(stats.body?.totals));
  check("stats totals include our event",
    stats.body?.totals?.events >= 1, JSON.stringify(stats.body?.totals));
  check("stats topPaths includes /",
    Array.isArray(stats.body?.topPaths) && stats.body.topPaths.some((p) => p.path === "/"),
    JSON.stringify(stats.body?.topPaths));
  check("stats recent includes our pageview",
    Array.isArray(stats.body?.recent) && stats.body.recent.some((e) => e.eventType === "pageview"));

  console.log("9. PUT config to disable");
  const disabled = await apiAuthed(`/api/analytics/${configId}`, {
    method: "PUT",
    body: { status: "disabled", allowedOrigins: ["http://localhost"] },
  });
  check("PUT returns 200", disabled.status === 200, JSON.stringify(disabled.body).slice(0, 200));
  check("PUT status is now disabled", disabled.body?.status === "disabled");
  check("PUT allowedOrigins has 1 entry",
    Array.isArray(disabled.body?.allowedOrigins) && disabled.body.allowedOrigins.length === 1);

  console.log("   verify origin allowlist rejects POSTs from forbidden origins");
  // Set a restrictive allowlist of [http://localhost] AND keep the config
  // active so the only thing that can reject is the origin mismatch.
  const reenabled = await apiAuthed(`/api/analytics/${configId}`, {
    method: "PUT",
    body: { status: "active", allowedOrigins: ["http://localhost"] },
  });
  check("re-enable returns 200", reenabled.status === 200, JSON.stringify(reenabled.body).slice(0, 200));

  const badOrigin = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ type: "pageview", path: "/" }),
    },
  );
  check("bad origin returns 404", badOrigin.status === 404, `status=${badOrigin.status}`);

  const goodOrigin = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ type: "pageview", path: "/" }),
    },
  );
  check("allowed origin returns 204 (or 429 if rate-limited)", goodOrigin.status === 204 || goodOrigin.status === 429, `status=${goodOrigin.status}`);

  console.log("   verify 404 for unknown token");
  const bad = await fetch(
    `${BASE}/api/public/analytics/AAAAAAAAAAAAAAAAAAAAAA/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "pageview", path: "/" }),
    },
  );
  check("unknown token returns 404", bad.status === 404, `status=${bad.status}`);

  console.log("   verify 400 for bad payload");
  const bad2 = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "made-up-type", path: "/" }),
    },
  );
  check("bad type returns 400", bad2.status === 400, `status=${bad2.status}`);
  const bad3 = await fetch(
    `${BASE}/api/public/analytics/${secretToken}/collect`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "pageview", path: "https://evil.com/x" }),
    },
  );
  check("absolute-url path returns 400", bad3.status === 400, `status=${bad3.status}`);

  console.log("10. delete config");
  const del = await apiAuthed(`/api/analytics/${configId}`, { method: "DELETE" });
  check("DELETE returns 204", del.status === 204, JSON.stringify(del.body).slice(0, 200));
  const verify = await api(`/api/analytics/${configId}`);
  check("GET after DELETE returns 404", verify.status === 404);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});
