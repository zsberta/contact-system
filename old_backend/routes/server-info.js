// routes/server-info.js
//
// Admin-only server monitoring API. Read-only; snapshots are collected by
// lib/server-info.js (in-process poll started from server.js).
//
// Endpoints:
//   GET /api/server-info — full snapshot (self + email + tables + docker)
//   GET /api/server-info/containers/:id — full inspect of one container

import express from "express";
import { requireAuth, requireAdmin } from "../middleware/jwtAuth.js";
import { collectServerInfo, inspectContainer, refreshDockerSnapshot } from "../lib/server-info.js";

export const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/server-info — full monitoring snapshot.
// ?refresh=1 forces a docker re-poll (subject to a 10s min interval in
// lib/server-info.js so the Refresh button can't hammer the daemon).
router.get("/", async (req, res) => {
  try {
    if (req.query.refresh === "1") {
      await refreshDockerSnapshot();
    }
    const snapshot = await collectServerInfo();
    return res.json(snapshot);
  } catch (err) {
    console.error("[server-info]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Failed to collect server info" });
  }
});

// GET /api/server-info/containers/:id — full inspect payload for one
// container (on-demand, never cached). Env values with secret-bearing
// keys are redacted by lib/server-info.js; the frontend renders the
// rest in full.
router.get("/containers/:id", async (req, res) => {
  try {
    const detail = await inspectContainer(req.params.id);
    return res.json(detail);
  } catch (err) {
    const status = Number.isInteger(err?.status) ? err.status : 500;
    if (status >= 500) console.error("[server-info/inspect]", err.code, err.message);
    const message =
      status === 400 ? "Invalid container id"
      : status === 404 ? "Container not found"
      : status === 503 ? "Docker host monitoring is not configured"
      : "Failed to inspect container";
    return res.status(status).json({ errorMessage: message });
  }
});
