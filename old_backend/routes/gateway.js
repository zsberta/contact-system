// routes/gateway.js
//
// Admin-only proxy to the nexus-gateway billing API (SaaS project
// management). The operator token never leaves the server: the browser
// talks to /api/gateway/* with its cookie session, this router forwards
// to the gateway with the server-side GATEWAY_API_TOKEN.
//
// Endpoints (mirrors the gateway project API 1:1):
//   GET    /api/gateway/projects
//   POST   /api/gateway/projects
//   GET    /api/gateway/projects/:id
//   PUT    /api/gateway/projects/:id
//   DELETE /api/gateway/projects/:id
//   POST   /api/gateway/projects/:id/tokens
//
// Env:
//   GATEWAY_API_URL   — e.g. http://host.docker.internal:9006/api/v1
//   GATEWAY_API_TOKEN — operator token from `gateway:client-create`

import express from "express";
import { requireAuth, requireAdmin } from "../middleware/jwtAuth.js";

export const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

const BASE_URL = (process.env.GATEWAY_API_URL || "http://host.docker.internal:9006/api/v1").replace(/\/+$/, "");
const FETCH_TIMEOUT_MS = 15000;

function gatewayToken() {
  return process.env.GATEWAY_API_TOKEN || "";
}

async function forward(req, res, gatewayPath) {
  const token = gatewayToken();
  if (!token) {
    return res.status(503).json({
      errorMessage: "Billing gateway is not configured (GATEWAY_API_TOKEN missing)",
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const upstream = await fetch(`${BASE_URL}${gatewayPath}`, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: ["GET", "HEAD", "DELETE"].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
      signal: controller.signal,
    });

    const text = await upstream.text();
    res.status(upstream.status);
    try {
      return res.json(JSON.parse(text));
    } catch {
      return res.send(text);
    }
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timed out" : "unreachable";
    console.error(`[gateway] ${req.method} ${gatewayPath} ${reason}`);
    return res.status(502).json({ errorMessage: `Billing gateway ${reason}` });
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/gateway/projects — paginated SaaS portfolio list.
router.get("/projects", (req, res) => {
  const params = new URLSearchParams();
  if (req.query.page !== undefined) params.set("page", String(req.query.page));
  if (req.query.per_page !== undefined) params.set("per_page", String(req.query.per_page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return forward(req, res, `/projects${suffix}`);
});

// POST /api/gateway/projects — { name, is_active?, expires_in_days? }.
router.post("/projects", (req, res) => forward(req, res, "/projects"));

// GET /api/gateway/projects/:id
router.get("/projects/:id", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}`),
);

// PUT /api/gateway/projects/:id
router.put("/projects/:id", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}`),
);

// DELETE /api/gateway/projects/:id
router.delete("/projects/:id", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}`),
);

// POST /api/gateway/projects/:id/tokens — { expires_in_days? }.
router.post("/projects/:id/tokens", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}/tokens`),
);

// POST /api/gateway/projects/:id/test-email — { to_email }.
router.post("/projects/:id/test-email", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}/test-email`),
);

// --- Merchants (invoicing identities; secrets stay in the gateway) ---

// GET /api/gateway/merchants — paginated merchant list.
router.get("/merchants", (req, res) => {
  const params = new URLSearchParams();
  if (req.query.page !== undefined) params.set("page", String(req.query.page));
  if (req.query.per_page !== undefined) params.set("per_page", String(req.query.per_page));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return forward(req, res, `/merchants${suffix}`);
});

// PUT /api/gateway/merchants/:id — { name?, email?, billingo_block_id? }.
// Secrets are rotated via POST /api/gateway/merchants/credentials instead.
router.put("/merchants/:id", (req, res) =>
  forward(req, res, `/merchants/${encodeURIComponent(req.params.id)}`),
);

// DELETE /api/gateway/merchants/:id — past transactions keep their audit rows.
router.delete("/merchants/:id", (req, res) =>
  forward(req, res, `/merchants/${encodeURIComponent(req.params.id)}`),
);

// POST /api/gateway/merchants/credentials — create/update merchant credentials.
router.post("/merchants/credentials", (req, res) => forward(req, res, "/merchants/credentials"));

// POST /api/gateway/merchants/blocks-preview — live invoice blocks for a
// raw (not yet stored) Billingo key, used by the onboarding dialog.
router.post("/merchants/blocks-preview", (req, res) => forward(req, res, "/merchants/blocks-preview"));

// GET /api/gateway/merchants/:id/billingo-blocks — live invoice blocks
// from the merchant's own Billingo account (their decrypted key).
router.get("/merchants/:id/billingo-blocks", (req, res) =>
  forward(req, res, `/merchants/${encodeURIComponent(req.params.id)}/billingo-blocks`),
);

// GET /api/gateway/projects/:id/billingo-blocks — live invoice blocks
// from the master Billingo account.
router.get("/projects/:id/billingo-blocks", (req, res) =>
  forward(req, res, `/projects/${encodeURIComponent(req.params.id)}/billingo-blocks`),
);

// POST /api/gateway/merchants/:id/test-email — { to_email }.
router.post("/merchants/:id/test-email", (req, res) =>
  forward(req, res, `/merchants/${encodeURIComponent(req.params.id)}/test-email`),
);

// --- Transactions (payment ledger; resend is operator-only) ---

// GET /api/gateway/transactions — paginated ledger. Optional filters:
// status (pending|paid|failed|refunded), owner_type, page, per_page.
router.get("/transactions", (req, res) => {
  const params = new URLSearchParams();
  for (const key of ["page", "per_page", "status", "owner_type"]) {
    if (req.query[key] !== undefined) params.set(key, String(req.query[key]));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return forward(req, res, `/transactions${suffix}`);
});

// GET /api/gateway/transactions/:id — one ledger row with owner.
router.get("/transactions/:id", (req, res) =>
  forward(req, res, `/transactions/${encodeURIComponent(req.params.id)}`),
);

// POST /api/gateway/transactions/:id/resend — re-send the branded invoice
// email with PDF for a paid transaction.
router.post("/transactions/:id/resend", (req, res) =>
  forward(req, res, `/transactions/${encodeURIComponent(req.params.id)}/resend`),
);
