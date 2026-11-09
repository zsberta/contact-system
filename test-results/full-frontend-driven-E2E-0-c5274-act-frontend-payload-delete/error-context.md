# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: full.spec.ts >> frontend-driven E2E >> 04 project create + edit (exact frontend payload) + delete
- Location: e2e/full.spec.ts:204:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 201
Received: 500
```

```
Error: E2E failures:
api-500 [helper] 500 /api/projects :: {"errorMessage":"Internal server error"}
api-500 [04 project create + edit (exact frontend payload) + delete] 500 http://localhost/api/projects :: {"errorMessage":"Internal server error"}

expect(received).toEqual(expected) // deep equality

- Expected  -  1
+ Received  + 14

- Array []
+ Array [
+   Object {
+     "detail": "{\"errorMessage\":\"Internal server error\"}",
+     "kind": "api-500 [helper]",
+     "status": 500,
+     "url": "/api/projects",
+   },
+   Object {
+     "detail": "{\"errorMessage\":\"Internal server error\"}",
+     "kind": "api-500 [04 project create + edit (exact frontend payload) + delete]",
+     "status": 500,
+     "url": "http://localhost/api/projects",
+   },
+ ]
```

# Test source

```ts
  348 |     expect(token, "booking token").toBeTruthy();
  349 |     expect(String(token).startsWith("BOOKFAIL")).toBe(false);
  350 |     created.bookings.push(token as string);
  351 |   });
  352 | 
  353 |   test("08 analytics collect + script (test path only)", async ({ }, testInfo) => {
  354 |     const page = pg(testInfo);
  355 |     const st = await api(page, "GET", "/api/analytics");
  356 |     expect(st.status).toBe(200);
  357 |     // use first config's token via snippet (read-only), collect one pageview
  358 |     const first = st.json?.content?.[0];
  359 |     if (first?.id) {
  360 |       const cfg = await api(page, "GET", `/api/analytics/${first.id}`);
  361 |       const token = cfg.json?.secretToken ?? cfg.json?.secret_token;
  362 |       if (token) {
  363 |         const res = await page.evaluate(async (t) => {
  364 |           const r = await fetch(`/api/public/analytics/${t}/collect`, {
  365 |             method: "POST",
  366 |             headers: { "Content-Type": "application/json" },
  367 |             body: JSON.stringify({ type: "pageview", path: "/e2e-test-probe" }),
  368 |           });
  369 |           return r.status;
  370 |         }, token);
  371 |         expect([200, 201, 204]).toContain(res);
  372 |       }
  373 |     }
  374 |     const script = await api(page, "GET", "/api/public/analytics/xxxxxxxxxxxxxxxxxxxxxx/script.js");
  375 |     expect([200, 404]).toContain(script.status);
  376 |   });
  377 | 
  378 |   test("09 imports dry-run (real FormData like the UI) + gateway + notifications reads", async ({ }, testInfo) => {
  379 |     const page = pg(testInfo);
  380 |     // exactly what ImportsPage sends: FormData{projectId, importType, file}
  381 |     const dryStatus = await page.evaluate(async () => {
  382 |       const fd = new FormData();
  383 |       fd.append("projectId", "1");
  384 |       fd.append("importType", "customers");
  385 |       fd.append("file", new File(["firstName,lastName,email\nE2E,Teszt,e2e@example.com\n"], "t.csv", { type: "text/csv" }));
  386 |       const r = await fetch("/api/imports/dry-run", { method: "POST", body: fd });
  387 |       return { status: r.status, body: (await r.text()).slice(0, 200) };
  388 |     });
  389 |     expect(dryStatus.status, `dry-run: ${dryStatus.body}`).toBe(200);
  390 |     let r = await api(page, "GET", "/api/gateway/projects?per_page=1");
  391 |     expect([200, 503]).toContain(r.status);
  392 |     r = await api(page, "GET", "/api/notifications");
  393 |     expect(r.status).toBe(200);
  394 |     r = await api(page, "GET", "/api/notifications/unread-count");
  395 |     expect(r.status).toBe(200);
  396 |   });
  397 | 
  398 |   test("10 teardown: cancel bookings, delete everything created", async ({ }, testInfo) => {
  399 |     const page = pg(testInfo);
  400 |     // cancel public bookings by token (same flow as the manage page)
  401 |     for (const tok of created.bookings) {
  402 |       const res = await page.evaluate(async ({ secret, tok }) => {
  403 |         const r = await fetch(`/api/public/reservations/${secret}/bookings/by-token/${tok}`, { method: "DELETE" });
  404 |         return r.status;
  405 |       }, { secret: RESERVATION_TOKEN, tok });
  406 |       expect([200, 404, 410]).toContain(res);
  407 |     }
  408 |     // delete nested entities (children before parents)
  409 |     for (const id of created.submissions) {
  410 |       await api(page, "DELETE", `/api/submissions/${id}`).catch(() => {});
  411 |     }
  412 |     for (const id of created.payments) {
  413 |       const r = await api(page, "DELETE", `/api/payments/${id}`);
  414 |       expect([200, 204, 404]).toContain(r.status);
  415 |     }
  416 |     for (const id of created.blog) {
  417 |       await api(page, "DELETE", `/api/blog/${id}`);
  418 |     }
  419 |     for (const id of created.faq) {
  420 |       await api(page, "DELETE", `/api/faq/${id}`);
  421 |     }
  422 |     for (const id of created.services) {
  423 |       await api(page, "DELETE", `/api/service/${id}`);
  424 |     }
  425 |     for (const id of created.forms) {
  426 |       await api(page, "DELETE", `/api/forms/${id}`);
  427 |     }
  428 |     for (const id of created.users) {
  429 |       await api(page, "DELETE", `/api/users/${id}`);
  430 |     }
  431 |     for (const id of created.projects) {
  432 |       const r = await api(page, "DELETE", `/api/projects/${id}`);
  433 |       expect([200, 204, 404]).toContain(r.status);
  434 |     }
  435 |     // remove e2e analytics events + customers created by the booking flow
  436 |     await page.evaluate(async () => {
  437 |       await fetch(`/api/public/analytics/xxxxxxxxxxxxxxxxxxxxxx/collect`, { method: "POST" }).catch(() => {});
  438 |     }).catch(() => {});
  439 |   });
  440 | 
  441 |   test.afterAll(async ({ browser }) => {
  442 |     const report = { failures, warnings: warnings.slice(0, 80) };
  443 |     fs.mkdirSync("e2e", { recursive: true });
  444 |     fs.writeFileSync("e2e/report.json", JSON.stringify(report, null, 2));
  445 |     expect(
  446 |       failures,
  447 |       `E2E failures:\n${failures.map((f) => `${f.kind} ${f.status} ${f.url} :: ${f.detail}`).join("\n")}`,
> 448 |     ).toEqual([]);
      |       ^ Error: E2E failures:
  449 |   });
  450 | });
  451 | 
```