// routes/ai-assistant-embed.js
// Public embed endpoints for the AI Assistant module.
// Mounted at /api/public/ai-assistant via server.js.

import express from "express";
import rateLimit from "express-rate-limit";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { pool } from "../db/pool.js";
import { streamChat } from "../lib/ai-llm-client.js";
import { searchKnowledgeBase } from "../lib/vector-search.js";
import { decrypt } from "../lib/ai-encryption.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const router = express.Router();

// Parse text/plain for SSE compatibility
router.use(express.text({ type: "text/plain", limit: "10kb" }));
router.use((req, res, next) => {
  if (typeof req.body === "string" && req.body.length > 0) {
    try { req.body = JSON.parse(req.body); } catch {
      return res.status(400).json({ errorMessage: "Invalid JSON body" });
    }
  } else {
    req.body = req.body || {};
  }
  next();
});

// Rate limiters
const burstLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: parseInt(process.env.PUBLIC_AI_ASSISTANT_BURST_LIMIT || "30", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests, please try again later" },
  keyGenerator: (req) => `ai-burst:${req.ip}`,
});

const sustainedLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: parseInt(process.env.PUBLIC_AI_ASSISTANT_SUSTAINED_LIMIT || "500", 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { errorMessage: "Too many requests, please try again later" },
  keyGenerator: (req) => `ai-sustained:${req.ip}`,
});

// ---------------------------------------------------------------------------
// Origin-allowlist matcher — same algorithm as routes/analytics-embed.js
// (byte-for-byte identical to the one in routes/form-embed.js). The
// duplication is deliberate: each route validates independently.
// ---------------------------------------------------------------------------
function isOriginAllowed(requestOrigin, allowedOrigins) {
  if (typeof requestOrigin !== "string" || requestOrigin.length === 0) {
    return false;
  }
  const hasScheme = /^https?:\/\//i.test(requestOrigin);
  const urlish = hasScheme ? requestOrigin : `http://${requestOrigin}`;
  let req;
  try {
    const u = new URL(urlish);
    req = u.host.toLowerCase();
  } catch {
    req = requestOrigin
      .replace(/\/$/, "")
      .replace(/^https?:\/\//i, "")
      .toLowerCase();
  }
  for (let i = 0; i < allowedOrigins.length; i++) {
    const entry = allowedOrigins[i];
    if (typeof entry !== "string") return false;
    const e = entry.replace(/\/$/, "").toLowerCase();
    const entryHasScheme = /^https?:\/\//i.test(e);
    const eUrlish = entryHasScheme ? e : `http://${e}`;
    let entryHost;
    try {
      const eu = new URL(eUrlish);
      entryHost = eu.host.toLowerCase();
    } catch {
      entryHost = e.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
    }
    if (entryHost === req) return true;
    if (e.indexOf("*.") !== -1) {
      const starIdx = e.indexOf("*.");
      const suffix = e.slice(starIdx + 2);
      const suffixHost = suffix.replace(/^https?:\/\//i, "").split(":")[0];
      const reqHost = req.split(":")[0];
      if (reqHost === suffixHost) continue; // apex — wildcard does NOT match
      if (reqHost.length > suffixHost.length && reqHost.endsWith("." + suffixHost)) {
        return true;
      }
    }
  }
  return false;
}

function parseOrigins(row) {
  if (Array.isArray(row.allowed_origins)) return row.allowed_origins.filter((d) => typeof d === "string");
  if (typeof row.allowed_origins === "string" && row.allowed_origins.length > 0) {
    try { return JSON.parse(row.allowed_origins); } catch { return []; }
  }
  return [];
}

function parseTranslations(row) {
  if (Array.isArray(row.translations_data)) return row.translations_data;
  if (typeof row.translations_data === "string" && row.translations_data.length > 0) {
    try { return JSON.parse(row.translations_data); } catch { return []; }
  }
  return [];
}

// ---------------------------------------------------------------------------
// Helper: decrypt API key using AES-256-GCM (via shared encryption module)
// ---------------------------------------------------------------------------
function decryptApiKey(enc) {
  if (!enc) return null;
  return decrypt(enc);
}

// ---------------------------------------------------------------------------
// GET /:secret_token/script.js — serve the widget JS with placeholders replaced
// ---------------------------------------------------------------------------
router.get("/:secret_token/script.js", async (req, res) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const { secret_token: secretToken } = req.params;
  if (typeof secretToken !== "string" || secretToken.length !== 22) {
    return res.status(404).type("text/javascript").send("// not found");
  }

  try {
    const result = await pool.query(
      `SELECT id, status FROM ai_assistant_configs WHERE secret_token = $1`,
      [secretToken],
    );
    if (result.rowCount === 0 || result.rows[0].status !== "active") {
      return res.status(404).type("text/javascript").send("// not found");
    }
  } catch {
    return res.status(404).type("text/javascript").send("// not found");
  }

  try {
    const widgetPath = path.join(__dirname, "..", "public", "ai-assistant-widget.js");
    let script = await fs.readFile(widgetPath, "utf-8");

    // Fetch config for placeholder replacement
    const configResult = await pool.query(
      `SELECT c.display_name, c.primary_color, c.secondary_color, c.default_language,
              c.greeting_message, c.position, c.avatar_url, c.supported_languages,
              (SELECT COALESCE(json_agg(json_build_object(
                'language', t.language,
                'displayName', t.display_name,
                'greetingMessage', t.greeting_message,
                'placeholder', t.placeholder
              )), '[]'::json) FROM ai_assistant_translations t WHERE t.assistant_id = c.id) AS translations_data
       FROM ai_assistant_configs c WHERE c.secret_token = $1`,
      [secretToken],
    );
    const cfg = configResult.rows[0];
    const appUrl = process.env.APP_PUBLIC_URL || `${req.protocol}://${req.headers.host}`;

    let supportedLanguages = ["en"];
    if (Array.isArray(cfg.supported_languages)) supportedLanguages = cfg.supported_languages;
    else if (typeof cfg.supported_languages === "string" && cfg.supported_languages.length > 0) {
      try { supportedLanguages = JSON.parse(cfg.supported_languages); } catch { supportedLanguages = ["en"]; }
    }

    const translations = parseTranslations(cfg);

    script = script.replace(/\{\{SECRET_TOKEN\}\}/g, secretToken);
    script = script.replace(/\{\{BASE_URL\}\}/g, appUrl);
    script = script.replace(/\{\{DEFAULT_LANGUAGE\}\}/g, cfg.default_language || "en");
    script = script.replace(/\{\{DISPLAY_NAME\}\}/g, cfg.display_name || "AI Assistant");
    script = script.replace(/\{\{PRIMARY_COLOR\}\}/g, cfg.primary_color || "#3b82f6");
    script = script.replace(/\{\{SECONDARY_COLOR\}\}/g, cfg.secondary_color || "#ffffff");
    script = script.replace(/\{\{GREETING_MESSAGE\}\}/g, cfg.greeting_message || "Hello! How can I help you today?");
    script = script.replace(/\{\{POSITION\}\}/g, cfg.position || "bottom-right");
    script = script.replace(/\{\{AVATAR_URL\}\}/g, cfg.avatar_url || "");
    script = script.replace(/\{\{SUPPORTED_LANGUAGES\}\}/g, JSON.stringify(supportedLanguages));
    script = script.replace(/\{\{TRANSLATIONS\}\}/g, JSON.stringify(translations));

    res.setHeader("Content-Type", "text/javascript");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(script);
  } catch (err) {
    console.error("[ai-assistant-embed] script error:", err.message);
    res.status(500).type("text/javascript").send("// error");
  }
});

// ---------------------------------------------------------------------------
// GET /:secret_token/config — lightweight config for the widget
// ---------------------------------------------------------------------------
router.get("/:secret_token/config", async (req, res) => {
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  const { secret_token: secretToken } = req.params;
  if (typeof secretToken !== "string" || secretToken.length !== 22) {
    return res.status(404).json({ errorMessage: "Not found" });
  }

  try {
    const result = await pool.query(
      `SELECT c.*, (SELECT COALESCE(json_agg(json_build_object(
        'language', t.language,
        'displayName', t.display_name,
        'greetingMessage', t.greeting_message,
        'placeholder', t.placeholder
      )), '[]'::json) FROM ai_assistant_translations t WHERE t.assistant_id = c.id) AS translations_data
       FROM ai_assistant_configs c WHERE c.secret_token = $1 AND c.status = 'active'`,
      [secretToken],
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Not found" });
    }

    const row = result.rows[0];
    let supportedLanguages = ["en"];
    if (Array.isArray(row.supported_languages)) supportedLanguages = row.supported_languages;
    else if (typeof row.supported_languages === "string" && row.supported_languages.length > 0) {
      try { supportedLanguages = JSON.parse(row.supported_languages); } catch { supportedLanguages = ["en"]; }
    }

    res.json({
      displayName: row.display_name,
      primaryColor: row.primary_color,
      secondaryColor: row.secondary_color,
      defaultLanguage: row.default_language,
      supportedLanguages,
      translations: parseTranslations(row),
      greetingMessage: row.greeting_message,
      position: row.position,
      avatarUrl: row.avatar_url,
    });
  } catch (err) {
    console.error("[ai-assistant-embed] config error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /:secret_token/chat — send message, get AI response (SSE stream)
// ---------------------------------------------------------------------------
router.post("/:secret_token/chat", burstLimiter, sustainedLimiter, async (req, res) => {
  const { secret_token: secretToken } = req.params;
  if (typeof secretToken !== "string" || secretToken.length !== 22) {
    return res.status(404).json({ errorMessage: "Not found" });
  }

  const body = req.body;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length === 0 || message.length > 2000) {
    return res.status(400).json({ errorMessage: "Message must be 1..2000 characters" });
  }

  try {
    // Validate config
    const configResult = await pool.query(
      `SELECT id, status, base_prompt, model, base_url, api_key_enc,
              default_language, allowed_origins
       FROM ai_assistant_configs WHERE secret_token = $1`,
      [secretToken],
    );
    if (configResult.rowCount === 0 || configResult.rows[0].status !== "active") {
      return res.status(404).json({ errorMessage: "Not found" });
    }

    const config = configResult.rows[0];
    const assistantId = Number(config.id);

    // Origin check
    const allowedOrigins = parseOrigins(config);
    if (allowedOrigins.length > 0 && !isOriginAllowed(req.headers.origin, allowedOrigins)) {
      return res.status(404).json({ errorMessage: "Not found" });
    }

    // Resolve or create session
    const lang = typeof body.lang === "string" && body.lang.length >= 2 && body.lang.length <= 10
      ? body.lang.slice(0, 10) : config.default_language || "en";
    let sessionId = null;

    if (body.sessionId && typeof body.sessionId === "string") {
      const sessionResult = await pool.query(
        `SELECT id FROM ai_chat_sessions WHERE session_id = $1 AND assistant_id = $2`,
        [body.sessionId, assistantId],
      );
      if (sessionResult.rowCount > 0) {
        sessionId = sessionResult.rows[0].id;
        // Update language
        await pool.query(`UPDATE ai_chat_sessions SET language = $1 WHERE id = $2`, [lang, sessionId]);
      }
    }

    if (!sessionId) {
      const newSessionId = body.sessionId || (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const sessionResult = await pool.query(
        `INSERT INTO ai_chat_sessions (assistant_id, session_id, visitor_id, language, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [assistantId, newSessionId, null, lang, req.ip, (req.headers["user-agent"] || "").slice(0, 500)],
      );
      sessionId = sessionResult.rows[0].id;
    }

    // Store user message
    await pool.query(
      `INSERT INTO ai_chat_messages (session_id, assistant_id, role, content, language)
       VALUES ($1, $2, 'user', $3, $4)`,
      [sessionId, assistantId, message, lang],
    );

    // Fetch conversation history (last 20 messages)
    const historyResult = await pool.query(
      `SELECT role, content FROM ai_chat_messages WHERE session_id = $1 ORDER BY created_at ASC`,
      [sessionId],
    );
    const history = historyResult.rows.slice(-20);

    // RAG retrieval (language-agnostic)
    let ragContext = "";
    let ragSources = [];
    try {
      const apiKey = decryptApiKey(config.api_key_enc);
      const baseUrl = config.base_url;
      if (apiKey) {
        // Embed the query
        const embedRes = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
          body: JSON.stringify({ model: "text-embedding-3-small", input: message }),
        });
        if (embedRes.ok) {
          const embedData = await embedRes.json();
          const embedding = embedData.data?.[0]?.embedding;
          if (embedding) {
            const chunks = await searchKnowledgeBase({ assistantId, queryEmbedding: embedding, topK: 5 });
            if (chunks.length > 0) {
              ragContext = "\n\nRelevant knowledge base context:\n" + chunks.map((c, i) => `[${i + 1}] ${c.content}`).join("\n\n");
              ragSources = chunks.map((c) => ({ documentId: c.documentId, chunkContent: c.content.slice(0, 200) }));
            }
          }
        }
      }
    } catch (ragErr) {
      console.error("[ai-assistant-embed] RAG error:", ragErr.message);
    }

    // Build messages array for LLM
    const systemPrompt = config.base_prompt + `\n\nRespond in ${lang}.` + ragContext;
    const llmMessages = [
      { role: "system", content: systemPrompt },
      ...history.map((m) => ({ role: m.role === "system" ? "user" : m.role, content: m.content })),
    ];

    // SSE response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Session-Id", body.sessionId || "");
    res.flushHeaders();

    // Heartbeat every 15s to prevent proxy/browser timeouts
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch {}
    }, 15_000);

    let fullText = "";
    let tokensUsed = 0;

    const apiKey = decryptApiKey(config.api_key_enc);
    const baseUrl = config.base_url;

    if (!apiKey) {
      clearInterval(heartbeat);
      res.write(`data: ${JSON.stringify({ content: "AI configuration is not properly set up.", sessionId: body.sessionId })}\n\n`);
      res.write(`data: [DONE]\n\n`);
      return res.end();
    }

    await streamChat({
      baseUrl,
      apiKey,
      model: config.model,
      messages: llmMessages,
      timeoutMs: 30_000,
      onChunk: (text) => {
        fullText += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      },
      onDone: async (usage) => {
        clearInterval(heartbeat);
        tokensUsed = usage?.total_tokens || 0;
        // Store assistant message
        await pool.query(
          `INSERT INTO ai_chat_messages (session_id, assistant_id, role, content, language, tokens_used, rag_sources)
           VALUES ($1, $2, 'assistant', $3, $4, $5, $6)`,
          [sessionId, assistantId, fullText, lang, tokensUsed, JSON.stringify(ragSources.length > 0 ? ragSources : null)],
        );
        res.write(`data: ${JSON.stringify({ sessionId: body.sessionId, done: true })}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
      },
      onError: (err) => {
        clearInterval(heartbeat);
        console.error("[ai-assistant-embed] LLM error:", err.message);
        res.write(`data: ${JSON.stringify({ content: "Sorry, something went wrong. Please try again." })}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
      },
    });
  } catch (err) {
    console.error("[ai-assistant-embed] chat error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ errorMessage: "Internal server error" });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /:secret_token/language — switch session language
// ---------------------------------------------------------------------------
router.post("/:secret_token/language", async (req, res) => {
  const { secret_token: secretToken } = req.params;
  if (typeof secretToken !== "string" || secretToken.length !== 22) {
    return res.status(404).json({ errorMessage: "Not found" });
  }

  const body = req.body;
  if (!body.sessionId || !body.lang) {
    return res.status(400).json({ errorMessage: "sessionId and lang are required" });
  }

  try {
    const configResult = await pool.query(
      `SELECT id, supported_languages, default_language FROM ai_assistant_configs WHERE secret_token = $1 AND status = 'active'`,
      [secretToken],
    );
    if (configResult.rowCount === 0) return res.status(404).json({ errorMessage: "Not found" });

    const config = configResult.rows[0];
    let supportedLanguages = ["en"];
    if (Array.isArray(config.supported_languages)) supportedLanguages = config.supported_languages;
    else if (typeof config.supported_languages === "string" && config.supported_languages.length > 0) {
      try { supportedLanguages = JSON.parse(config.supported_languages); } catch { supportedLanguages = ["en"]; }
    }

    const lang = supportedLanguages.includes(body.lang) ? body.lang : config.default_language;

    await pool.query(
      `UPDATE ai_chat_sessions SET language = $1 WHERE session_id = $2 AND assistant_id = $3`,
      [lang, body.sessionId, Number(config.id)],
    );

    res.json({ ok: true, language: lang });
  } catch (err) {
    console.error("[ai-assistant-embed] language error:", err.message);
    res.status(500).json({ errorMessage: "Internal server error" });
  }
});
