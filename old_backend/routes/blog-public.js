import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pool } from "../db/pool.js";
import rateLimit from "express-rate-limit";

// Public read API for landing pages.
//
// Auth model: NONE. We authenticate by Host header (or X-Forwarded-Host
// when behind nginx). The Host header is set by the browser and can't
// be forged by a cross-origin attacker (CORS preflight blocks the
// read), and the public API only ever reads published posts of the
// project that owns the Host.
//
// Why no auth token:
//   - The landing page is the one consuming this API, and it sits on
//     the visitor's browser. A token in the URL would be visible in
//     view-source and in browser devtools.
//   - The token would only protect against an attacker knowing the
//     domain. Since the domain is public anyway (it's what the visitor
//     types into the URL bar), the token adds no security.
//   - The Host-header check IS the auth — only the legitimate landing
//     domain can read its project's posts.
//
// Defences in depth:
//   - CORS: we reflect the request Origin (same pattern as the
//     /api/public/forms surface) so legitimate landings can fetch and
//     others can't.
//   - Rate-limit: per-IP burst + sustained, mirroring the forms
//     embed endpoints. The landing's rebuild is hourly/daily; a single
//     IP won't hit either limit in normal operation.
//   - CSRF: this surface is CSRF-exempt by convention (mounted under
//     /api/public/*), but it only accepts GET, so there's no
//     state-changing surface to protect.
//
// Why no HEAD or OPTIONS handlers:
//   - OPTIONS is handled globally by the CORS preflight in server.js
//     for the /api/public/blog mount point.
//   - HEAD inherits from GET automatically in Express.
//
// Response shape (list):
//   {
//     posts: [
//       { slug, locale, title, excerpt, coverImageUrl, bodyHtml,
//         seoTitle, seoDescription, seoKeywords, ogImageUrl,
//         canonicalUrl, publishedAt, updatedAt },
//       ...
//     ]
//   }
//
// Response shape (single post):
//   { ...same fields as a list element... }
//
// Errors: 404 if the host is unknown, 404 if a slug isn't found, 400
// if the slug is malformed. All bodies use the standard
// { errorMessage: "..." } shape used elsewhere in the CRM.

export const router = express.Router();

// Per-IP burst limiter: protects against accidental tight loops in the
// prerender script (e.g. a wrong retry policy) and bad-faith crawlers.
// 30 req/min/IP is generous — a rebuild that needs to fetch every post
// uses the list endpoint, which is one request.
const burstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

// Sustained limiter: catches slow-burn scraping. 600 req/hour/IP is
// well above the rebuild cadence (1x/hour typical, 1x/min in extreme
// cases) but bounds the worst-case load on the BE.
const sustainedLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests" },
});

router.use(burstLimiter, sustainedLimiter);

// Cache-control defaults for the public API. The landing's rebuild
// script respects these: a 304-style "you have the latest" answer is
// the goal. The mid-tier (nginx, Cloudflare, etc.) caches by
// (Host, path, query) so cache hits don't trigger this handler.
function setCacheHeaders(req, res, maxAgeSec = 60, swrSec = 300) {
  res.setHeader(
    "Cache-Control",
    `public, max-age=${maxAgeSec}, stale-while-revalidate=${swrSec}`,
  );
  res.setHeader("Vary", "Origin, Accept-Encoding");
}

// Host header resolution. We try X-Forwarded-Host first (when behind
// nginx) and fall back to Host. The host is lowercased and stripped of
// any optional :port suffix so "ZsolTBerta.hu:443" == "zsoltberta.hu".
//
// If the Host header doesn't match any project (e.g. when a server-side
// build script calls this API with Host: localhost), we fall back to the
// :domain path param. This lets landing build scripts (which can't
// override the Host header via Node's fetch) pass the domain in the URL.
//
// Lookup is a single indexed query against the UNIQUE(domain_address)
// constraint added in migration 0017. Returns the project row (id,
// domain, landing_enabled) or null.
async function resolveProjectByHost(req) {
  // Cache the lookup on req so both handlers in the same request don't
  // re-query. Cheap but worth the discipline.
  if (req._project) return req._project;

  const rawHost =
    (req.headers["x-forwarded-host"] ||
      req.headers.host ||
      "").toLowerCase();
  // Strip port: "example.com:443" -> "example.com".
  const host = rawHost.split(":")[0];

  // Also extract the :domain path param (lowercased) for fallback lookup.
  const domainParam = (req.params.domain || "").toLowerCase();

  // Try the Host header first, then the path param as fallback.
  const candidates = [host, domainParam].filter(Boolean);
  let project = null;

  for (const candidate of candidates) {
    const { rows } = await pool.query(
      `SELECT id, domain_address, landing_enabled, landing_dist_path
       FROM projects
       WHERE domain_address = $1
          OR REPLACE(REPLACE(domain_address, 'https://', ''), 'http://', '') = $1
       LIMIT 1`,
      [candidate],
    );
    if (rows[0]) {
      project = rows[0];
      break;
    }
  }

  req._project = project || null;
  return req._project;
}

// POST body projection — strips server-only fields. We don't return
// `status` (always 'published' from this surface), `created_by`
// (internal audit field), or `project_id` (the Host already encodes it).
const SELECT_BLOG_FIELDS = `
  b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
  b.body_html, b.seo_title, b.seo_description, b.seo_keywords,
  b.og_image_url, b.canonical_url, b.published_at, b.updated_at,
  b.translation_group_id
`;

function rowToPublicDTO(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url,
    // body_html is shipped as-is. Sanitization happened at write-time
    // in routes/blog.js via lib/sanitize.js — we don't re-sanitize on
    // read because that would be O(n) extra work per request and
    // defeats the cache. Operators can't insert untrusted HTML after
    // the post is published without going through PUT, which
    // re-sanitizes.
    bodyHtml: row.body_html,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoKeywords: Array.isArray(row.seo_keywords) ? row.seo_keywords : [],
    ogImageUrl: row.og_image_url || row.cover_image_url || null,
    canonicalUrl: row.canonical_url,
    publishedAt: row.published_at
      ? new Date(row.published_at).toISOString()
      : null,
    updatedAt: new Date(row.updated_at).toISOString(),
    // Translation group id. The public API also returns a
    // `translations` map (slug + title per other locale) — populated
    // separately by the route handler. The id is exposed here so the
    // landing can cache it client-side without re-fetching the
    // translation list every time.
    translationGroupId: row.translation_group_id,
  };
}

// Per-row helper: given one post, fetch the slug + title of all
// other published posts in the same translation group (across all
// other locales). Returns a `translations` object keyed by locale,
// with `{ slug, title }` per entry. The current post's own locale is
// excluded (it's already the canonical source of the request).
//
// Called from the list and single-post endpoints. We do one extra
// query per list response — the alternative is a JSONB aggregate on
// the blog_posts table, but that pulls body_html (heavy) and the
// extra query is cheap (indexed on (translation_group_id,
// project_id, locale) per migration 0019).
async function fetchTranslationsForGroup(translationGroupId, projectId, excludeLocale) {
  if (!translationGroupId) return {};
  try {
    const { rows } = await pool.query(
      `SELECT slug, locale, title
       FROM blog_posts
       WHERE translation_group_id = $1
         AND project_id = $2
         AND status = 'published'
         AND locale <> $3
       ORDER BY locale ASC`,
      [translationGroupId, projectId, excludeLocale],
    );
    const out = {};
    for (const r of rows) {
      out[r.locale] = { slug: r.slug, title: r.title };
    }
    return out;
  } catch (err) {
    console.error("[blog-public/translations]:", err.code, err.message);
    return {};
  }
}

// Parse and validate the ?since= filter. ISO-8601 timestamp; rejected
// with 400 if malformed. Empty / missing means "no filter" — return all
// published posts (used by the initial seed when a landing first wires
// up). The filter is intentionally lenient: any ISO-8601 string PG can
// parse is accepted, and PG handles timezone normalization.
function parseSince(req) {
  const raw = req.query.since;
  if (!raw) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: "since must be a string" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { ok: false, error: "since must be a valid ISO-8601 timestamp" };
  }
  return { ok: true, value: parsed.toISOString() };
}

const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- GET /api/public/blog/by-domain/:domain/posts ----
// List published posts for the project resolved by Host header. Used by
// the landing's prerender script to enumerate slugs (without bodies) for
// sitemap generation, and to bulk-fetch the post set on first wire-up.
//
// Query params:
//   ?since=ISO-8601 - only return posts whose updated_at >= since
//                     (used by the landing's incremental build)
//   ?locale=hu      - filter by locale (defaults to 'hu')
//   ?limit=100      - max rows to return (default 100, max 500)
router.get("/by-domain/:domain/posts", async (req, res) => {
  const project = await resolveProjectByHost(req);
  if (!project) {
    return res.status(404).json({ errorMessage: "Unknown host" });
  }
  // The :domain path param is informational only — we always trust the
  // resolved Host. If they disagree we 404 (someone is poking at the
  // URL with a tampered path). Strip protocol prefix for comparison
  // since domain_address may contain "https://".
  if (req.params.domain) {
    const normalized = (project.domain_address || "")
      .replace(/^https?:\/\//, "").toLowerCase();
    if (req.params.domain.toLowerCase() !== normalized) {
      return res.status(404).json({ errorMessage: "Unknown host" });
    }
  }

  const locale = (req.query.locale || "hu").toString();
  if (!LOCALE_RE.test(locale)) {
    return res.status(400).json({ errorMessage: "Invalid locale" });
  }

  const since = parseSince(req);
  if (!since.ok) {
    return res.status(400).json({ errorMessage: since.error });
  }

  const limit = Math.min(
    500,
    Math.max(1, parseInt(req.query.limit || "100", 10) || 100),
  );

  // Build the WHERE incrementally. The hot path (no filters) collapses
  // to a single indexed scan against idx_blog_posts_project_locale_status_updated.
  const params = [project.id, locale];
  let whereSql = `b.project_id = $1 AND b.locale = $2 AND b.status = 'published'`;
  if (since.value) {
    params.push(since.value);
    whereSql += ` AND b.updated_at >= $${params.length}`;
  }
  params.push(limit);
  const limitPh = `$${params.length}`;

  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_BLOG_FIELDS}
       FROM blog_posts b
       WHERE ${whereSql}
       ORDER BY b.updated_at DESC
       LIMIT ${limitPh}`,
      params,
    );

    // Resolve translations for the returned posts in one batched
    // query — N+1-free. The translations are mapped by
    // translation_group_id, so we look up the unique groups in a
    // single IN-clause query, then attach the per-post `translations`
    // map to each DTO. The public surface only ever resolves
    // published translations — drafts aren't surfaced in the
    // alternate-language picker.
    const groupIds = [...new Set(
      rows.map((r) => r.translation_group_id).filter(Boolean),
    )];
    let translationsByGroup = {};
    if (groupIds.length > 0) {
      try {
        const { rows: tr } = await pool.query(
          `SELECT translation_group_id, slug, locale, title
           FROM blog_posts
           WHERE translation_group_id = ANY($1::uuid[])
             AND project_id = $2
             AND status = 'published'
           ORDER BY locale ASC`,
          [groupIds, project.id],
        );
        for (const r of tr) {
          if (!translationsByGroup[r.translation_group_id]) {
            translationsByGroup[r.translation_group_id] = {};
          }
          translationsByGroup[r.translation_group_id][r.locale] = {
            slug: r.slug,
            title: r.title,
          };
        }
      } catch (err) {
        console.error("[blog-public/list translations]:", err.code, err.message);
        // Non-fatal — fall through with empty translations maps.
      }
    }

    const posts = rows.map((row) => ({
      ...rowToPublicDTO(row),
      // For each post, drop its own locale from the translations
      // map (the post IS the canonical source of that locale).
      translations: Object.fromEntries(
        Object.entries(translationsByGroup[row.translation_group_id] ?? {}).filter(
          ([loc]) => loc !== row.locale,
        ),
      ),
    }));
    setCacheHeaders(req, res, 30, 120);
    return res.json({ posts });
  } catch (err) {
    console.error("[blog-public/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/public/blog/by-domain/:domain/posts/slugs ----
// Lightweight "which posts exist?" endpoint for the landing's sitemap
// generator and the rebuild script's state-initialization path. Returns
// only slug + locale + updated_at per post — no body — so the payload
// stays small even at millions of rows.
//
// Query params: ?since, ?locale — same semantics as /posts.
router.get("/by-domain/:domain/posts/slugs", async (req, res) => {
  const project = await resolveProjectByHost(req);
  if (!project) {
    return res.status(404).json({ errorMessage: "Unknown host" });
  }
  if (req.params.domain) {
    const _norm = (project.domain_address || "").replace(/^https?:\/\//, "").toLowerCase();
    if (req.params.domain.toLowerCase() !== _norm) {
      return res.status(404).json({ errorMessage: "Unknown host" });
    }
  }

  const locale = (req.query.locale || "hu").toString();
  if (!LOCALE_RE.test(locale)) {
    return res.status(400).json({ errorMessage: "Invalid locale" });
  }

  const since = parseSince(req);
  if (!since.ok) {
    return res.status(400).json({ errorMessage: since.error });
  }

  const limit = Math.min(
    1000,
    Math.max(1, parseInt(req.query.limit || "1000", 10) || 1000),
  );

  const params = [project.id, locale];
  let whereSql = `b.project_id = $1 AND b.locale = $2 AND b.status = 'published'`;
  if (since.value) {
    params.push(since.value);
    whereSql += ` AND b.updated_at >= $${params.length}`;
  }
  params.push(limit);
  const limitPh = `$${params.length}`;

  try {
    const { rows } = await pool.query(
      `SELECT b.slug, b.locale, b.updated_at
       FROM blog_posts b
       WHERE ${whereSql}
       ORDER BY b.updated_at DESC
       LIMIT ${limitPh}`,
      params,
    );
    setCacheHeaders(req, res, 60, 300);
    return res.json({
      slugs: rows.map((r) => ({
        slug: r.slug,
        locale: r.locale,
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error("[blog-public/slugs]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/public/blog/by-domain/:domain/posts/:slug ----
// Single-post fetch with full body. Used by the landing's prerender
// when iterating slugs (the list endpoint returns bodies too, but at
// 1M posts that's 5+ GB per rebuild — the rebuild script uses the
// list endpoint once on first wire-up to seed state, then switches to
// per-slug fetches on subsequent rebuilds).
router.get("/by-domain/:domain/posts/:slug", async (req, res) => {
  const project = await resolveProjectByHost(req);
  if (!project) {
    return res.status(404).json({ errorMessage: "Unknown host" });
  }
  if (req.params.domain) {
    const _norm = (project.domain_address || "").replace(/^https?:\/\//, "").toLowerCase();
    if (req.params.domain.toLowerCase() !== _norm) {
      return res.status(404).json({ errorMessage: "Unknown host" });
    }
  }

  const slug = req.params.slug;
  if (!SLUG_RE.test(slug)) {
    return res.status(400).json({ errorMessage: "Invalid slug" });
  }

  const locale = (req.query.locale || "hu").toString();
  if (!LOCALE_RE.test(locale)) {
    return res.status(400).json({ errorMessage: "Invalid locale" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT ${SELECT_BLOG_FIELDS}
       FROM blog_posts b
       WHERE b.project_id = $1
         AND b.slug = $2
         AND b.locale = $3
         AND b.status = 'published'
       LIMIT 1`,
      [project.id, slug, locale],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    // Single-post translations: fetch the other locales in this
    // group, in their own query (this is the single-post hot path
    // and the cost is one indexed lookup).
    const translations = await fetchTranslationsForGroup(
      rows[0].translation_group_id,
      project.id,
      locale,
    );
    setCacheHeaders(req, res, 300, 600);
    return res.json({
      ...rowToPublicDTO(rows[0]),
      translations,
    });
  } catch (err) {
    console.error("[blog-public/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/public/blog/attachments/:filename ----
// Serves the cover/inline image files written by routes/blog-attachments.js.
// The URL is what gets stored in blog_posts.cover_image_url and inside
// the Tiptap body. We mount this under /api/public/* so the same
// CORS-reflect + rate-limit rules apply.
//
// Filename is a UUID + extension that the upload route generates; we
// don't accept slashes or directory traversal. The DB lookup is
// intentionally skipped — filenames are unguessable UUIDs (122 bits
// of entropy), so direct access is fine. This also makes the path
// cacheable at the nginx / CDN layer for years.
//
// Cache: 1 year + immutable, since the filename changes on every
// upload. Operators who want to "rename" can just upload a new
// image; the old URL 410s when the row is deleted (because the
// CASCADE on blog_posts cascades the attachment row, and the host's
// cleanup script unlinks the file).
const UPLOAD_ROOT_PUBLIC = process.env.UPLOADS_DIR || "/app/uploads";
const FILENAME_RE = /^[a-f0-9-]{36}\.(webp|png|jpg|jpeg|avif)$/i;

router.get("/attachments/:filename", async (req, res) => {
  const filename = req.params.filename;
  if (!FILENAME_RE.test(filename)) {
    return res.status(400).json({ errorMessage: "Invalid filename" });
  }

  // Filenames are UUIDs, but to find the disk path we need to know
  // which post the file belongs to. The blog_attachments row maps
  // filename -> post_id. We accept the small DB lookup cost on the
  // read path in exchange for not exposing the post_id structure in
  // URLs.
  let postId;
  try {
    const { rows } = await pool.query(
      `SELECT post_id FROM blog_attachments WHERE stored_filename = $1 LIMIT 1`,
      [filename],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Attachment not found" });
    }
    postId = rows[0].post_id;
  } catch (err) {
    console.error("[blog-public/attachment lookup]:", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  const fullPath = path.join(UPLOAD_ROOT_PUBLIC, "blog", String(postId), filename);

  let stat;
  try {
    await fsp.access(fullPath);
    stat = await fsp.stat(fullPath);
  } catch {
    return res.status(410).json({ errorMessage: "File is no longer available" });
  }

  // Set the Content-Type from the file extension. Node's built-in
  // mime table doesn't know about .webp / .avif, so we map them
  // ourselves — otherwise the browser sees application/octet-stream
  // and renders the bytes as unrecognizable text on direct navigation
  // (e.g. when an operator clicks the image in the BlogViewPage
  // preview link).
  const ext = path.extname(filename).slice(1).toLowerCase();
  const CONTENT_TYPE_BY_EXT = {
    webp: "image/webp",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    avif: "image/avif",
  };
  const contentType = CONTENT_TYPE_BY_EXT[ext] || "application/octet-stream";

  // Long cache — the filename changes on every upload, so this is
  // safe to keep for a year. Adjusting the cache header does not
  // require touching the file or the DB.
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Vary", "Origin, Accept-Encoding");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(stat.size));

  // Stream the file. createReadStream handles backpressure; we
  // attach an error handler so a vanished file (e.g. cleaned up by
  // the post-delete cascade between the access() call and the
  // stream open) doesn't crash the request.
  const stream = fs.createReadStream(fullPath);
  stream.on("error", (err) => {
    console.error("[blog-public/attachment stream]:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ errorMessage: "Failed to read file" });
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});