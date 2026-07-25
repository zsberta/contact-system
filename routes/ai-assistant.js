// routes/ai-assistant.js
// Admin CRUD for AI assistant configs (sibling to routes/analytics.js).
// Mount at /api/ai-assistant via server.js.

import express from "express";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { getScopedProjectIds, appendProjectScope } from "../lib/scope.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduserMutation = (req, res) => {
  if (isEnduser(req)) {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  return null;
};

export const router = express.Router();
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Secret token generation — 22-char base64url = 16 random bytes (128 bits)
// ---------------------------------------------------------------------------
function generateSecretToken() {
  return crypto.randomBytes(16).toString("base64url");
}

// ---------------------------------------------------------------------------
// Origin allowlist validator (identical to analytics.js)
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS_MAX = 100;
const HOSTNAME_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const SCHEME_HOSTNAME_RE = /^https?:\/\/(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(:[0-9]{1,5})?$/;
const LOOPBACK_BARE = /^localhost(:[0-9]{1,5})?$/;
const LOOPBACK_IPV4 = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(:[0-9]{1,5})?$/;
const LOOPBACK_IPV6 = /^\[::1?\](:[0-9]{1,5})?$/;
const LOOPBACK_SCHEME = /^https?:\/\/(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1?\])(:[0-9]{1,5})?$/;

function validateAllowedOriginsEntry(entry, index, seen) {
  if (typeof entry !== "string") return `allowedOrigins[${index}]: must be a string`;
  const trimmed = entry.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > 253) return `allowedOrigins[${index}]: must be 1..253 chars`;
  const isBare = HOSTNAME_RE.test(trimmed);
  const isScheme = SCHEME_HOSTNAME_RE.test(trimmed);
  const isLoopbackBare = LOOPBACK_BARE.test(trimmed) || LOOPBACK_IPV4.test(trimmed) || LOOPBACK_IPV6.test(trimmed);
  const isLoopbackScheme = LOOPBACK_SCHEME.test(trimmed);
  if (!isBare && !isScheme && !isLoopbackBare && !isLoopbackScheme) {
    return `allowedOrigins[${index}]: invalid origin (${entry})`;
  }
  let normalised;
  if (isScheme || isLoopbackScheme) normalised = trimmed;
  else normalised = `https://${trimmed}`;
  if (seen.has(normalised)) return `allowedOrigins[${index}]: duplicate`;
  seen.add(normalised);
  return { ok: true, value: normalised };
}

// ---------------------------------------------------------------------------
// DTO mapping
// ---------------------------------------------------------------------------
function rowToConfigDTO(row) {
  if (!row) return null;
  let allowedOrigins = [];
  if (Array.isArray(row.allowed_origins)) {
    allowedOrigins = row.allowed_origins.filter((d) => typeof d === "string");
  } else if (typeof row.allowed_origins === "string" && row.allowed_origins.length > 0) {
    try { allowedOrigins = JSON.parse(row.allowed_origins); } catch { allowedOrigins = []; }
  }
  let supportedLanguages = [];
  if (Array.isArray(row.supported_languages)) {
    supportedLanguages = row.supported_languages.filter((d) => typeof d === "string");
  } else if (typeof row.supported_languages === "string" && row.supported_languages.length > 0) {
    try { supportedLanguages = JSON.parse(row.supported_languages); } catch { supportedLanguages = []; }
  }
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    projectName: row.project_name ?? null,
    name: row.name ?? "",
    secretToken: row.secret_token,
    status: row.status,
    aiConfigPresetId: row.ai_config_id ? Number(row.ai_config_id) : null,
    model: row.model,
    baseUrl: row.base_url,
    basePrompt: row.base_prompt,
    displayName: row.display_name,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    greetingMessage: row.greeting_message,
    avatarUrl: row.avatar_url,
    position: row.position,
    defaultLanguage: row.default_language,
    supportedLanguages,
    allowedOrigins,
    rateLimitBurst: row.rate_limit_burst,
    rateLimitSustained: row.rate_limit_sustained,
    maxUploadSizeMb: row.max_upload_size_mb,
    translations: [], // populated separately
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------
const SORTABLE = { id: "id", name: "name", status: "status", createdAt: "created_at", updatedAt: "updated_at" };
const SEARCH_COLUMNS = ["c.name"];

function makePlaceholderAllocator(startIndex = 1) {
  let n = startIndex;
  return { next: () => `$${n++}`, current: () => n - 1 };
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
  return { clauses: built.map((b) => b.sql), params: built.flatMap((b) => b.params), sql: built.map((b) => b.sql).join(conj) };
}

function buildOrderClause(sortField, sortOrder) {
  const col = SORTABLE[sortField] || "created_at";
  const dir = sortOrder === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${col} ${dir}, id DESC`;
}

function buildProjectFilterClause(projectId, allocator) {
  if (projectId === undefined || projectId === null) return { sql: "", params: [] };
  const n = typeof projectId === "number" ? projectId : parseInt(projectId, 10);
  if (!Number.isFinite(n) || n <= 0) return { sql: "", params: [] };
  return { sql: `c.project_id = ${allocator.next()}`, params: [n] };
}

// ---------------------------------------------------------------------------
// GET / — paged list
// ---------------------------------------------------------------------------
router.get("/", async (req, res) => {
  try {
    const projectIds = await getScopedProjectIds(req);
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));
    const sortField = req.query.sortField || "createdAt";
    const sortOrder = req.query.sortOrder || "desc";
    const queries = req.query.queries ? (Array.isArray(req.query.queries) ? req.query.queries : [req.query.queries]) : [];
    const filterType = req.query.filterType || "any";
    const projectId = req.query.projectId ? parseInt(req.query.projectId) : undefined;

    const allocator = makePlaceholderAllocator();
    const where = buildWhereClause(queries, filterType, allocator);
    const projectFilter = buildProjectFilterClause(projectId, allocator.current() + 1);
    const scope = appendProjectScope({ placeholderIndex: allocator.current() + 1, projectIds });

    const conditions = [];
    const params = [];
    if (where.sql) { conditions.push(where.sql); params.push(...where.params); }
    if (projectFilter.sql) { conditions.push(projectFilter.sql); params.push(...projectFilter.params); }
    if (scope.sql) { conditions.push(scope.sql); params.push(...scope.params); }

    const whereClause = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";
    const orderClause = buildOrderClause(sortField, sortOrder);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ai_assistant_configs c ${whereClause}`,
      params,
    );
    const totalElements = countResult.rows[0]?.total ?? 0;

    const dataResult = await pool.query(
      `SELECT c.*, p.name AS project_name
       FROM ai_assistant_configs c
       JOIN projects p ON p.id = c.project_id
       ${whereClause}
       ${orderClause}
       LIMIT ${size} OFFSET ${page * size}`,
      params,
    );

    res.json({
      content: dataResult.rows.map(rowToConfigDTO),
      totalElements,
      totalPages: Math.ceil(totalElements / size),
      page,
      size,
    });
  } catch (err) {
    console.error("[ai-assistant] list error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /by-project/:projectId — lazy create-or-return
// ---------------------------------------------------------------------------
router.get("/by-project/:projectId", async (req, res) => {
  if (forbidEnduserMutation(req, res)) return;
  try {
    const projectId = parseInt(req.params.projectId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid project ID" });
    }

    const existing = await pool.query(
      `SELECT c.*, p.name AS project_name
       FROM ai_assistant_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.project_id = $1`,
      [projectId],
    );
    if (existing.rowCount > 0) {
      const dto = rowToConfigDTO(existing.rows[0]);
      // Fetch translations
      const trans = await pool.query(
        `SELECT * FROM ai_assistant_translations WHERE assistant_id = $1`,
        [dto.id],
      );
      dto.translations = trans.rows.map((r) => ({
        id: Number(r.id),
        assistantId: Number(r.assistant_id),
        language: r.language,
        displayName: r.display_name,
        greetingMessage: r.greeting_message,
        placeholder: r.placeholder,
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      }));
      return res.json(dto);
    }

    // Lazy create
    const secretToken = generateSecretToken();
    const result = await pool.query(
      `INSERT INTO ai_assistant_configs (project_id, name, secret_token)
       VALUES ($1, $2, $3)
       RETURNING *, (SELECT name FROM projects WHERE id = $1) AS project_name`,
      [projectId, "AI Assistant", secretToken],
    );
    const dto = rowToConfigDTO(result.rows[0]);
    dto.translations = [];
    res.status(201).json(dto);
  } catch (err) {
    console.error("[ai-assistant] by-project error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id — single config with translations
// ---------------------------------------------------------------------------
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });

    const projectIds = await getScopedProjectIds(req);
    let scopeClause = "";
    let params = [id];
    if (projectIds !== null) {
      scopeClause = `AND c.project_id = ANY($2::bigint[])`;
      params.push(projectIds);
    }

    const result = await pool.query(
      `SELECT c.*, p.name AS project_name
       FROM ai_assistant_configs c
       JOIN projects p ON p.id = c.project_id
       WHERE c.id = $1 ${scopeClause}`,
      params,
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });

    const dto = rowToConfigDTO(result.rows[0]);
    const trans = await pool.query(
      `SELECT * FROM ai_assistant_translations WHERE assistant_id = $1`,
      [dto.id],
    );
    dto.translations = trans.rows.map((r) => ({
      id: Number(r.id),
      assistantId: Number(r.assistant_id),
      language: r.language,
      displayName: r.display_name,
      greetingMessage: r.greeting_message,
      placeholder: r.placeholder,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
    res.json(dto);
  } catch (err) {
    console.error("[ai-assistant] get error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /:id — update config + translations
// ---------------------------------------------------------------------------
router.put("/:id", async (req, res) => {
  if (forbidEnduserMutation(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });

    const body = req.body;
    const sets = [];
    const params = [];
    let idx = 1;

    if (body.name !== undefined) { sets.push(`name = $${idx++}`); params.push(String(body.name).trim()); }
    if (body.model !== undefined) { sets.push(`model = $${idx++}`); params.push(String(body.model).trim()); }
    if (body.baseUrl !== undefined) { sets.push(`base_url = $${idx++}`); params.push(String(body.baseUrl).trim()); }
    if (body.apiKey !== undefined && body.apiKey !== "") { sets.push(`api_key_enc = $${idx++}`); params.push(String(body.apiKey)); }
    if (body.basePrompt !== undefined) { sets.push(`base_prompt = $${idx++}`); params.push(String(body.basePrompt)); }
    if (body.displayName !== undefined) { sets.push(`display_name = $${idx++}`); params.push(String(body.displayName)); }
    if (body.primaryColor !== undefined) { sets.push(`primary_color = $${idx++}`); params.push(String(body.primaryColor)); }
    if (body.secondaryColor !== undefined) { sets.push(`secondary_color = $${idx++}`); params.push(String(body.secondaryColor)); }
    if (body.greetingMessage !== undefined) { sets.push(`greeting_message = $${idx++}`); params.push(String(body.greetingMessage)); }
    if (body.avatarUrl !== undefined) { sets.push(`avatar_url = $${idx++}`); params.push(body.avatarUrl || null); }
    if (body.position !== undefined) { sets.push(`position = $${idx++}`); params.push(String(body.position)); }
    if (body.defaultLanguage !== undefined) { sets.push(`default_language = $${idx++}`); params.push(String(body.defaultLanguage)); }
    if (body.supportedLanguages !== undefined) { sets.push(`supported_languages = $${idx++}`); params.push(body.supportedLanguages); }
    if (body.status !== undefined) { sets.push(`status = $${idx++}`); params.push(String(body.status)); }
    if (body.rateLimitBurst !== undefined) { sets.push(`rate_limit_burst = $${idx++}`); params.push(parseInt(body.rateLimitBurst) || 30); }
    if (body.rateLimitSustained !== undefined) { sets.push(`rate_limit_sustained = $${idx++}`); params.push(parseInt(body.rateLimitSustained) || 500); }
    if (body.maxUploadSizeMb !== undefined) { sets.push(`max_upload_size_mb = $${idx++}`); params.push(parseInt(body.maxUploadSizeMb) || 20); }
    if (body.aiConfigPresetId !== undefined) { sets.push(`ai_config_id = $${idx++}`); params.push(body.aiConfigPresetId || null); }

    // Allowed origins
    if (body.allowedOrigins !== undefined) {
      const cleaned = Array.isArray(body.allowedOrigins) ? body.allowedOrigins : [];
      const seen = new Set();
      const valid = [];
      for (let i = 0; i < cleaned.length; i++) {
        const result = validateAllowedOriginsEntry(cleaned[i], i, seen);
        if (result.ok) valid.push(result.value);
      }
      if (cleaned.length > ALLOWED_ORIGINS_MAX) {
        return res.status(400).json({ errorMessage: `Max ${ALLOWED_ORIGINS_MAX} origins allowed` });
      }
      sets.push(`allowed_origins = $${idx++}`); params.push(valid);
    }

    if (sets.length === 0 && !body.translations) {
      return res.status(400).json({ errorMessage: "No fields to update" });
    }

    // Use transaction for config + translations
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      if (sets.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE ai_assistant_configs SET ${sets.join(", ")} WHERE id = $${idx}`,
          params,
        );
      }

      // Handle translations
      if (Array.isArray(body.translations)) {
        for (const t of body.translations) {
          if (t._delete && t.id) {
            await client.query(`DELETE FROM ai_assistant_translations WHERE id = $1 AND assistant_id = $2`, [t.id, id]);
          } else if (t.id) {
            await client.query(
              `UPDATE ai_assistant_translations SET display_name = $1, greeting_message = $2, placeholder = $3 WHERE id = $4 AND assistant_id = $5`,
              [t.displayName || null, t.greetingMessage || null, t.placeholder || null, t.id, id],
            );
          } else if (t.language) {
            await client.query(
              `INSERT INTO ai_assistant_translations (assistant_id, language, display_name, greeting_message, placeholder)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (assistant_id, language) DO UPDATE SET display_name = $3, greeting_message = $4, placeholder = $5`,
              [id, t.language, t.displayName || null, t.greetingMessage || null, t.placeholder || null],
            );
          }
        }
      }

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    // Return updated config
    const result = await pool.query(
      `SELECT c.*, p.name AS project_name FROM ai_assistant_configs c JOIN projects p ON p.id = c.project_id WHERE c.id = $1`,
      [id],
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });

    const dto = rowToConfigDTO(result.rows[0]);
    const trans = await pool.query(`SELECT * FROM ai_assistant_translations WHERE assistant_id = $1`, [id]);
    dto.translations = trans.rows.map((r) => ({
      id: Number(r.id), assistantId: Number(r.assistant_id), language: r.language,
      displayName: r.display_name, greetingMessage: r.greeting_message, placeholder: r.placeholder,
      createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    }));
    res.json(dto);
  } catch (err) {
    console.error("[ai-assistant] update error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id
// ---------------------------------------------------------------------------
router.delete("/:id", async (req, res) => {
  if (forbidEnduserMutation(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(`DELETE FROM ai_assistant_configs WHERE id = $1`, [id]);
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    res.status(204).end();
  } catch (err) {
    console.error("[ai-assistant] delete error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/snippet — render embed snippet
// ---------------------------------------------------------------------------
router.get("/:id/snippet", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });

    const result = await pool.query(
      `SELECT secret_token, default_language, allowed_origins FROM ai_assistant_configs WHERE id = $1`,
      [id],
    );
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });

    const row = result.rows[0];
    const appUrl = process.env.APP_PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
    const scriptUrl = `${appUrl}/api/public/ai-assistant/${row.secret_token}/script.js`;
    const html = `<script src="${scriptUrl}" data-lang="${row.default_language}" defer></script>`;

    let allowedOrigins = [];
    if (Array.isArray(row.allowed_origins)) allowedOrigins = row.allowed_origins;
    else if (typeof row.allowed_origins === "string" && row.allowed_origins.length > 0) {
      try { allowedOrigins = JSON.parse(row.allowed_origins); } catch { allowedOrigins = []; }
    }

    res.json({ html, scriptUrl, secretToken: row.secret_token, origin: appUrl, defaultLanguage: row.default_language, allowedOrigins });
  } catch (err) {
    console.error("[ai-assistant] snippet error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/knowledge — list knowledge base documents
// ---------------------------------------------------------------------------
router.get("/:id/knowledge", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(
      `SELECT * FROM ai_knowledge_base WHERE assistant_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    res.json(result.rows.map((r) => ({
      id: Number(r.id), assistantId: Number(r.assistant_id), filename: r.filename,
      originalFilename: r.original_filename, fileType: r.file_type,
      fileSizeBytes: Number(r.file_size_bytes), status: r.status,
      errorMessage: r.error_message, chunkCount: r.chunk_count,
      createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    })));
  } catch (err) {
    console.error("[ai-assistant] knowledge list error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /:id/knowledge — upload document (multipart/form-data)
// ---------------------------------------------------------------------------
router.post("/:id/knowledge", async (req, res) => {
  if (forbidEnduserMutation(req, res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });

    // Check assistant exists and get upload limit
    const configResult = await pool.query(`SELECT max_upload_size_mb FROM ai_assistant_configs WHERE id = $1`, [id]);
    if (configResult.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    const maxUploadMb = configResult.rows[0].max_upload_size_mb || 20;

    // Manual multipart parsing (avoids express-fileupload dependency for now)
    // The FE sends FormData with a single "file" field
    if (!req.files || !req.files.file) {
      return res.status(400).json({ errorMessage: "No file uploaded" });
    }

    const file = req.files.file;
    const maxSize = maxUploadMb * 1024 * 1024;
    if (file.size > maxSize) {
      return res.status(400).json({ errorMessage: `File exceeds max size of ${maxUploadMb}MB` });
    }

    const ALLOWED_TYPES = new Set([".pdf", ".txt", ".md", ".docx", ".csv"]);
    const ext = "." + file.name.split(".").pop().toLowerCase();
    if (!ALLOWED_TYPES.has(ext)) {
      return res.status(400).json({ errorMessage: "Unsupported file type" });
    }

    // Store file
    const uploadsDir = path.join(__dirname, "..", "uploads", "ai-knowledge", String(id));
    await fs.mkdir(uploadsDir, { recursive: true });
    const storedName = `${crypto.randomBytes(8).toString("hex")}${ext}`;
    const filePath = path.join(uploadsDir, storedName);
    await file.mv(filePath);

    // Insert record
    const insertResult = await pool.query(
      `INSERT INTO ai_knowledge_base (assistant_id, filename, original_filename, file_type, file_size_bytes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, storedName, file.name, ext.slice(1), file.size],
    );
    const doc = insertResult.rows[0];

    // Process asynchronously (don't await — fire and forget)
    const { processDocument } = await import("../lib/ai-knowledge-processor.js");
    processDocument({
      documentId: Number(doc.id),
      assistantId: id,
      filePath,
      fileType: ext.slice(1),
    }).catch((err) => {
      console.error("[ai-assistant] document processing error:", err.message);
    });

    res.status(201).json({
      id: Number(doc.id), assistantId: Number(doc.assistant_id), filename: doc.filename,
      originalFilename: doc.original_filename, fileType: doc.file_type,
      fileSizeBytes: Number(doc.file_size_bytes), status: doc.status,
      errorMessage: doc.error_message, chunkCount: doc.chunk_count,
      createdAt: new Date(doc.created_at).toISOString(), updatedAt: new Date(doc.updated_at).toISOString(),
    });
  } catch (err) {
    console.error("[ai-assistant] knowledge upload error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /:id/knowledge/:docId — delete document + chunks
// ---------------------------------------------------------------------------
router.delete("/:id/knowledge/:docId", async (req, res) => {
  if (forbidEnduserMutation(req, res)) return;
  try {
    const docId = parseInt(req.params.docId, 10);
    if (!Number.isFinite(docId) || docId <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(`DELETE FROM ai_knowledge_base WHERE id = $1`, [docId]);
    if (result.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });
    res.status(204).end();
  } catch (err) {
    console.error("[ai-assistant] knowledge delete error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/sessions — paged chat sessions
// ---------------------------------------------------------------------------
router.get("/:id/sessions", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size) || 20));

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM ai_chat_sessions WHERE assistant_id = $1`, [id],
    );
    const totalElements = countResult.rows[0]?.total ?? 0;

    const result = await pool.query(
      `SELECT s.*, (SELECT COUNT(*)::int FROM ai_chat_messages WHERE session_id = s.id) AS message_count
       FROM ai_chat_sessions s
       WHERE s.assistant_id = $1
       ORDER BY s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [id, size, page * size],
    );

    res.json({
      content: result.rows.map((r) => ({
        id: Number(r.id), assistantId: Number(r.assistant_id), sessionId: r.session_id,
        visitorId: r.visitor_id, language: r.language, messageCount: r.message_count,
        createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
      })),
      totalElements, totalPages: Math.ceil(totalElements / size), page, size,
    });
  } catch (err) {
    console.error("[ai-assistant] sessions error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /:id/sessions/:sessionId — messages for a session
// ---------------------------------------------------------------------------
router.get("/:id/sessions/:sessionId", async (req, res) => {
  try {
    const sessionId = parseInt(req.params.sessionId, 10);
    if (!Number.isFinite(sessionId) || sessionId <= 0) return res.status(404).json({ errorMessage: "Not found" });
    const result = await pool.query(
      `SELECT * FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    res.json(result.rows.map((r) => ({
      id: Number(r.id), sessionId: Number(r.session_id), role: r.role, content: r.content,
      language: r.language, tokensUsed: r.tokens_used, ragSources: r.rag_sources,
      createdAt: new Date(r.created_at).toISOString(),
    })));
  } catch (err) {
    console.error("[ai-assistant] messages error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});
