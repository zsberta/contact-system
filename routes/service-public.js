import express from "express";
import { pool } from "../db/pool.js";
import rateLimit from "express-rate-limit";

// Public read API for the Service module.
// Same auth model as faq-public.js: Host-header resolution, no tokens.
// Returns all published service items for a project in one call, sorted by
// sort_order. Service is low-volume (<50 items), so no pagination needed.
//
// Caching: in-memory cache keyed by project_id. The data changes rarely
// (operator edits a service item in the CRM), so we cache aggressively.
// Cache is invalidated on any write to the CRM's admin CRUD endpoints.
// The landing page also sets Cache-Control headers so nginx/CDN caches
// the response for 5 minutes with stale-while-revalidate.

export const router = express.Router();

const burstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

const sustainedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

router.use(burstLimiter, sustainedLimiter);

// ---------------------------------------------------------------------------
// In-memory cache
// ---------------------------------------------------------------------------
const SERVICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const serviceCache = new Map();

function getCachedService(projectId) {
  const entry = serviceCache.get(projectId);
  if (entry && Date.now() < entry.expiresAt) {
    return entry.items;
  }
  serviceCache.delete(projectId);
  return null;
}

function setCachedService(projectId, items) {
  serviceCache.set(projectId, {
    items,
    expiresAt: Date.now() + SERVICE_CACHE_TTL_MS,
  });
}

/** Invalidate cache for a project. */
export function invalidateServiceCache(projectId) {
  if (projectId) {
    serviceCache.delete(projectId);
  } else {
    serviceCache.clear();
  }
}

// ---------------------------------------------------------------------------
// Host -> project resolution (same pattern as faq-public.js)
// ---------------------------------------------------------------------------
async function resolveProjectByHost(req) {
  if (req._project) return req._project;
  const rawHost = (req.headers["x-forwarded-host"] || req.headers.host || "").toLowerCase();
  const host = rawHost.split(":")[0];
  const domainParam = (req.params.domain || "").toLowerCase();
  const candidates = [host, domainParam].filter(Boolean);
  let project = null;
  for (const candidate of candidates) {
    const { rows } = await pool.query(
      `SELECT id, domain_address, landing_enabled
       FROM projects
       WHERE domain_address = $1
          OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $1
       LIMIT 1`,
      [candidate],
    );
    if (rows[0]) { project = rows[0]; break; }
  }
  req._project = project || null;
  return req._project;
}

// ---------------------------------------------------------------------------
// GET /api/public/service/by-domain/:domain/items
// ---------------------------------------------------------------------------
// Returns all published service items for the project resolved by Host header.
// Each item includes both HU and EN translations so the frontend can pick
// the right one client-side based on the active language.
// Response: { items: [{ title, description, price, sortOrder }, ...] }
router.get("/by-domain/:domain/items", async (req, res) => {
  const project = await resolveProjectByHost(req);
  if (!project) {
    return res.status(404).json({ errorMessage: "Unknown host" });
  }
  if (req.params.domain) {
    const normalized = (project.domain_address || "")
      .replace(/^https?:\/\//, "").toLowerCase();
    if (req.params.domain.toLowerCase() !== normalized) {
      return res.status(404).json({ errorMessage: "Unknown host" });
    }
  }

  // Try cache first
  const cached = getCachedService(project.id);
  if (cached) {
    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    res.setHeader("Vary", "Origin, Accept-Encoding");
    return res.json({ items: cached });
  }

  try {
    const { rows } = await pool.query(
      `SELECT title_hu, title_en, description_hu, description_en, price_hu, price_en, sort_order
       FROM service_items
       WHERE project_id = $1 AND status = 'published'
       ORDER BY sort_order ASC, id ASC`,
      [project.id],
    );

    const items = rows.map((r) => ({
      titleHu: r.title_hu,
      titleEn: r.title_en,
      descriptionHu: r.description_hu,
      descriptionEn: r.description_en,
      priceHu: r.price_hu,
      priceEn: r.price_en,
      sortOrder: Number(r.sort_order),
    }));

    setCachedService(project.id, items);

    res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    res.setHeader("Vary", "Origin, Accept-Encoding");
    return res.json({ items });
  } catch (err) {
    console.error("[service-public/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
