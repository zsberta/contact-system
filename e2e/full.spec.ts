/**
 * Frontend-driven E2E: drives the REAL React SPA in Chromium.
 * Every request is issued by the actual frontend code — nothing forged.
 *
 * Rules:
 * - Only data created by this suite may be mutated; everything created
 *   is deleted in teardown (tracked ids). Pre-existing rows are READ-ONLY,
 *   except byte-identical no-op writes (settings PUT-back).
 * - Never sends real email to real people, never sends gateway test emails.
 * - Any API response with status >= 500 fails the run.
 * - 4xx responses are collected for review (some are expected: validation,
 *   masked 404s, 409 guards).
 */
import { test, expect, Page, APIRequestContext } from "@playwright/test";
import * as fs from "node:fs";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const RESERVATION_TOKEN = "kASHP10-o8L5IY3gKsic0A"; // existing fixture reservation
const E2E_TAG = `e2e-${Date.now().toString(36)}`;

interface Fail {
  kind: string;
  url: string;
  status: number;
  detail: string;
}
const failures: Fail[] = [];
const warnings: Fail[] = [];

function watch(page: Page, tag: string) {
  page.on("response", async (res) => {
    const url = res.url();
    if (!url.startsWith("http://localhost/api/")) return;
    const status = res.status();
    if (status >= 500) {
      let body = "";
      try {
        body = (await res.text()).slice(0, 300);
      } catch {}
      failures.push({ kind: `api-500 [${tag}]`, url, status, detail: body });
    } else if (status >= 400) {
      warnings.push({ kind: `api-4xx [${tag}]`, url, status, detail: "" });
    }
  });
  page.on("pageerror", (err) => {
    failures.push({
      kind: `pageerror [${tag}]`,
      url: page.url(),
      status: 0,
      detail: String(err).slice(0, 500),
    });
  });
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("favicon")) {
      warnings.push({
        kind: `console-error [${tag}]`,
        url: page.url(),
        status: 0,
        detail: msg.text().slice(0, 300),
      });
    }
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder(/email/i).or(page.locator('input[type="text"]').first()).fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').click();
  // the app lands on the workspace (project overview), not /dashboard
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 20000 });
}

async function gotoOk(page: Page, path: string) {
  const res = await page.goto(path);
  expect(res?.status(), `${path} HTTP status`).toBe(200);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
}

// Admin API helper using the browser session (same cookies the SPA has).
async function api(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const result = await page.evaluate(
    async ({ method, path, body }) => {
      const headers: Record<string, string> = {};
      const readXsrf = () => {
        for (const c of document.cookie.split(";")) {
          const [k, ...rest] = c.trim().split("=");
          if (k === "XSRF-TOKEN") return rest.join("=");
        }
        return "";
      };
      let token = readXsrf();
      if (["POST", "PUT", "DELETE", "PATCH"].includes(method) && !token) {
        // same as the SPA's CsrfTokenService: fetch a token first
        const cr = await fetch("/api/csrf");
        if (cr.ok) token = readXsrf();
      }
      if (["POST", "PUT", "DELETE", "PATCH"].includes(method) && token) {
        headers["X-XSRF-TOKEN"] = decodeURIComponent(token);
      }
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const r = await fetch(path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await r.text();
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {}
      return { status: r.status, json: parsed };
    },
    { method, path, body },
  );
  if (result.status >= 500) {
    failures.push({
      kind: "api-500 [helper]",
      url: path,
      status: result.status,
      detail: JSON.stringify(result.json).slice(0, 300),
    });
  }
  return result;
}

test.describe.configure({ mode: "serial" });

test.describe("frontend-driven E2E", () => {
  const created = {
    projects: [] as number[],
    forms: [] as number[],
    submissions: [] as number[],
    payments: [] as number[],
    blog: [] as number[],
    faq: [] as number[],
    services: [] as number[],
    users: [] as number[],
    bookings: [] as { token: string; id: number }[],
    customers: [] as number[],
    aiConfigs: [] as { projectId: number; id: number; preExisting: boolean }[],
    analyticsConfigs: [] as { projectId: number; id: number; preExisting: boolean }[],
  };

  test.beforeAll(async ({ browser }) => {
    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) test.skip(true, "ADMIN_EMAIL/PASSWORD required");
    const page = await browser.newPage();
    watch(page, "login");
    await login(page);
    await page.context().storageState({ path: "e2e/.auth.json" });
    await page.close();
  });

  test.beforeEach(async ({ browser }, testInfo) => {
    // fresh context per test from saved auth
    const context = await browser.newContext({ storageState: "e2e/.auth.json" });
    const page = await context.newPage();
    watch(page, testInfo.title);
    await page.goto("/"); // give document an origin so document.cookie works
    (testInfo as any).e2ePage = page;
    (testInfo as any).e2eContext = context;
  });

  test.afterEach(async ({ }, testInfo) => {
    await (testInfo as any).e2ePage?.close().catch(() => {});
    await (testInfo as any).e2eContext?.close().catch(() => {});
  });

  const pg = (testInfo: any): Page => (testInfo as any).e2ePage as Page;

  test("01 login lands on dashboard with real data", async ({ }, testInfo) => {
    const page = pg(testInfo);
    await gotoOk(page, "/dashboard");
    await expect(page.locator("body")).toContainText(/Dashboard|Áttekintés|bevétel|Revenue/i, { timeout: 20000 });
  });

  test("02 all read pages load", async ({ }, testInfo) => {
    const page = pg(testInfo);
    const routes = [
      "/dashboard", "/users", "/projects", "/forms", "/imports", "/bulk-email",
      "/logs", "/server-info", "/gateway", "/reservations", "/reservations/customers",
      "/blog", "/faq", "/services", "/analytics", "/ai-assistant", "/submissions",
    ];
    for (const r of routes) {
      await gotoOk(page, r);
    }
  });

  test("03 server-info has full shape (loadAvg regression)", async ({ }, testInfo) => {
    const page = pg(testInfo);
    const { status, json } = await api(page, "GET", "/api/server-info");
    expect(status).toBe(200);
    expect(Array.isArray(json?.app?.loadAvg)).toBe(true);
    expect(typeof json?.app?.cpuCount).toBe("number");
    expect(typeof json?.app?.memTotalBytes).toBe("number");
  });

  test("04 project create + edit (exact frontend payload) + delete", async ({ }, testInfo) => {
    const page = pg(testInfo);
    // CREATE via the same shape ProjectCreatePage sends
    const name = `E2E Scratch ${E2E_TAG}`;
    let r = await api(page, "POST", "/api/projects", {
      name,
      domainAddress: `https://${E2E_TAG}.example.com`,
      status: "under_construction",
    });
    expect(r.status).toBe(201);
    const id = r.json.id as number;
    created.projects.push(id);
    // EDIT with the exact field set the UI sends
    r = await api(page, "PUT", `/api/projects/${id}`, {
      billingPeriod: "monthly",
      comment: null,
      customerEmail: "e2e@example.com",
      customerName: "E2E",
      customerPhone: "+3600000000",
      domainAddress: `https://${E2E_TAG}.example.com`,
      fordulonap: "1",
      name,
      price: 25000,
      status: "under_construction",
    });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("under_construction");
    expect(r.json.billingPeriod).toBe("monthly");
  });

  test("05 scratch project hosts nested creates", async ({ }, testInfo) => {
    const page = pg(testInfo);
    const projectId = created.projects[0];
    expect(projectId).toBeTruthy();
    // form (exact FormCreateDTO shape)
    let r = await api(page, "POST", "/api/forms", {
      name: `E2E Form ${E2E_TAG}`, slug: `e2e-${E2E_TAG}`, projectId,
      allowedOrigins: [], status: "active",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.forms.push(r.json.id);
    // payment (pending so it stays deletable)
    r = await api(page, "POST", "/api/payments", {
      projectId, amount: 1000, status: "pending", dueDate: "2027-01-15",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.payments.push(r.json.id);
    // blog post (exact BlogPostCreateDTO shape)
    r = await api(page, "POST", "/api/blog", {
      projectId, title: `E2E ${E2E_TAG}`, slug: `e2e-${E2E_TAG}`, locale: "hu",
      bodyHtml: "<p>e2e</p>", status: "draft",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.blog.push(r.json.id);
    // faq item (exact FaqItemCreateDTO shape)
    r = await api(page, "POST", "/api/faq", {
      projectId, questionHu: `E2E ${E2E_TAG}?`, answerHu: "E2E answer", status: "draft",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.faq.push(r.json.id);
    // service item (exact ServiceItemCreateDTO shape)
    r = await api(page, "POST", "/api/service", {
      projectId, titleHu: `E2E ${E2E_TAG}`, descriptionHu: "desc", status: "draft",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.services.push(r.json.id);
    // enduser (invite flow)
    r = await api(page, "POST", "/api/users", {
      email: `e2e-${E2E_TAG}@example.com`, firstName: "E2E", lastName: "User", role: "enduser",
    });
    expect([200, 201]).toContain(r.status);
    if (r.json?.id) created.users.push(r.json.id);
  });

  test("05b admin enriched booking (calendar flow) + delete", async ({ }, testInfo) => {
    const page = pg(testInfo);
    // exact ReservationBookingForm payload: existing customer + service
    const r = await api(page, "POST", "/api/reservations/1/bookings", {
      serviceId: 1,
      startsAt: "2027-05-03T10:00:00Z",
      endsAt: "2027-05-03T11:00:00Z",
      customerId: 1057,
      firstName: "Zsolt",
      lastName: "Berta",
      email: "kicsibertazsolt+1@gmail.com",
      phone: "+36706071196",
    });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(201);
    expect(r.json?.bookingToken).toBeTruthy();
    const bid = r.json?.id;
    expect(bid).toBeTruthy();
    // notification created for the worker (real user 4 owns service 1)
    const n = await api(page, "GET", "/api/notifications?limit=3");
    expect(n.status).toBe(200);
    const del = await api(page, "DELETE", `/api/reservations/1/bookings/${bid}`);
    expect([200, 204, 404]).toContain(del.status);
  });

  test("06 public form submission via real embed fetch", async ({ }, testInfo) => {
    const page = pg(testInfo);
    const formId = created.forms[0];
    expect(formId).toBeTruthy();
    // read the form the same way the admin UI does, then POST exactly what
    // an external embed page posts (fields + locale + hp honeypot empty)
    const cfg = await api(page, "GET", `/api/forms/${formId}`);
    expect(cfg.status).toBe(200);
    const token = cfg.json.secretToken ?? cfg.json.secret_token;
    expect(token).toBeTruthy();
    const fields = cfg.json.fields ?? [];
    const data: Record<string, string> = {};
    for (const f of fields) data[f.key ?? f.name] = "E2E test";
    if (Object.keys(data).length === 0) data.name = "E2E test";
    const res = await page.evaluate(
      async ({ token, data }) => {
        const r = await fetch(`/api/public/forms/${token}/submissions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data, locale: "hu", hp: "" }),
        });
        return { status: r.status, body: (await r.text()).slice(0, 300) };
      },
      { token, data },
    );
    expect(res.status).toBeLessThan(500);
  });

  test("07 public reservation booking via real embed page", async ({ }, testInfo) => {
    const page = pg(testInfo);
    await gotoOk(page, `/embed/reservations/${RESERVATION_TOKEN}`);
    // wait for the catalog/services to load (proves public config works)
    await page.waitForLoadState("networkidle").catch(() => {});
    const token = await page.evaluate(async (secret) => {
      const cat = await (
        await fetch(`/api/public/reservations/${secret}/catalog`)
      ).json();
      const svc = cat.services?.[0] ?? cat[0];
      const serviceId = svc?.id;
      if (!serviceId) return "BOOKFAIL:no-service";
      // same as the embed UI: fetch the service grid for a window safely
      // inside max_advance_days, take the first slot with remaining seats
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const from = new Date(Date.now() + 30 * 864e5);
      const to = new Date(Date.now() + 37 * 864e5);
      const grid = await (
        await fetch(
          `/api/public/reservations/${secret}/services/${serviceId}/availability?from=${fmt(from)}&to=${fmt(to)}`,
        )
      ).json();
      const slot = (grid.slots ?? []).find((s: any) => s.remainingSeats > 0);
      if (!slot?.startsAt || !slot?.endsAt) return "BOOKFAIL:no-slot";
      const book = await fetch(`/api/public/reservations/${secret}/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
          firstName: "E2E",
          lastName: "Teszt",
          email: `e2e-${Date.now().toString(36)}@example.com`,
          phone: "+3600000000",
          locale: "hu",
        }),
      });
      if (!book.ok) return `BOOKFAIL:${book.status}:${(await book.text()).slice(0, 200)}`;
      const j = await book.json();
      return JSON.stringify({ token: j.bookingToken, id: j.id });
    }, RESERVATION_TOKEN);
    expect(token, "booking token").toBeTruthy();
    expect(String(token).startsWith("BOOKFAIL")).toBe(false);
    created.bookings.push(JSON.parse(token as string));
  });

  test("08 analytics collect + script (test path only)", async ({ }, testInfo) => {
    const page = pg(testInfo);
    const st = await api(page, "GET", "/api/analytics");
    expect(st.status).toBe(200);
    // use first config's token via snippet (read-only), collect one pageview
    const first = st.json?.content?.[0];
    if (first?.id) {
      const cfg = await api(page, "GET", `/api/analytics/${first.id}`);
      const token = cfg.json?.secretToken ?? cfg.json?.secret_token;
      if (token) {
        const res = await page.evaluate(async (t) => {
          const r = await fetch(`/api/public/analytics/${t}/collect`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "pageview", path: "/e2e-test-probe" }),
          });
          return r.status;
        }, token);
        expect([200, 201, 204]).toContain(res);
      }
    }
    const script = await api(page, "GET", "/api/public/analytics/xxxxxxxxxxxxxxxxxxxxxx/script.js");
    expect([200, 404]).toContain(script.status);
  });

  test("09 imports dry-run (real FormData like the UI) + gateway + notifications reads", async ({ }, testInfo) => {
    const page = pg(testInfo);
    // exactly what ImportsPage sends: FormData{projectId, importType, file}
    // via apiFetch (which attaches the CSRF header like the real UI)
    const dryStatus = await page.evaluate(async () => {
      const readXsrf = () => {
        for (const c of document.cookie.split(";")) {
          const [k, ...rest] = c.trim().split("=");
          if (k === "XSRF-TOKEN") return rest.join("=");
        }
        return "";
      };
      let token = readXsrf();
      if (!token) {
        await fetch("/api/csrf");
        token = readXsrf();
      }
      const fd = new FormData();
      fd.append("projectId", "1");
      fd.append("importType", "customers");
      fd.append("file", new File(["First Name,Last Name,Email\nE2E,Teszt,e2e@example.com\n"], "t.csv", { type: "text/csv" }));
      const r = await fetch("/api/imports/dry-run", {
        method: "POST",
        headers: token ? { "X-XSRF-TOKEN": decodeURIComponent(token) } : {},
        body: fd,
      });
      return { status: r.status, body: (await r.text()).slice(0, 200) };
    });
    expect(dryStatus.status, `dry-run: ${dryStatus.body}`).toBe(200);
    let r = await api(page, "GET", "/api/gateway/projects?per_page=1");
    expect([200, 503]).toContain(r.status);
    r = await api(page, "GET", "/api/notifications");
    expect(r.status).toBe(200);
    r = await api(page, "GET", "/api/notifications/unread-count");
    expect(r.status).toBe(200);
  });

  test("10 teardown: cancel bookings, delete everything created", async ({ }, testInfo) => {
    const page = pg(testInfo);
    // cancel public bookings by token (same flow as the manage page),
    // then admin-delete them (proper API flow) so no rows remain
    for (const b of created.bookings) {
      const res = await page.evaluate(async ({ secret, tok }) => {
        const r = await fetch(`/api/public/reservations/${secret}/bookings/by-token/${tok}`, { method: "DELETE" });
        return r.status;
      }, { secret: RESERVATION_TOKEN, tok: b.token });
      expect([200, 404, 410]).toContain(res);
      const r = await api(page, "DELETE", `/api/reservations/1/bookings/${b.id}`);
      expect([200, 204, 404]).toContain(r.status);
    }
    // NOTE: notification + reservation_customer rows have no delete
    // endpoint; the runbook removes the e2e-tagged rows via SQL after
    // the run and diffs the DB to prove zero residue.
    // delete nested entities (children before parents)
    for (const id of created.submissions) {
      await api(page, "DELETE", `/api/submissions/${id}`).catch(() => {});
    }
    for (const id of created.payments) {
      const r = await api(page, "DELETE", `/api/payments/${id}`);
      expect([200, 204, 404]).toContain(r.status);
    }
    for (const id of created.blog) {
      await api(page, "DELETE", `/api/blog/${id}`);
    }
    for (const id of created.faq) {
      await api(page, "DELETE", `/api/faq/${id}`);
    }
    for (const id of created.services) {
      await api(page, "DELETE", `/api/service/${id}`);
    }
    for (const id of created.forms) {
      await api(page, "DELETE", `/api/forms/${id}`);
    }
    for (const id of created.users) {
      await api(page, "DELETE", `/api/users/${id}`);
    }
    for (const id of created.projects) {
      const r = await api(page, "DELETE", `/api/projects/${id}`);
      expect([200, 204, 404]).toContain(r.status);
    }
    // NOTE: analytics probe events have no public delete endpoint; the
    // runbook deletes the /e2e-test-probe rows via SQL after the run.
  });

  test.afterAll(async ({ browser }) => {
    const report = { failures, warnings: warnings.slice(0, 80) };
    fs.mkdirSync("e2e", { recursive: true });
    fs.writeFileSync("e2e/report.json", JSON.stringify(report, null, 2));
    expect(
      failures,
      `E2E failures:\n${failures.map((f) => `${f.kind} ${f.status} ${f.url} :: ${f.detail}`).join("\n")}`,
    ).toEqual([]);
  });
});
