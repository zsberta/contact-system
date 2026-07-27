// routes/ai-assistant.js
//
// =============================================================================
// AI Assistant module — admin CRUD (sibling to routes/analytics.js).
// =============================================================================
//
// Each project has exactly ONE ai_assistant_configs row (enforced by the
// UNIQUE FK on project_id). The row is created lazily on first access
// via GET /api/ai-assistant/by-project/:projectId.
//
// What lives here:
//   - Admin CRUD on ai_assistant_configs (paginated list, GET, PUT, DELETE)
//   - Lazy upsert GET /api/ai-assistant/by-project/:projectId
//   - Snippet endpoint GET /api/ai-assistant/:id/snippet (renders the JS
//     loader with APP_PUBLIC_URL baked in)
//   - Knowledge base document management (list, upload, delete)
//   - Chat session and message browsing (read-only)
//
// What lives in routes/ai-assistant-embed.js (mounted at /api/public/ai-assistant):
//   - Public script.js: GET /:secret_token/script.js
//   - Public config:    GET /:secret_token/config
//   - Public chat:      POST /:secret_token/chat
//   - Public language:  POST /:secret_token/language
//
// =============================================================================
// SECURITY MODEL
// =============================================================================
// - All routes here require auth (router.use(requireAuth)). Mutations are
//   rejected with 403 for endusers (read-only contract).
// - Enduser scoping: endusers can only see configs on projects they're
//   assigned to (same pattern as analytics / forms / reservations).
// - secret_token is 22-char base64url = 16 random bytes (128 bits entropy),
//   server-generated at create time, immutable thereafter.
// - allowed_origins: same semantics as analytics.allowed_origins.
// - 404 (not 403) is used to mask "unknown config" vs "config on a
//   project you can't see" so an enduser can't probe for config ids.

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import multer from "multer";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";
import { processDocument } from "../lib/ai-knowledge-processor.js";
import { encrypt } from "../lib/ai-encryption.js";

// Read-only for endusers. Mutations are rejected with 403.
const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduserMutation = (req, res) => {
  if (isEnduser(req)) {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  return null;
};

export const router = express.Router();
router.use(requireAuth);

const STATUS_VALUES = new Set(["active", "disabled"]);

// ---------------------------------------------------------------------------
// Origin-allowlist validator — MUST stay byte-for-byte identical to the one
// in routes/analytics.js (same semantics, same regexes).
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS_MAX = 100;
const HOSTNAME_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const SCHEME_HOSTNAME_RE = /^https?:\/\/(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const LOOPBACK_BARE = /^localhost(:[0-9]{1,5})?$/;
const LOOPBACK_IPV4 = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$/;
const LOOPBACK_IPV6 = /^\[::1?\](:[0-9]{1,5})?$/;
const LOOPBACK_SCHEME = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$/;

function validateAllowedOriginsEntry(entry, index, seen) {
  if (typeof entry !== "string") {
    return `allowedOrigins[${index}]: must be a string`;
  }
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > 253) {
    return `allowedOrigins[${index}]: must be 1..253 chars`;
  }
  const isBare = HOSTNAME_RE.test(trimmed);
  const isScheme = SCHEME_HOSTNAME_RE.test(trimmed);
  const isLoopbackBare = LOOPBACK_BARE.test(trimmed) ||
    LOOPBACK_IPV4.test(trimmed) || LOOPBACK_IPV6.test(trimmed);
  const isLoopbackScheme = LOOPBACK_SCHEME.test(trimmed);
  if (!isBare && !isScheme && !isLoopbackBare && !isLoopbackScheme) {
    return `allowedOrigins[${index}]: invalid origin (${entry})`;
  }
  let normalised;
  if (isScheme || isLoopbackScheme) {
    normalised = trimmed;
  } else {
    normalised = `https://${trimmed}`;
  }
  if (seen.has(normalised)) {
    return `allowedOrigins[${index}]: duplicate`;
  }
  seen.add(normalised);
  return { ok: true, value: normalised };
}

// Snake_case DB row -> camelCase API DTO.
function rowToConfigDTO(row) {
  if (!row) return null;
  let allowedOrigins = [];
  if (Array.isArray(row.allowed_origins)) {
    allowedOrigins = row.allowed_origins.filter((d) => typeof d === "string");
  } else if (typeof row.allowed_origins === "string" && row.allowed_origins.length > 0) {
    try { allowedOrigins = JSON.parse(row.allowed_origins); }
    catch { allowedOrigins = []; }
  }
  allowedOrigins = Array.isArray(allowedOrigins)
    ? allowedOrigins.filter((d) => typeof d === "string")
    : [];
  let supportedLanguages = [];
  if (Array.isArray(row.supported_languages)) {
    supportedLanguages = row.supported_languages.filter((d) => typeof d === "string");
  } else if (typeof row.supported_languages === "string" && row.supported_languages.length > 0) {
    try { supportedLanguages = JSON.parse(row.supported_languages); }
    catch { supportedLanguages = []; }
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name ?? null,
    name: row.name ?? "",
    secretToken: row.secret_token,
    status: row.status,
    // AI configuration
    aiConfigId: row.ai_config_id != null ? Number(row.ai_config_id) : null,
    model: row.model ?? "gpt-4o",
    baseUrl: row.base_url ?? "",
    basePrompt: row.base_prompt ?? "",
    // Widget branding
    displayName: row.display_name ?? "AI Assistant",
    primaryColor: row.primary_color ?? "#3b82f6",
    secondaryColor: row.secondary_color ?? "#ffffff",
    greetingMessage: row.greeting_message ?? "",
    legalMessage: row.legal_message ?? "",
    avatarUrl: row.avatar_url ?? null,
    position: row.position ?? "bottom-right",
    // Multilanguage
    defaultLanguage: row.default_language ?? "en",
    supportedLanguages,
    // Security
    allowedOrigins,
    rateLimitBurst: Number(row.rate_limit_burst) || 30,
    rateLimitSustained: Number(row.rate_limit_sustained) || 500,
    maxUploadSizeMb: Number(row.max_upload_size_mb) || 20,
    // API key is NEVER returned in the DTO (write-only).
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// Whitelist of sortable API fields -> DB columns.
const SORTABLE = {
  id: "id",
  name: "name",
  status: "status",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

const SEARCH_COLUMNS = ["c.name"];

function makePlaceholderAllocator(startIndex = 1) {
  let n = startIndex;
  return {
    next: () => `$${n++}`,
    current: () => n - 1,
  };
}

function buildWhereClause(queries, filterType, allocator) {
  const terms = (queries || []).filter((q) => q && q.trim().length > 0);
  if (terms.length === 0) return { clauses: [], params: [] };
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
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, id DESC`;
}

function buildProjectFilterClause(projectId, allocator) {
  if (projectId === undefined || projectId === null) {
    return { sql: "", params: [] };
  }
  const n = typeof projectId === "number" ? projectId : parseInt(projectId, 10);
  if (!Number.isFinite(n) || n <= 0) return { sql: "", params: [] };
  return { sql: `c.project_id = ${allocator.next()}`, params: [n] };
}

// Validate PUT body.
function validateConfigBody(body, { partial = false } = {}) {
  const out = {};
  const errors = [];

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

  if (body.name !== undefined) {
    if (typeof body.name !== "string") {
      errors.push("name must be a string");
    } else {
      const trimmed = body.name.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        errors.push("name must be 1..200 chars");
      } else {
        out.name = trimmed;
      }
    }
  } else if (!partial) {
    errors.push("name is required");
  }

  if (body.secretToken !== undefined || body.secret_token !== undefined) {
    errors.push("secretToken cannot be set or changed");
  }

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !STATUS_VALUES.has(body.status)) {
      errors.push(`status must be one of ${[...STATUS_VALUES].join(", ")}`);
    } else {
      out.status = body.status;
    }
  } else if (!partial) {
    out.status = "active";
  }

  // Allowed origins
  if (body.allowedOrigins !== undefined || body.allowed_origins !== undefined) {
    const raw = body.allowedOrigins ?? body.allowed_origins;
    if (!Array.isArray(raw)) {
      errors.push("allowedOrigins must be an array");
    } else if (raw.length > ALLOWED_ORIGINS_MAX) {
      errors.push(`allowedOrigins: maximum ${ALLOWED_ORIGINS_MAX} entries`);
    } else {
      const cleaned = [];
      const seen = new Set();
      for (let i = 0; i < raw.length; i++) {
        const result = validateAllowedOriginsEntry(raw[i], i, seen);
        if (typeof result === "string") {
          errors.push(result);
          continue;
        }
        cleaned.push(result.value);
      }
      if (errors.length === 0) {
        out.allowed_origins = cleaned;
      }
    }
  } else if (!partial) {
    out.allowed_origins = [];
  }

  // AI configuration fields
  if (body.model !== undefined) {
    if (typeof body.model !== "string") {
      errors.push("model must be a string");
    } else {
      const trimmed = body.model.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        errors.push("model must be 1..200 chars");
      } else {
        out.model = trimmed;
      }
    }
  } else if (!partial) {
    out.model = "gpt-4o";
  }

  if (body.baseUrl !== undefined || body.base_url !== undefined) {
    const v = body.baseUrl ?? body.base_url;
    if (typeof v !== "string") {
      errors.push("baseUrl must be a string");
    } else {
      const trimmed = v.trim();
      if (trimmed.length < 1 || trimmed.length > 500) {
        errors.push("baseUrl must be 1..500 chars");
      } else {
        out.base_url = trimmed;
      }
    }
  } else if (!partial) {
    out.base_url = "https://api.openai.com/v1";
  }

  if (body.apiKey !== undefined || body.api_key !== undefined) {
    const v = body.apiKey ?? body.api_key;
    if (typeof v === "string" && v.length > 0) {
      out.api_key_enc = encrypt(v);
    }
  }

  if (body.basePrompt !== undefined || body.base_prompt !== undefined) {
    const v = body.basePrompt ?? body.base_prompt;
    if (typeof v !== "string") {
      errors.push("basePrompt must be a string");
    } else {
      if (v.length > 10000) {
        errors.push("basePrompt must be <= 10000 chars");
      } else {
        out.base_prompt = v;
      }
    }
  } else if (!partial) {
    out.base_prompt = "You are a helpful assistant.";
  }

  // Widget branding
  if (body.displayName !== undefined || body.display_name !== undefined) {
    const v = body.displayName ?? body.display_name;
    if (typeof v !== "string") {
      errors.push("displayName must be a string");
    } else {
      const trimmed = v.trim();
      if (trimmed.length < 1 || trimmed.length > 200) {
        errors.push("displayName must be 1..200 chars");
      } else {
        out.display_name = trimmed;
      }
    }
  } else if (!partial) {
    out.display_name = "AI Assistant";
  }

  if (body.primaryColor !== undefined || body.primary_color !== undefined) {
    const v = body.primaryColor ?? body.primary_color;
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(v)) {
      errors.push("primaryColor must be a valid hex color");
    } else {
      out.primary_color = v;
    }
  } else if (!partial) {
    out.primary_color = "#3b82f6";
  }

  if (body.secondaryColor !== undefined || body.secondary_color !== undefined) {
    const v = body.secondaryColor ?? body.secondary_color;
    if (typeof v !== "string" || !/^#[0-9a-fA-F]{3,8}$/.test(v)) {
      errors.push("secondaryColor must be a valid hex color");
    } else {
      out.secondary_color = v;
    }
  } else if (!partial) {
    out.secondary_color = "#ffffff";
  }

  if (body.greetingMessage !== undefined || body.greeting_message !== undefined) {
    const v = body.greetingMessage ?? body.greeting_message;
    if (typeof v !== "string") {
      errors.push("greetingMessage must be a string");
    } else {
      if (v.length > 2000) {
        errors.push("greetingMessage must be <= 2000 chars");
      } else {
        out.greeting_message = v;
      }
    }
  } else if (!partial) {
    out.greeting_message = "Hello! How can I help you today?";
  }

  if (body.legalMessage !== undefined || body.legal_message !== undefined) {
    const v = body.legalMessage ?? body.legal_message;
    if (typeof v !== "string") {
      errors.push("legalMessage must be a string");
    } else {
      if (v.length > 5000) {
        errors.push("legalMessage must be <= 5000 chars");
      } else {
        out.legal_message = v;
      }
    }
  } else if (!partial) {
    out.legal_message = "";
  }

  if (body.avatarUrl !== undefined || body.avatar_url !== undefined) {
    const v = body.avatarUrl ?? body.avatar_url;
    if (v !== null && v !== undefined && typeof v !== "string") {
      errors.push("avatarUrl must be a string or null");
    } else {
      out.avatar_url = v || null;
    }
  } else if (!partial) {
    out.avatar_url = null;
  }

  if (body.position !== undefined) {
    const valid = new Set(["bottom-right", "bottom-left"]);
    if (typeof body.position !== "string" || !valid.has(body.position)) {
      errors.push("position must be 'bottom-right' or 'bottom-left'");
    } else {
      out.position = body.position;
    }
  } else if (!partial) {
    out.position = "bottom-right";
  }

  // Multilanguage
  if (body.defaultLanguage !== undefined || body.default_language !== undefined) {
    const v = body.defaultLanguage ?? body.default_language;
    if (typeof v !== "string") {
      errors.push("defaultLanguage must be a string");
    } else {
      const trimmed = v.trim();
      if (trimmed.length < 2 || trimmed.length > 10) {
        errors.push("defaultLanguage must be 2..10 chars");
      } else {
        out.default_language = trimmed;
      }
    }
  } else if (!partial) {
    out.default_language = "en";
  }

  if (body.supportedLanguages !== undefined || body.supported_languages !== undefined) {
    const v = body.supportedLanguages ?? body.supported_languages;
    if (!Array.isArray(v)) {
      errors.push("supportedLanguages must be an array");
    } else {
      const cleaned = v
        .filter((s) => typeof s === "string" && s.trim().length >= 2 && s.trim().length <= 10)
        .map((s) => s.trim());
      if (cleaned.length === 0) {
        errors.push("supportedLanguages must contain at least one valid language code");
      } else {
        out.supported_languages = cleaned;
      }
    }
  } else if (!partial) {
    out.supported_languages = ["en"];
  }

  // Rate limits
  if (body.rateLimitBurst !== undefined || body.rate_limit_burst !== undefined) {
    const v = body.rateLimitBurst ?? body.rate_limit_burst;
    const n = typeof v === "number" ? v : parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 10000) {
      errors.push("rateLimitBurst must be 1..10000");
    } else {
      out.rate_limit_burst = Math.trunc(n);
    }
  } else if (!partial) {
    out.rate_limit_burst = 30;
  }

  if (body.rateLimitSustained !== undefined || body.rate_limit_sustained !== undefined) {
    const v = body.rateLimitSustained ?? body.rate_limit_sustained;
    const n = typeof v === "number" ? v : parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      errors.push("rateLimitSustained must be 1..100000");
    } else {
      out.rate_limit_sustained = Math.trunc(n);
    }
  } else if (!partial) {
    out.rate_limit_sustained = 500;
  }

  if (body.maxUploadSizeMb !== undefined || body.max_upload_size_mb !== undefined) {
    const v = body.maxUploadSizeMb ?? body.max_upload_size_mb;
    const n = typeof v === "number" ? v : parseInt(v, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100) {
      errors.push("maxUploadSizeMb must be 1..100");
    } else {
      out.max_upload_size_mb = Math.trunc(n);
    }
  } else if (!partial) {
    out.max_upload_size_mb = 20;
  }

  // AI config preset link
  if (body.aiConfigId !== undefined || body.ai_config_id !== undefined) {
    const v = body.aiConfigId ?? body.ai_config_id;
    if (v !== null && v !== undefined) {
      const n = typeof v === "number" ? v : parseInt(v, 10);
      if (!Number.isFinite(n) || n <= 0) {
        errors.push("aiConfigId must be a positive integer or null");
      } else {
        out.ai_config_id = n;
      }
    } else {
      out.ai_config_id = null;
    }
  }

  if (errors.length > 0) {
    return { ok: false, error: errors.join("; ") };
  }
  return { ok: true, value: out };
}

// Generate the 22-char base64url secret token.
function generateSecretToken() {
  return crypto.randomBytes(16).toString("base64url");
}

// Multer config for knowledge base uploads.
const upload = multer({
  dest: process.env.AI_ASSISTANT_UPLOAD_DIR || path.join(os.tmpdir(), "ai-assistant-uploads"),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB hard cap; per-assistant limit enforced below
  fileFilter(_req, file, cb) {
    const allowedExts = new Set([".txt", ".md", ".pdf", ".docx", ".csv"]);
    const allowedMimes = new Set([
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream", // fallback for generic binary
    ]);
    const ext = "." + file.originalname.split(".").pop().toLowerCase();
    const mimeOk = !file.mimetype || allowedMimes.has(file.mimetype);
    const extOk = allowedExts.has(ext);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      const reason = !extOk ? `Unsupported extension: ${ext}` : `Unsupported MIME type: ${file.mimetype}`;
      cb(new Error(`${reason}. Allowed: ${[...allowedExts].join(", ")}`));
    }
  },
});

// Select columns for config queries (avoids SELECT * for forward-compat).
const CONFIG_COLUMNS = `c.id, c.project_id, p.name AS project_name,
  c.name, c.secret_token, c.status,
  c.ai_config_id, c.model, c.base_url, c.base_prompt,
  c.display_name, c.primary_color, c.secondary_color,
  c.greeting_message, c.legal_message, c.avatar_url, c.position,
  c.default_language, c.supported_languages,
  c.allowed_origins, c.rate_limit_burst,
  c.rate_limit_sustained, c.max_upload_size_mb,
  c.created_at, c.updated_at`;

// ---------------------------------------------------------------------------
// GET /api/ai-assistant — paginated list of ai_assistant_configs
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(
    100,
    Math.max(1, parseInt(req.query.size ?? "10", 10) || 10),
  );
  const sortField = req.query.sortField || "createdAt";
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
  const searchFilter = buildWhereClause(queries, filterType, allocator);

  const scopedProjectIds = await getScopedProjectIds(req);
  const enduserScope =
    scopedProjectIds === null || scopedProjectIds === undefined
      ? { sql: "", params: [] }
      : appendProjectScope({
          placeholderIndex: allocator.next(),
          projectIds: scopedProjectIds,
          tableAlias: "c",
        });
  const enduserScopeSql = enduserScope.sql
    ? enduserScope.sql.replace(/^\s*AND\b/i, "")
    : "";

  const allConditions = [projectFilter.sql, searchFilter.sql, enduserScopeSql].filter(Boolean);
  const whereSql =
    allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
  const whereParams = [
    ...projectFilter.params,
    ...searchFilter.params,
    ...enduserScope.params,
  ];

  const order = buildOrderClause(sortField, sortOrder);
  const offset = page * size;
  const limitPh = allocator.next();
  const offsetPh = allocator.next();

  try {
    const countSql = `SELECT COUNT(*)::int AS total
                      FROM ai_assistant_configs c
                      JOIN projects p ON p.id = c.project_id
                      ${whereSql}`;
    const countResult = await pool.query(countSql, whereParams);
    const totalElements = countResult.rows[0].total;

    const dataSqlFinal = `SELECT ${CONFIG_COLUMNS}
                           FROM ai_assistant_configs c
                           JOIN projects p ON p.id = c.project_id
                           ${whereSql}
                           ${order}
                           LIMIT ${limitPh} OFFSET ${offsetPh}`;

    const dataResult = await pool.query(dataSqlFinal, [
      ...whereParams,
      size,
      offset,
    ]);

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    const rows = dataResult.rows.map(rowToConfigDTO);
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
    console.error("[ai-assistant/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/by-project/:projectId
// Lazy upsert: returns the existing config for the project, or creates one
// with sensible defaults if none exists.
// ---------------------------------------------------------------------------
router.get("/by-project/:projectId", async (req, res) => {
  const projectId = parseInt(req.params.projectId, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid project id" });
  }
  if (isEnduser(req)) {
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(projectId)
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }
  try {
    const projectCheck = await pool.query(
      `SELECT id, name FROM projects WHERE id = $1`,
      [projectId],
    );
    if (projectCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Project not found" });
    }
    const projectName = projectCheck.rows[0].name;
    const secretToken = generateSecretToken();
    const insertResult = await pool.query(
      `INSERT INTO ai_assistant_configs (project_id, name, secret_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id) DO NOTHING
       RETURNING id, project_id, name, secret_token, status,
                 ai_config_id, model, base_url, base_prompt,
                 display_name, primary_color, secondary_color,
                 greeting_message, avatar_url, position,
                 default_language, supported_languages,
                 allowed_origins, rate_limit_burst,
                 rate_limit_sustained, max_upload_size_mb,
                 created_at, updated_at`,
      [projectId, projectName, secretToken],
    );
    let row;
    if (insertResult.rowCount > 0) {
      row = { ...insertResult.rows[0], project_name: projectName };
    } else {
      const { rows } = await pool.query(
        `SELECT ${CONFIG_COLUMNS}
         FROM ai_assistant_configs c
         JOIN projects p ON p.id = c.project_id
         WHERE c.project_id = $1`,
        [projectId],
      );
      row = rows[0];
    }
    return res.json({ ...rowToConfigDTO(row), projectName });
  } catch (err) {
    if (err.code === "23505") {
      try {
        const { rows } = await pool.query(
          `SELECT ${CONFIG_COLUMNS}
           FROM ai_assistant_configs c
           JOIN projects p ON p.id = c.project_id
           WHERE c.project_id = $1`,
          [projectId],
        );
        if (rows.length > 0) return res.json(rowToConfigDTO(rows[0]));
      } catch (e2) {
        console.error("[ai-assistant/by-project] re-read", e2.code, e2.message);
      }
      return res.status(409).json({ errorMessage: "Conflict, please retry" });
    }
    console.error("[ai-assistant/by-project]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id
// Returns config with translations included.
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT ${CONFIG_COLUMNS}
       FROM ai_assistant_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const dto = rowToConfigDTO(rows[0]);

    const { rows: translations } = await pool.query(
      `SELECT id, assistant_id, language, display_name, greeting_message, placeholder,
              created_at, updated_at
       FROM ai_assistant_translations
       WHERE assistant_id = $1
       ORDER BY language ASC`,
      [id],
    );
    dto.translations = translations.map((t) => ({
      id: Number(t.id),
      assistantId: Number(t.assistant_id),
      language: t.language,
      displayName: t.display_name ?? null,
      greetingMessage: t.greeting_message ?? null,
      placeholder: t.placeholder ?? null,
      createdAt: new Date(t.created_at).toISOString(),
      updatedAt: new Date(t.updated_at).toISOString(),
    }));

    return res.json(dto);
  } catch (err) {
    console.error("[ai-assistant/get]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/ai-assistant/:id
// Update config including translations array. Uses a transaction.
// Translations: delete rows with _delete: true, update rows with an id,
// insert new rows without an id.
// ---------------------------------------------------------------------------
router.put("/:id", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  const { translations, ...configBody } = req.body;
  const validation = validateConfigBody(configBody, { partial: true });
  if (!validation.ok) {
    return res.status(400).json({ errorMessage: validation.error });
  }
  const v = validation.value;
  const hasTranslations = Array.isArray(translations);

  if (Object.keys(v).length === 0 && !hasTranslations) {
    return res.status(400).json({ errorMessage: "No updatable fields provided" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Update config fields (if any)
    if (Object.keys(v).length > 0) {
      const setClauses = [];
      const params = [id];
      let p = 2;
      for (const [col, val] of Object.entries(v)) {
        setClauses.push(`${col} = $${p}`);
        params.push(val);
        p++;
      }
      setClauses.push("updated_at = now()");

      const sql = `UPDATE ai_assistant_configs
                   SET ${setClauses.join(", ")}
                   WHERE id = $1
                   RETURNING id`;
      const { rowCount } = await client.query(sql, params);
      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ errorMessage: "AI assistant config not found" });
      }
    }

    // Handle translations array (if provided)
    if (hasTranslations) {
      // 1. Delete rows marked with _delete: true
      const toDelete = translations
        .filter((t) => t._delete === true && t.id)
        .map((t) => Number(t.id));
      if (toDelete.length > 0) {
        await client.query(
          `DELETE FROM ai_assistant_translations WHERE id = ANY($1::bigint[]) AND assistant_id = $2`,
          [toDelete, id],
        );
      }

      // 2. Update rows with an id (that aren't marked for deletion)
      const toUpdate = translations.filter((t) => t.id && !t._delete);
      for (const t of toUpdate) {
        await client.query(
          `UPDATE ai_assistant_translations
           SET display_name = $1, greeting_message = $2, placeholder = $3, language = $4, updated_at = NOW()
           WHERE id = $5 AND assistant_id = $6`,
          [
            t.displayName ?? t.display_name ?? null,
            t.greetingMessage ?? t.greeting_message ?? null,
            t.placeholder ?? null,
            t.language,
            Number(t.id),
            id,
          ],
        );
      }

      // 3. Insert new rows without an id
      const toInsert = translations.filter((t) => !t.id && !t._delete && t.language);
      for (const t of toInsert) {
        await client.query(
          `INSERT INTO ai_assistant_translations
             (assistant_id, language, display_name, greeting_message, placeholder)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (assistant_id, language) DO UPDATE SET
             display_name = EXCLUDED.display_name,
             greeting_message = EXCLUDED.greeting_message,
             placeholder = EXCLUDED.placeholder,
             updated_at = NOW()`,
          [
            id,
            t.language,
            t.displayName ?? t.display_name ?? null,
            t.greetingMessage ?? t.greeting_message ?? null,
            t.placeholder ?? null,
          ],
        );
      }
    }

    await client.query("COMMIT");

    // Re-read the full config with translations for the response.
    const { rows: joined } = await pool.query(
      `SELECT ${CONFIG_COLUMNS}
       FROM ai_assistant_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1`,
      [id],
    );
    if (joined.length === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const dto = rowToConfigDTO(joined[0]);

    const { rows: tr } = await pool.query(
      `SELECT id, assistant_id, language, display_name, greeting_message, placeholder,
              created_at, updated_at
       FROM ai_assistant_translations
       WHERE assistant_id = $1
       ORDER BY language ASC`,
      [id],
    );
    dto.translations = tr.map((t) => ({
      id: Number(t.id),
      assistantId: Number(t.assistant_id),
      language: t.language,
      displayName: t.display_name ?? null,
      greetingMessage: t.greeting_message ?? null,
      placeholder: t.placeholder ?? null,
      createdAt: new Date(t.created_at).toISOString(),
      updatedAt: new Date(t.updated_at).toISOString(),
    }));

    return res.json(dto);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23514") {
      return res.status(400).json({ errorMessage: "Invalid field value" });
    }
    console.error("[ai-assistant/update]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ai-assistant/:id
// Hard delete. CASCADE wipes translations, knowledge base, chunks, sessions,
// and messages.
// ---------------------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[ai-assistant/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id/snippet
// Returns the generated <script> tag for embedding the AI assistant widget.
// ---------------------------------------------------------------------------
router.get("/:id/snippet", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT name, secret_token, default_language, allowed_origins
       FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const config = rows[0];
    const origin =
      process.env.APP_PUBLIC_URL ||
      `${req.protocol}://${req.headers.host}`;
    const scriptUrl = `${origin}/api/public/ai-assistant/${config.secret_token}/script.js`;
    const defaultLanguage = config.default_language || "en";
    const snippet = [
      `<!-- AI Assistant "${config.name}" -->`,
      `<script src="${scriptUrl}" data-lang="${defaultLanguage}" defer></script>`,
    ].join("\n");
    return res.json({
      html: snippet,
      scriptUrl,
      secretToken: config.secret_token,
      defaultLanguage,
      origin,
      allowedOrigins: Array.isArray(config.allowed_origins)
        ? config.allowed_origins.filter((s) => typeof s === "string")
        : [],
    });
  } catch (err) {
    console.error("[ai-assistant/snippet]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id/knowledge
// List knowledge base documents for this assistant.
// ---------------------------------------------------------------------------
router.get("/:id/knowledge", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }
  try {
    const configCheck = await pool.query(
      `SELECT id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (configCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const { rows } = await pool.query(
      `SELECT id, assistant_id, filename, original_filename, file_type,
              file_size_bytes, status, error_message, chunk_count,
              created_at, updated_at
       FROM ai_knowledge_base
       WHERE assistant_id = $1
       ORDER BY created_at DESC`,
      [id],
    );
    return res.json(
      rows.map((r) => ({
        id: Number(r.id),
        assistantId: Number(r.assistant_id),
        filename: r.filename,
        originalFilename: r.original_filename,
        fileType: r.file_type,
        fileSizeBytes: Number(r.file_size_bytes),
        status: r.status,
        errorMessage: r.error_message ?? null,
        chunkCount: Number(r.chunk_count),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
    );
  } catch (err) {
    console.error("[ai-assistant/knowledge-list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai-assistant/:id/knowledge
// Upload a document for the RAG knowledge base. Uses multer for multipart.
// ---------------------------------------------------------------------------
router.post("/:id/knowledge", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  // Verify assistant exists and get upload limits.
  let maxUploadSizeMb = 20;
  try {
    const { rows } = await pool.query(
      `SELECT id, max_upload_size_mb FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    maxUploadSizeMb = Number(rows[0].max_upload_size_mb) || 20;
  } catch (err) {
    console.error("[ai-assistant/knowledge-upload/check]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Run multer via middleware-style call.
  const multerUpload = upload.single("file");
  try {
    await new Promise((resolve, reject) => {
      multerUpload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ errorMessage: `Upload error: ${err.message}` });
    }
    return res.status(400).json({ errorMessage: err.message || "Upload failed" });
  }

  if (!req.file) {
    return res.status(400).json({ errorMessage: "No file provided" });
  }

  // Validate file size against per-assistant limit.
  const sizeBytes = req.file.size;
  const maxSizeBytes = maxUploadSizeMb * 1024 * 1024;
  if (sizeBytes > maxSizeBytes) {
    const fs = await import("node:fs/promises");
    await fs.unlink(req.file.path).catch(() => {});
    return res.status(400).json({
      errorMessage: `File too large. Maximum size is ${maxUploadSizeMb} MB`,
    });
  }

  const fileType = "." + req.file.originalname.split(".").pop().toLowerCase();
  const filename = `${id}_${Date.now()}_${req.file.originalname}`;

  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_knowledge_base
         (assistant_id, filename, original_filename, file_type, file_size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'processing')
       RETURNING id, assistant_id, filename, original_filename, file_type,
                 file_size_bytes, status, error_message, chunk_count,
                 created_at, updated_at`,
      [id, filename, req.file.originalname, fileType, sizeBytes],
    );
    const doc = rows[0];

    // Fire-and-forget: process the document in the background.
    processDocument({
      documentId: Number(doc.id),
      assistantId: id,
      filePath: req.file.path,
      fileType,
    }).catch((err) => {
      console.error("[ai-assistant/knowledge-upload/process]", err.message);
    });

    return res.status(201).json({
      id: Number(doc.id),
      assistantId: Number(doc.assistant_id),
      filename: doc.filename,
      originalFilename: doc.original_filename,
      fileType: doc.file_type,
      fileSizeBytes: Number(doc.file_size_bytes),
      status: doc.status,
      errorMessage: doc.error_message ?? null,
      chunkCount: Number(doc.chunk_count),
      createdAt: new Date(doc.created_at).toISOString(),
      updatedAt: new Date(doc.updated_at).toISOString(),
    });
  } catch (err) {
    console.error("[ai-assistant/knowledge-upload]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id/knowledge/:docId/chunks
// List chunks for a specific knowledge base document.
// ---------------------------------------------------------------------------
router.get("/:id/knowledge/:docId/chunks", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid document id" });
  }

  try {
    // Verify the document belongs to this assistant.
    const { rows: docs } = await pool.query(
      `SELECT id, original_filename, file_type, chunk_count, status
       FROM ai_knowledge_base
       WHERE id = $1 AND assistant_id = $2`,
      [docId, id],
    );
    if (docs.length === 0) {
      return res.status(404).json({ errorMessage: "Document not found" });
    }

    const { rows: chunks } = await pool.query(
      `SELECT id, chunk_index, content, token_count, created_at
       FROM ai_knowledge_chunks
       WHERE document_id = $1 AND assistant_id = $2
       ORDER BY chunk_index ASC`,
      [docId, id],
    );

    return res.json({
      document: {
        id: Number(docs[0].id),
        originalFilename: docs[0].original_filename,
        fileType: docs[0].file_type,
        chunkCount: Number(docs[0].chunk_count),
        status: docs[0].status,
      },
      chunks: chunks.map((c) => ({
        id: Number(c.id),
        chunkIndex: c.chunk_index,
        content: c.content,
        tokenCount: c.token_count,
        createdAt: new Date(c.created_at).toISOString(),
      })),
    });
  } catch (err) {
    console.error("[ai-assistant/knowledge-chunks]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/ai-assistant/:id/knowledge/:docId
// Delete a knowledge base document and its chunks (CASCADE).
// ---------------------------------------------------------------------------
router.delete("/:id/knowledge/:docId", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;

  const id = parseInt(req.params.id, 10);
  const docId = parseInt(req.params.docId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(docId) || docId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid document id" });
  }

  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ai_knowledge_base WHERE id = $1 AND assistant_id = $2`,
      [docId, id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Document not found" });
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[ai-assistant/knowledge-delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ai-assistant/:id/avatar
// Upload a custom avatar image for the chat widget.
// ---------------------------------------------------------------------------
const AVATAR_UPLOAD_DIR = process.env.AI_ASSISTANT_AVATAR_DIR || "/app/uploads/ai-assistant-avatars";

const avatarUpload = multer({
  dest: AVATAR_UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max for avatar
  fileFilter(_req, file, cb) {
    const allowed = new Set(["image/webp", "image/png", "image/jpeg", "image/avif"]);
    const allowedExt = new Set([".webp", ".png", ".jpg", ".jpeg", ".avif"]);
    const ext = "." + file.originalname.split(".").pop().toLowerCase();
    const mimeOk = !file.mimetype || allowed.has(file.mimetype);
    const extOk = allowedExt.has(ext);
    if (extOk && mimeOk) {
      cb(null, true);
    } else {
      cb(new Error("Unsupported image type. Allowed: webp, png, jpg, avif"));
    }
  },
});

router.post("/:id/avatar", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  const avatarMulterUpload = avatarUpload.single("file");
  try {
    await new Promise((resolve, reject) => {
      avatarMulterUpload(req, res, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (err) {
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ errorMessage: `Upload error: ${err.message}` });
    }
    return res.status(400).json({ errorMessage: err.message || "Upload failed" });
  }

  if (!req.file) {
    return res.status(400).json({ errorMessage: "No file provided" });
  }

  // Verify assistant exists
  try {
    const { rowCount } = await pool.query(
      `SELECT id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      const fs2 = await import("node:fs/promises");
      await fs2.unlink(req.file.path).catch(() => {});
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
  } catch (err) {
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  // Rename file to a stable name and build the URL
  const ext = "." + req.file.originalname.split(".").pop().toLowerCase();
  const storedName = `assistant_${id}_avatar${ext}`;
  const storedPath = path.join(AVATAR_UPLOAD_DIR, storedName);
  const fs3 = await import("node:fs/promises");

  try {
    await fs3.mkdir(AVATAR_UPLOAD_DIR, { recursive: true });
    await fs3.rename(req.file.path, storedPath);
  } catch {
    try {
      await fs3.copyFile(req.file.path, storedPath);
      await fs3.unlink(req.file.path).catch(() => {});
    } catch (moveErr) {
      console.error("[ai-assistant/avatar] file move error:", moveErr.message);
      return res.status(500).json({ errorMessage: "Failed to store avatar file" });
    }
  }

  const appUrl = process.env.APP_PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
  const avatarUrl = `${appUrl}/uploads/ai-assistant-avatars/${storedName}`;

  try {
    await pool.query(
      `UPDATE ai_assistant_configs SET avatar_url = $1, updated_at = NOW() WHERE id = $2`,
      [avatarUrl, id],
    );
  } catch (err) {
    console.error("[ai-assistant/avatar] db update:", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }

  return res.json({ avatarUrl });
});

// ---------------------------------------------------------------------------
// DELETE /api/ai-assistant/:id/avatar
// Remove the custom avatar image.
// ---------------------------------------------------------------------------
router.delete("/:id/avatar", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;

  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  try {
    const { rows, rowCount } = await pool.query(
      `SELECT avatar_url FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }

    const avatarUrl = rows[0].avatar_url;
    if (avatarUrl) {
      const filename = avatarUrl.split("/").pop();
      const filePath = path.join(AVATAR_UPLOAD_DIR, filename);
      const fs4 = await import("node:fs/promises");
      await fs4.unlink(filePath).catch(() => {});
    }

    await pool.query(
      `UPDATE ai_assistant_configs SET avatar_url = NULL, updated_at = NOW() WHERE id = $1`,
      [id],
    );
    return res.status(204).send();
  } catch (err) {
    console.error("[ai-assistant/avatar-delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id/sessions
// Paged list of chat sessions for this assistant.
// ---------------------------------------------------------------------------
router.get("/:id/sessions", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }
  const page = Math.max(0, parseInt(req.query.page ?? "0", 10) || 0);
  const size = Math.min(
    100,
    Math.max(1, parseInt(req.query.size ?? "20", 10) || 20),
  );
  const offset = page * size;

  // Search: ?queries=["keyword"] — searches session fields AND message content
  let searchClauses = "";
  const searchValues = [];
  const queries = Array.isArray(req.query.queries)
    ? req.query.queries.filter((q) => typeof q === "string" && q.trim())
    : typeof req.query.queries === "string" && req.query.queries.trim()
      ? [req.query.queries.trim()]
      : [];
  if (queries.length > 0) {
    const likeParts = [];
    for (const q of queries) {
      searchValues.push(`%${q}%`);
      const p = `$${searchValues.length + 1}`;
      likeParts.push(
        `(s.session_id ILIKE ${p} OR s.visitor_id ILIKE ${p} OR s.language ILIKE ${p} OR s.ip_address::text ILIKE ${p} OR EXISTS (SELECT 1 FROM ai_chat_messages cm WHERE cm.session_id = s.id AND cm.content ILIKE ${p}))`
      );
    }
    searchClauses = " AND (" + likeParts.join(" OR ") + ")";
  }

  // Sort: ?sortField=createdAt&sortOrder=desc
  const allowedSortFields = { createdAt: "s.created_at", language: "s.language", sessionId: "s.session_id" };
  const sortField = allowedSortFields[req.query.sortField] || "s.created_at";
  const sortOrder = req.query.sortOrder === "asc" ? "ASC" : "DESC";

  try {
    const configCheck = await pool.query(
      `SELECT id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (configCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ai_chat_sessions s WHERE s.assistant_id = $1${searchClauses}`,
      [id, ...searchValues],
    );
    const totalElements = countResult.rows[0].total;

    const { rows } = await pool.query(
      `SELECT s.id, s.assistant_id, s.session_id, s.visitor_id, s.language,
              s.ip_address, s.user_agent, s.created_at, s.updated_at,
              COALESCE(m.cnt, 0)::int AS message_count
       FROM ai_chat_sessions s
       LEFT JOIN (
         SELECT session_id, COUNT(*)::int AS cnt
         FROM ai_chat_messages
         WHERE assistant_id = $1
         GROUP BY session_id
       ) m ON m.session_id = s.id
       WHERE s.assistant_id = $1${searchClauses}
       ORDER BY ${sortField} ${sortOrder}
       LIMIT $${searchValues.length + 2} OFFSET $${searchValues.length + 3}`,
      [id, ...searchValues, size, offset],
    );

    const totalPages = Math.max(1, Math.ceil(totalElements / size));
    return res.json({
      totalPages,
      totalElements,
      pageable: {
        paged: true,
        pageSize: size,
        pageNumber: page,
        unpaged: false,
        offset,
        sort: { sorted: true, unsorted: false, empty: false },
      },
      numberOfElements: rows.length,
      size,
      content: rows.map((r) => ({
        id: Number(r.id),
        assistantId: Number(r.assistant_id),
        sessionId: r.session_id,
        visitorId: r.visitor_id ?? null,
        language: r.language,
        ipAddress: r.ip_address ?? null,
        userAgent: r.user_agent ?? null,
        messageCount: r.message_count,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      })),
      number: page,
      sort: { sorted: true, unsorted: false, empty: false },
      first: page === 0,
      last: page === totalPages - 1,
      empty: rows.length === 0,
    });
  } catch (err) {
    console.error("[ai-assistant/sessions]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /api/ai-assistant/:id/sessions/:sessionId
// Get messages for a specific chat session.
// ---------------------------------------------------------------------------
router.get("/:id/sessions/:sessionId", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (isEnduser(req)) {
    const pre = await pool.query(
      `SELECT project_id FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (pre.rowCount === 0) {
      return res.status(404).json({ errorMessage: "AI assistant config not found" });
    }
    const allowed = Array.isArray(req.user.projectIds)
      ? req.user.projectIds.includes(Number(pre.rows[0].project_id))
      : false;
    if (!allowed) return res.status(404).json({ errorMessage: "AI assistant config not found" });
  }

  const sessionId = parseInt(req.params.sessionId, 10);
  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid session id" });
  }

  try {
    const sessionCheck = await pool.query(
      `SELECT id FROM ai_chat_sessions WHERE id = $1 AND assistant_id = $2`,
      [sessionId, id],
    );
    if (sessionCheck.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Session not found" });
    }

    const { rows } = await pool.query(
      `SELECT id, session_id, assistant_id, role, content, language,
              tokens_used, rag_sources, created_at
       FROM ai_chat_messages
       WHERE session_id = $1 AND assistant_id = $2
       ORDER BY created_at ASC`,
      [sessionId, id],
    );

    return res.json(
      rows.map((r) => ({
        id: Number(r.id),
        sessionId: Number(r.session_id),
        assistantId: Number(r.assistant_id),
        role: r.role,
        content: r.content,
        language: r.language,
        tokensUsed: Number(r.tokens_used),
        ragSources: r.rag_sources ?? null,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    );
  } catch (err) {
    console.error("[ai-assistant/session-messages]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
