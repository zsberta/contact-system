import express from "express";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";
import { sanitizeBlogBody } from "../lib/sanitize.js";
import { writeLandingRebuildFlag } from "../lib/landing-rebuild.js";

// CRUD for the Blog module. Authoritative source for the schema
// per the migration 0017 (Blog module — headless CMS surface for landing
// pages).
//
// Pattern mirrors routes/forms.js (the sibling public-API surface is in
// routes/blog-public.js). Differences vs forms:
//   - status is draft | published | archived (forms: active | disabled)
//   - locale is a per-post field (forms don't carry locale)
//   - body_html / body_json are the canonical content (forms have no body)
//   - SEO metadata fields (seo_title, seo_description, seo_keywords,
//     og_image_url, canonical_url) — forms don't have any
//   - no secret_token: the public API authenticates by Host-header
//     resolution, not by capability token. The slug is the URL component.
//   - published_at is set on first transition to 'published' and not
//     updated on later edits, so the "publication date" is stable.
//   - slug is auto-generated from title on POST if the caller doesn't
//     supply one (forms require slug explicitly).

export const router = express.Router();
router.use(requireAuth);

const isEnduser = (req) => req.user && req.user.role === "enduser";
const requireProjectAccess = async (req, res, projectId) => {
  if (!isEnduser(req)) return null;
  const scopedProjectIds = await getScopedProjectIds(req);
  if (Array.isArray(scopedProjectIds) && !scopedProjectIds.includes(Number(projectId))) {
    return res.status(403).json({ errorMessage: "Access denied to this project" });
  }
  return null;
};

const STATUS_VALUES = new Set(["draft", "published", "archived"]);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;
const SLUG_MAX = 50;
const TITLE_MAX = 200;
const EXCERPT_MAX = 500;
const URL_MAX = 2000;
const SEO_TITLE_MAX = 70;
const SEO_DESC_MAX = 200;

function emptyToNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

// Hungarian-friendly slug from a free-form title: lowercase, replace
// non-[a-z0-9] runs with a single hyphen, strip leading/trailing hyphens,
// truncate to SLUG_MAX chars (word-boundary if possible). The result is
// run through SLUG_RE so anything unexpected is rejected at insert time
// rather than producing a 23505 on the UNIQUE constraint.
function slugify(title) {
  if (typeof title !== "string") return "";
  const lowered = title.toLowerCase();
  // Normalise accents to ASCII (NFD strip) so "téma" -> "tema".
  const stripped = lowered.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const hyphenated = stripped.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (hyphenated.length <= SLUG_MAX) return hyphenated;
  // Truncate at last hyphen before SLUG_MAX so we don't cut mid-word.
  const truncated = hyphenated.slice(0, SLUG_MAX);
  const lastHyphen = truncated.lastIndexOf("-");
  return lastHyphen > 10 ? truncated.slice(0, lastHyphen) : truncated;
}

// Snake_case DB row -> camelCase API DTO.
const rowToBlogPostDTO = (row) => {
  if (!row) return null;
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name ?? null,
    slug: row.slug,
    locale: row.locale,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.cover_image_url,
    bodyHtml: row.body_html,
    bodyJson: row.body_json ?? null,
    status: row.status,
    seoTitle: row.seo_title,
    seoDescription: row.seo_description,
    seoKeywords: Array.isArray(row.seo_keywords) ? row.seo_keywords : [],
    ogImageUrl: row.og_image_url,
    canonicalUrl: row.canonical_url,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by == null ? null : Number(row.created_by),
    // Translation group id. Posts with the same value are considered
    // translations of each other. The translations map (slug + title
    // per locale) is computed separately by the public API; the admin
    // DTO only carries the group id so the FE can fetch translations
    // on demand.
    translationGroupId: row.translation_group_id,
  };
};

// Whitelist of sortable API fields -> DB columns.
const SORTABLE = {
  id: "id",
  title: "title",
  slug: "slug",
  status: "status",
  locale: "locale",
  publishedAt: "published_at",
  createdAt: "created_at",
  updatedAt: "updated_at",
};
const SEARCH_COLUMNS = ["b.title", "b.slug", "b.excerpt"];

function makePlaceholderAllocator(startIndex = 1) {
  let n = startIndex;
  return {
    next: () => `$${n++}`,
    current: () => n - 1,
  };
}

function buildWhereClause(queries, filterType, allocator) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { sql: "", params: [] };
  const conj = filterType === "all" ? " AND " : " OR ";
  const built = terms.map((term) => {
    const ph = allocator.next();
    const colSql = SEARCH_COLUMNS.map((c) => `${c} ILIKE ${ph}`).join(" OR ");
    return { sql: `(${colSql})`, params: [`%${term}%`] };
  });
  return {
    clauses: built.map((b) => b.sql),
    params: built.flatMap((b) => b.params),
    sql: built.map((b) => b.sql).join(conj),
  };
}

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "updated_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  // Stable secondary sort on id so the page is deterministic when
  // updated_at collides (rare but possible on bulk import).
  return `ORDER BY ${col} ${dir}, id DESC`;
}

function buildProjectFilterClause(projectId, allocator) {
  if (projectId === undefined || projectId === null) {
    return { sql: "", params: [] };
  }
  const n = typeof projectId === "number" ? projectId : parseInt(projectId, 10);
  if (!Number.isFinite(n) || n <= 0) return { sql: "", params: [] };
  return { sql: `b.project_id = ${allocator.next()}`, params: [n] };
}

function buildStatusFilterClause(status, allocator) {
  if (!status) return { sql: "", params: [] };
  if (typeof status !== "string" || !STATUS_VALUES.has(status)) {
    return { sql: "", params: [], invalid: true };
  }
  return { sql: `b.status = ${allocator.next()}`, params: [status] };
}

function buildLocaleFilterClause(locale, allocator) {
  if (!locale) return { sql: "", params: [] };
  if (typeof locale !== "string" || !LOCALE_RE.test(locale)) {
    return { sql: "", params: [], invalid: true };
  }
  return { sql: `b.locale = ${allocator.next()}`, params: [locale] };
}

// Validate POST/PUT body. POST is strict (all required fields must be
// present); PUT (partial=true) only validates provided fields and
// rejects `projectId` changes (immutable post-create — same as forms).
function validateBlogPostBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

  // projectId is required on POST, REJECTED on PUT (immutable post-create).
  if (body.projectId !== undefined || body.project_id !== undefined) {
    if (partial) {
      errors.push("projectId cannot be changed");
    } else {
      const v = body.projectId ?? body.project_id;
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push("projectId must be a positive integer");
      } else {
        out.project_id = n;
      }
    }
  } else if (!partial) {
    errors.push("projectId is required");
  }

  // locale — defaults to 'hu' on POST if missing. PUT never changes locale.
  if (body.locale !== undefined) {
    if (typeof body.locale !== "string" || !LOCALE_RE.test(body.locale)) {
      errors.push("locale must match /^[a-z]{2}(-[A-Z]{2})?$/ (e.g. 'hu', 'en', 'en-US')");
    } else {
      out.locale = body.locale;
    }
  } else if (!partial) {
    out.locale = "hu";
  } else {
    errors.push("locale cannot be changed");
  }

  // title
  if (body.title !== undefined) {
    if (typeof body.title !== "string") {
      errors.push("title must be a string");
    } else {
      const trimmed = body.title.trim();
      if (trimmed.length < 1 || trimmed.length > TITLE_MAX) {
        errors.push(`title must be 1..${TITLE_MAX} chars`);
      } else {
        out.title = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("title is required");
  }

  // slug — optional on POST (auto-generated from title). PUT that tries
  // to change slug triggers a 23505 unique violation on collision.
  if (body.slug !== undefined) {
    if (typeof body.slug !== "string") {
      errors.push("slug must be a string");
    } else {
      const trimmed = body.slug.trim();
      if (!SLUG_RE.test(trimmed) || trimmed.length < 1 || trimmed.length > SLUG_MAX) {
        errors.push(`slug must be 1..${SLUG_MAX} chars, lowercase kebab-case (a-z, 0-9, hyphens)`);
      } else {
        out.slug = trimmed;
      }
    }
  }
  // No else: slug is optional on POST — auto-generated below.

  // excerpt — optional
  if (body.excerpt !== undefined) {
    const v = emptyToNull(body.excerpt);
    if (v !== null && (typeof v !== "string" || v.length > EXCERPT_MAX)) {
      errors.push(`excerpt must be at most ${EXCERPT_MAX} chars`);
    } else {
      out.excerpt = v;
    }
  } else if (!partial) {
    out.excerpt = null;
  }

  // coverImageUrl — optional
  if (body.coverImageUrl !== undefined) {
    const v = emptyToNull(body.coverImageUrl);
    if (v !== null && (typeof v !== "string" || v.length > URL_MAX)) {
      errors.push(`coverImageUrl must be at most ${URL_MAX} chars`);
    } else {
      out.cover_image_url = v;
    }
  } else if (!partial) {
    out.cover_image_url = null;
  }

  // bodyHtml — required on POST, sanitized at write-time.
  if (body.bodyHtml !== undefined) {
    if (typeof body.bodyHtml !== "string") {
      errors.push("bodyHtml must be a string");
    } else if (body.bodyHtml.length === 0) {
      errors.push("bodyHtml must not be empty");
    } else {
      try {
        out.body_html = sanitizeBlogBody(body.bodyHtml);
      } catch (err) {
        errors.push(`bodyHtml sanitization failed: ${err.message}`);
      }
    }
  } else if (!partial) {
    errors.push("bodyHtml is required");
  }

  // bodyJson — optional, must be a JSON object if provided.
  if (body.bodyJson !== undefined && body.bodyJson !== null) {
    if (typeof body.bodyJson !== "object" || Array.isArray(body.bodyJson)) {
      errors.push("bodyJson must be a JSON object");
    } else {
      out.body_json = body.bodyJson;
    }
  } else if (!partial) {
    out.body_json = null;
  }

  // status — defaults to 'draft' on POST. PUT that sets 'published'
  // updates published_at only on the first transition (handled by the
  // dedicated /publish endpoint, NOT by a plain PUT).
  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  } else if (!partial) {
    out.status = "draft";
  }

  // SEO fields — all optional.
  if (body.seoTitle !== undefined) {
    const v = emptyToNull(body.seoTitle);
    if (v !== null && (typeof v !== "string" || v.length > SEO_TITLE_MAX)) {
      errors.push(`seoTitle must be at most ${SEO_TITLE_MAX} chars`);
    } else {
      out.seo_title = v;
    }
  } else if (!partial) {
    out.seo_title = null;
  }

  if (body.seoDescription !== undefined) {
    const v = emptyToNull(body.seoDescription);
    if (v !== null && (typeof v !== "string" || v.length > SEO_DESC_MAX)) {
      errors.push(`seoDescription must be at most ${SEO_DESC_MAX} chars`);
    } else {
      out.seo_description = v;
    }
  } else if (!partial) {
    out.seo_description = null;
  }

  if (body.seoKeywords !== undefined) {
    if (!Array.isArray(body.seoKeywords)) {
      errors.push("seoKeywords must be an array of strings");
    } else if (body.seoKeywords.length > 20) {
      errors.push("seoKeywords: maximum 20 entries");
    } else {
      const cleaned = body.seoKeywords
        .filter((k) => typeof k === "string" && k.trim().length > 0)
        .map((k) => k.trim().slice(0, 50));
      out.seo_keywords = cleaned;
    }
  } else if (!partial) {
    out.seo_keywords = [];
  }

  if (body.ogImageUrl !== undefined) {
    const v = emptyToNull(body.ogImageUrl);
    if (v !== null && (typeof v !== "string" || v.length > URL_MAX)) {
      errors.push(`ogImageUrl must be at most ${URL_MAX} chars`);
    } else {
      out.og_image_url = v;
    }
  } else if (!partial) {
    out.og_image_url = null;
  }

  if (body.canonicalUrl !== undefined) {
    const v = emptyToNull(body.canonicalUrl);
    if (v !== null && (typeof v !== "string" || v.length > URL_MAX)) {
      errors.push(`canonicalUrl must be at most ${URL_MAX} chars`);
    } else {
      out.canonical_url = v;
    }
  } else if (!partial) {
    out.canonical_url = null;
  }

  // translationGroupId — UUID linking translations across locales.
  // Operator flow: when creating a post that's a translation of an
  // existing one, paste the source post's translation_group_id
  // (visible in its view page) into the new post's create form. The
  // DB schema auto-generates a fresh UUID on insert if the field is
  // omitted, so the operator only needs to know the group id when
  // they're explicitly linking.
  //
  // The BE does NOT verify that the provided group id belongs to the
  // same project — that's a UX nicety the admin UI handles by showing
  // the group id alongside the post. A wrong group id means the
  // translations list will surface posts from a different project
  // (which is the operator's bug, not a security issue), so we
  // don't 400 here.
  if (body.translationGroupId !== undefined && body.translationGroupId !== null) {
    if (typeof body.translationGroupId !== "string") {
      errors.push("translationGroupId must be a string (UUID)");
    } else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.translationGroupId)) {
      errors.push("translationGroupId must be a UUID");
    } else {
      out.translation_group_id = body.translationGroupId;
    }
  }
  // On POST, if not provided, the DB DEFAULT gen_random_uuid() takes
  // over. On PUT, leaving it unchanged preserves the existing group.

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// ---- GET /api/blog ----
router.get("/", async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(
    100,
    Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
  );
  const sortField = req.query.sortField || "updatedAt";
  const sortOrder = req.query.sortOrder === "asc" ? "asc" : "desc";
  const rawQueries = req.query.queries;
  const queries = Array.isArray(rawQueries)
    ? rawQueries
    : rawQueries
      ? [rawQueries]
      : [];
  const filterType = req.query.filterType === "all" ? "all" : "any";

  const allocator = makePlaceholderAllocator(1);
  const projectFilter = buildProjectFilterClause(
    req.query.projectId ?? req.query.project_id,
    allocator,
  );
  const statusFilter = buildStatusFilterClause(req.query.status, allocator);
  const localeFilter = buildLocaleFilterClause(req.query.locale, allocator);
  if (statusFilter.invalid || localeFilter.invalid) {
    return res.status(400).json({ errorMessage: "Invalid filter parameter" });
  }
  const searchFilter = buildWhereClause(queries, filterType, allocator);

  const scopedProjectIds = await getScopedProjectIds(req);
  const enduserScope =
    scopedProjectIds === null || scopedProjectIds === undefined
      ? { sql: "", params: [] }
      : appendProjectScope({
          placeholderIndex: allocator.next(),
          projectIds: scopedProjectIds,
          tableAlias: "b",
        });
  const enduserScopeSql = enduserScope.sql
    ? enduserScope.sql.replace(/^\s*AND\b/i, "")
    : "";

  const allConditions = [
    projectFilter.sql,
    statusFilter.sql,
    localeFilter.sql,
    searchFilter.sql,
    enduserScopeSql,
  ].filter(Boolean);
  const whereSql =
    allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
  const whereParams = [
    ...projectFilter.params,
    ...statusFilter.params,
    ...localeFilter.params,
    ...searchFilter.params,
    ...enduserScope.params,
  ];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;
  const limitPh = allocator.next();
  const offsetPh = allocator.next();

  try {
    const countSql = `SELECT COUNT(*)::int AS total
                      FROM blog_posts b
                      JOIN projects p ON p.id = b.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT b.id, b.project_id, p.name AS project_name,
                                  b.slug, b.locale, b.title, b.excerpt,
                                  b.cover_image_url, b.body_html, b.body_json,
                                  b.status, b.seo_title, b.seo_description,
                                  b.seo_keywords, b.og_image_url, b.canonical_url,
                                  b.canonical_url, b.published_at, b.created_at, b.updated_at,
                                  b.created_by,
                                  b.translation_group_id
                           FROM blog_posts b
                           JOIN projects p ON p.id = b.project_id
                           ${whereSql}
                           ${order}
                           LIMIT ${limitPh} OFFSET ${offsetPh}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...whereParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToBlogPostDTO);
    const sorted = !!req.query.sortField;

    return res.json({
      totalPages,
      totalElements,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset,
        sort: { sorted, unsorted: !sorted, empty: false },
      },
      numberOfElements: rows.length,
      size,
      content: rows,
      number: page,
      sort: { sorted, unsorted: !sorted, empty: false },
      first: page === 0,
      last: page === totalPages - 1,
      empty: rows.length === 0,
    });
  } catch (err) {
    console.error("[blog/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/blog/slug-check ----
// Cheap, debounced-friendly slug availability check for the FE form.
// Returns { available: boolean, slug: string }. Same-project collisions
// return available=false; cross-project collisions always return
// available=true because slug uniqueness is per (project_id, locale).
//
// MUST be declared before /:id, otherwise Express matches "slug-check"
// as a numeric :id and 400s out.
router.get("/slug-check", async (req, res) => {
  const rawSlug = emptyToNull(req.query.slug);
  const projectId = parseInt(req.query.projectId ?? req.query.project_id, 10);
  const locale = emptyToNull(req.query.locale) ?? "hu";

  if (!rawSlug || !SLUG_RE.test(rawSlug)) {
    return res.status(400).json({ errorMessage: "Invalid slug" });
  }
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid projectId" });
  }
  if (!LOCALE_RE.test(locale)) {
    return res.status(400).json({ errorMessage: "Invalid locale" });
  }

  // Enduser scope: can only check slugs for projects they're assigned to.
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
  }

  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM blog_posts
       WHERE project_id = $1 AND slug = $2 AND locale = $3
       LIMIT 1`,
      [projectId, rawSlug, locale],
    );
    return res.json({ available: rows.length === 0, slug: rawSlug });
  } catch (err) {
    console.error("[blog/slug-check]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- GET /api/blog/:id ----
router.get("/:id", async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM blog_posts WHERE id = $1`,
      [postId],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "Blog post not found" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.project_id, p.name AS project_name,
              b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
              b.body_html, b.body_json, b.status, b.seo_title,
              b.seo_description, b.seo_keywords, b.og_image_url,
              b.canonical_url, b.published_at, b.created_at, b.updated_at,
              b.created_by,
              b.translation_group_id
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    return res.json(rowToBlogPostDTO(rows[0]));
  } catch (err) {
    console.error("[blog/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/blog ----
router.post("/", async (req, res) => {
  const validation = validateBlogPostBody(req.body, { partial: false });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;

  const guard = await requireProjectAccess(req, res, v.project_id);
  if (guard) return guard;

  // Fail-fast on missing project (FK violation would bubble up but a
  // clean 404 is friendlier for the FE error UX).
  try {
    const proj = await pool.query(`SELECT id FROM projects WHERE id = $1`, [
      v.project_id,
    ]);
    if (proj.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
  } catch (err) {
    console.error("[blog/create] project lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Auto-slug from title when caller didn't supply one. We do this AFTER
  // the project lookup so we don't generate a slug for a missing project.
  // If the generated slug already exists, the unique-constraint violation
  // surfaces as 409 below.
  if (!v.slug) {
    v.slug = slugify(v.title);
    if (!v.slug) {
      return res.status(400).json({
        errorMessage: "title contains no slugifiable characters; supply a slug explicitly",
      });
    }
  }

  // published_at: set on create only if the caller wants published
  // status. Subsequent edits don't touch it (stability).
  const publishedAt = v.status === "published" ? new Date() : null;

  try {
    const { rows } = await pool.query(
      `INSERT INTO blog_posts
        (project_id, slug, locale, title, excerpt, cover_image_url,
         body_html, body_json, status, seo_title, seo_description,
         seo_keywords, og_image_url, canonical_url, published_at,
         created_by, translation_group_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
               $11, $12, $13, $14, $15, $16,
               COALESCE($17, gen_random_uuid()))
       RETURNING id, project_id, slug, locale, title, excerpt,
                 cover_image_url, body_html, body_json, status,
                 seo_title, seo_description, seo_keywords,
                 og_image_url, canonical_url, published_at,
                 created_at, updated_at, created_by,
                 translation_group_id`,
      [
        v.project_id,
        v.slug,
        v.locale,
        v.title,
        v.excerpt,
        v.cover_image_url,
        v.body_html,
        v.body_json ? JSON.stringify(v.body_json) : null,
        v.status,
        v.seo_title,
        v.seo_description,
        v.seo_keywords,
        v.og_image_url,
        v.canonical_url,
        publishedAt,
        req.user?.id ?? null,
        v.translation_group_id ?? null,
      ],
    );
    // Re-read with project_name joined so the DTO matches GET /:id.
    const { rows: joined } = await pool.query(
      `SELECT b.id, b.project_id, p.name AS project_name,
              b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
              b.body_html, b.body_json, b.status, b.seo_title,
              b.seo_description, b.seo_keywords, b.og_image_url,
              b.canonical_url, b.published_at, b.created_at, b.updated_at,
              b.created_by,
              b.translation_group_id
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [rows[0].id],
    );
    return res.status(201).json(rowToBlogPostDTO(joined[0]));
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        errorMessage:
          "A blog post with this slug already exists for this project and locale",
      });
    }
    console.error("[blog/create]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- PUT /api/blog/:id ----
router.put("/:id", async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  // Verify post exists and check enduser project access.
  let postRow;
  try {
    const { rows } = await pool.query(
      `SELECT project_id FROM blog_posts WHERE id = $1`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    postRow = rows[0];
  } catch (err) {
    console.error("[blog/update] post lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
  const guard = await requireProjectAccess(req, res, postRow.project_id);
  if (guard) return guard;

  const validation = validateBlogPostBody(req.body, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  if (Object.keys(v).length === 0) {
    return res.status(400).json({ errorMessage: "No fields to update" });
  }

  // Build the SET clause dynamically from validated fields. We rely on
  // the validator to strip anything dangerous (projectId/locale rejected
  // above), so the column names are hardcoded here.
  const setClauses = [];
  const setParams = [];
  let i = 1;
  if ("title" in v) { setClauses.push(`title = $${i++}`); setParams.push(v.title); }
  if ("slug" in v) { setClauses.push(`slug = $${i++}`); setParams.push(v.slug); }
  if ("excerpt" in v) { setClauses.push(`excerpt = $${i++}`); setParams.push(v.excerpt); }
  if ("cover_image_url" in v) { setClauses.push(`cover_image_url = $${i++}`); setParams.push(v.cover_image_url); }
  if ("body_html" in v) { setClauses.push(`body_html = $${i++}`); setParams.push(v.body_html); }
  if ("body_json" in v) {
    setClauses.push(`body_json = $${i++}`);
    setParams.push(v.body_json ? JSON.stringify(v.body_json) : null);
  }
  if ("status" in v) {
    setClauses.push(`status = $${i++}`);
    setParams.push(v.status);
    // NOTE: status flip to 'published' via PUT does NOT set published_at.
    // published_at is owned by the /publish endpoint so it can stay
    // stable across subsequent edits. PUT-with-status-published is
    // treated as a content update on an already-published post.
    if (v.status === "published") {
      setClauses.push(`published_at = COALESCE(published_at, now())`);
    }
  }
  if ("seo_title" in v) { setClauses.push(`seo_title = $${i++}`); setParams.push(v.seo_title); }
  if ("seo_description" in v) { setClauses.push(`seo_description = $${i++}`); setParams.push(v.seo_description); }
  if ("seo_keywords" in v) { setClauses.push(`seo_keywords = $${i++}`); setParams.push(v.seo_keywords); }
  if ("og_image_url" in v) { setClauses.push(`og_image_url = $${i++}`); setParams.push(v.og_image_url); }
  if ("canonical_url" in v) { setClauses.push(`canonical_url = $${i++}`); setParams.push(v.canonical_url); }
  // translation_group_id can be updated to link this post to another
  // group, or to switch it back to its own (a new group) by passing
  // a fresh UUID. The DB has no auto-DEFAULT here because we use the
  // operator-supplied value verbatim; passing null would explicitly
  // unlink the post from any group (a niche flow but allowed).
  if ("translation_group_id" in v) {
    setClauses.push(`translation_group_id = $${i++}`);
    setParams.push(v.translation_group_id);
  }

  setParams.push(postId);
  const wherePh = `$${i++}`;

  try {
    const { rows } = await pool.query(
      `UPDATE blog_posts
       SET ${setClauses.join(", ")}
       WHERE id = ${wherePh}
       RETURNING id`,
      setParams,
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        errorMessage:
          "A blog post with this slug already exists for this project and locale",
      });
    }
    console.error("[blog/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Re-read with project_name joined so the DTO matches GET /:id.
  try {
    const { rows: joined } = await pool.query(
      `SELECT b.id, b.project_id, p.name AS project_name,
              b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
              b.body_html, b.body_json, b.status, b.seo_title,
              b.seo_description, b.seo_keywords, b.og_image_url,
              b.canonical_url, b.published_at, b.created_at, b.updated_at,
              b.created_by,
              b.translation_group_id
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    return res.json(rowToBlogPostDTO(joined[0]));
  } catch (err) {
    console.error("[blog/update re-read]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/blog/:id/publish ----
// Idempotent status flip to 'published'. Sets published_at only on the
// first transition (COALESCE) so subsequent edits don't shift the
// publication date. Triggers a landing rebuild flag if the project has
// its landing integration enabled.
router.post("/:id/publish", async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  // Verify post exists and check enduser project access.
  let postRow;
  try {
    const { rows } = await pool.query(
      `SELECT project_id FROM blog_posts WHERE id = $1`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    postRow = rows[0];
  } catch (err) {
    console.error("[blog/publish] post lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
  const guard = await requireProjectAccess(req, res, postRow.project_id);
  if (guard) return guard;

  let project;
  try {
    const { rows } = await pool.query(
      `UPDATE blog_posts b
       SET status = 'published',
           published_at = COALESCE(b.published_at, now()),
           updated_at = now()
       FROM projects p
       WHERE b.id = $1 AND b.project_id = p.id
       RETURNING b.id, b.project_id, p.domain_address, p.landing_enabled,
                 p.landing_repo_dir, p.landing_build_command`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    project = rows[0];
  } catch (err) {
    console.error("[blog/publish]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Fire-and-forget landing rebuild trigger. We don't await this — the
  // host-cron watcher polls the flag directory every minute (or sooner if
  // a faster trigger is configured), so the publish response shouldn't
  // block on disk I/O. Failures here are logged but don't surface to the
  // user — the post is published regardless.
  if (project.landing_enabled && project.landing_repo_dir) {
    writeLandingRebuildFlag({
      domain: project.domain_address,
      repoDir: project.landing_repo_dir,
      buildCommand: project.landing_build_command,
      reason: `publish:post:${postId}`,
    }).catch((err) => {
      console.error("[blog/publish] rebuild flag failed:", err.message);
    });
  }

  // Return the updated DTO so the FE can refresh its view.
  try {
    const { rows: joined } = await pool.query(
      `SELECT b.id, b.project_id, p.name AS project_name,
              b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
              b.body_html, b.body_json, b.status, b.seo_title,
              b.seo_description, b.seo_keywords, b.og_image_url,
              b.canonical_url, b.published_at, b.created_at, b.updated_at,
              b.created_by,
              b.translation_group_id
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    return res.json(rowToBlogPostDTO(joined[0]));
  } catch (err) {
    console.error("[blog/publish re-read]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/blog/:id/unpublish ----
// Idempotent status flip to 'draft'. published_at is intentionally NOT
// cleared — it represents the most recent publication event and we keep
// it so re-publishing later (or audit) has the original date.
router.post("/:id/unpublish", async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  // Verify post exists and check enduser project access.
  let postRow;
  try {
    const { rows } = await pool.query(
      `SELECT project_id FROM blog_posts WHERE id = $1`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    postRow = rows[0];
  } catch (err) {
    console.error("[blog/unpublish] post lookup", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
  const guard = await requireProjectAccess(req, res, postRow.project_id);
  if (guard) return guard;

  try {
    const { rows } = await pool.query(
      `UPDATE blog_posts SET status = 'draft', updated_at = now() WHERE id = $1 RETURNING id`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
  } catch (err) {
    console.error("[blog/unpublish]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Rebuild trigger so the landing removes the post from its dist.
  // Same pattern as /publish: best-effort, doesn't fail the response.
  try {
    const { rows: meta } = await pool.query(
      `SELECT b.project_id, p.domain_address, p.landing_enabled,
              p.landing_repo_dir, p.landing_build_command
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    if (meta[0]?.landing_enabled && meta[0].landing_repo_dir) {
      writeLandingRebuildFlag({
        domain: meta[0].domain_address,
        repoDir: meta[0].landing_repo_dir,
        buildCommand: meta[0].landing_build_command,
        reason: `unpublish:post:${postId}`,
      }).catch((err) => {
        console.error("[blog/unpublish] rebuild flag failed:", err.message);
      });
    }
  } catch (err) {
    // Non-fatal — log and move on.
    console.error("[blog/unpublish] rebuild lookup:", err.code, err.message);
  }

  try {
    const { rows: joined } = await pool.query(
      `SELECT b.id, b.project_id, p.name AS project_name,
              b.slug, b.locale, b.title, b.excerpt, b.cover_image_url,
              b.body_html, b.body_json, b.status, b.seo_title,
              b.seo_description, b.seo_keywords, b.og_image_url,
              b.canonical_url, b.published_at, b.created_at, b.updated_at,
              b.created_by,
              b.translation_group_id
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    return res.json(rowToBlogPostDTO(joined[0]));
  } catch (err) {
    console.error("[blog/unpublish re-read]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/blog/:id ----
// Hard delete. The landing rebuild removes the dist file on the next
// cron tick (the slug will be in the rebuild state but not in the CRM
// anymore, so generate-route-html.mjs will prune it).
//
// We considered soft-delete via status='archived', but the archives are
// already what an unpublished post is in the operator's mental model —
// adding 'archived' as a third lifecycle state on top of draft/published
// would muddle the FE UX without buying anything the status='archived'
// enum value wouldn't give us anyway.
//
// For now: hard delete only. If auditability becomes a requirement,
// flip this to a status='archived' transition.
router.delete("/:id", async (req, res) => {
  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  // Capture project info for the rebuild trigger BEFORE the row is
  // gone — DELETE ... RETURNING only gives us the deleted row, not the
  // joined project. This also gates enduser project access.
  let meta;
  try {
    const { rows } = await pool.query(
      `SELECT b.project_id, p.domain_address, p.landing_enabled,
              p.landing_repo_dir, p.landing_build_command, b.slug
       FROM blog_posts b
       JOIN projects p ON p.id = b.project_id
       WHERE b.id = $1`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
    meta = rows[0];
  } catch (err) {
    console.error("[blog/delete lookup]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
  const guard = await requireProjectAccess(req, res, meta.project_id);
  if (guard) return guard;

  try {
    const { rows } = await pool.query(
      `DELETE FROM blog_posts WHERE id = $1 RETURNING id`,
      [postId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Blog post not found" });
    }
  } catch (err) {
    console.error("[blog/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  if (meta.landing_enabled && meta.landing_repo_dir) {
    writeLandingRebuildFlag({
      domain: meta.domain_address,
      repoDir: meta.landing_repo_dir,
      buildCommand: meta.landing_build_command,
      reason: `delete:post:${meta.slug}`,
    }).catch((err) => {
      console.error("[blog/delete] rebuild flag failed:", err.message);
    });
  }

  return res.status(204).end();
});