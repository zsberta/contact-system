#!/usr/bin/env node
// lib/ai-knowledge-worker.js
//
// Standalone child process for document processing.
// Spawned by ai-knowledge-processor.js via child_process.fork().
// Communicates results back via IPC (process.send).

import fs from "node:fs/promises";
import { Pool } from "pg";

// ---------------------------------------------------------------------------
// DB pool — isolated from the main server pool so we can't exhaust it.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  max: 2, // minimal — this worker handles one doc at a time
});

// Chunking parameters
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------
async function extractText(filePath, fileType) {
  if (TEXT_EXTENSIONS.has(fileType)) {
    return await fs.readFile(filePath, "utf-8");
  }
  if (fileType === ".pdf") {
    const { default: pdfParse } = await import("pdf-parse");
    const buffer = await fs.readFile(filePath);
    const result = await pdfParse(buffer);
    return result.text || "";
  }
  if (fileType === ".docx") {
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }
  throw new Error(`Unsupported file type: ${fileType}`);
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------
function chunkText(text) {
  if (!text || text.length === 0) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const window = text.slice(Math.max(start, end - 200), end);
      const lastNewline = window.lastIndexOf("\n");
      const lastPeriod = window.lastIndexOf(". ");
      const breakPoint = Math.max(lastNewline, lastPeriod);
      if (breakPoint > 50) {
        end = Math.max(start, end - 200) + breakPoint + 1;
      }
    }
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------
async function generateEmbeddings({ baseUrl, apiKey, chunks, model }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
  const batchSize = 20;
  const allEmbeddings = [];

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, input: batch }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Embeddings API error ${response.status}: ${errorText.slice(0, 500)}`);
    }
    const result = await response.json();
    for (const item of result.data) {
      allEmbeddings.push(item.embedding);
    }
  }
  return allEmbeddings;
}

// ---------------------------------------------------------------------------
// pgvector detection
// ---------------------------------------------------------------------------
let _hasPgvector = null;
async function hasPgvector() {
  if (_hasPgvector !== null) return _hasPgvector;
  try {
    const { rows } = await pool.query("SELECT 1 FROM pg_type WHERE typname = 'vector'");
    _hasPgvector = rows.length > 0;
  } catch {
    _hasPgvector = false;
  }
  return _hasPgvector;
}

// ---------------------------------------------------------------------------
// Main processing — runs in response to IPC message from parent
// ---------------------------------------------------------------------------
async function processDocument({ documentId, assistantId, filePath, fileType }) {
  let status = "error";
  let errorMessage = null;
  let chunkCount = 0;

  try {
    // 1. Extract text
    const text = await extractText(filePath, fileType);
    if (!text || text.trim().length === 0) {
      throw new Error("Document contains no extractable text");
    }

    // 2. Chunk
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      throw new Error("Document produced no chunks after processing");
    }

    // 3. Get embedding credentials (prefer env vars, fall back to assistant config)
    let baseUrl = process.env.AI_EMBEDDING_BASE_URL || "";
    let apiKey = process.env.AI_EMBEDDING_API_KEY || "";
    const embeddingModel = process.env.AI_EMBEDDING_MODEL || "text-embedding-3-small";

    if (!baseUrl || !apiKey) {
      const { rows } = await pool.query(
        `SELECT base_url, api_key_enc FROM ai_assistant_configs WHERE id = $1`,
        [assistantId],
      );
      if (rows.length === 0) throw new Error(`Assistant config ${assistantId} not found`);
      if (!baseUrl) baseUrl = rows[0].base_url;
      if (!apiKey) apiKey = rows[0].api_key_enc;
    }
    if (!apiKey) {
      throw new Error("No API key configured for embeddings");
    }

    // 4. Generate embeddings (the slow part — DB connection is NOT held during this)
    const embeddings = await generateEmbeddings({ baseUrl, apiKey, chunks, model: embeddingModel });
    if (embeddings.length !== chunks.length) {
      throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`);
    }

    // 5. Insert chunks + embeddings in a transaction (quick — grab + release)
    const vectorAvailable = await hasPgvector();
    const insertSql = vectorAvailable
      ? `INSERT INTO ai_knowledge_chunks
           (document_id, assistant_id, chunk_index, content, embedding, token_count)
         VALUES ($1, $2, $3, $4, $5::vector, $6)`
      : `INSERT INTO ai_knowledge_chunks
           (document_id, assistant_id, chunk_index, content, embedding, token_count)
         VALUES ($1, $2, $3, $4, $5, $6)`;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < chunks.length; i++) {
        const embeddingLiteral = `[${embeddings[i].join(",")}]`;
        const tokenCount = Math.ceil(chunks[i].length / 4);
        await client.query(insertSql, [documentId, assistantId, i, chunks[i], embeddingLiteral, tokenCount]);
      }
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    chunkCount = chunks.length;
    status = "ready";
  } catch (err) {
    console.error("[ai-knowledge-worker]", err.message);
    errorMessage = err.message.slice(0, 1000);
    status = "error";
  }

  // Update the document record
  try {
    await pool.query(
      `UPDATE ai_knowledge_base
       SET status = $1, error_message = $2, chunk_count = $3, updated_at = NOW()
       WHERE id = $4`,
      [status, errorMessage, chunkCount, documentId],
    );
  } catch (updateErr) {
    console.error("[ai-knowledge-worker] failed to update status:", updateErr.message);
  }

  // Clean up temp file
  try {
    await fs.unlink(filePath);
  } catch {}

  // Notify parent
  if (process.send) {
    process.send({ documentId, status, chunkCount, errorMessage });
  }

  // Shut down cleanly
  await pool.end();
  process.exit(0);
}

// Listen for work from parent
process.on("message", (msg) => {
  if (msg && msg.documentId) {
    processDocument(msg).catch((err) => {
      console.error("[ai-knowledge-worker] fatal:", err.message);
      process.exit(1);
    });
  }
});
