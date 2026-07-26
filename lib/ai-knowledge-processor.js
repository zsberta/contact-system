// lib/ai-knowledge-processor.js
//
// =============================================================================
// Document processing pipeline for the AI assistant RAG knowledge base.
//
// Extracts text from uploaded documents (txt, md, pdf, docx, csv), splits
// them into chunks (~500 tokens / ~2000 chars with 200 char overlap),
// generates embeddings via the OpenAI embeddings API, and inserts the
// chunks + embeddings into ai_knowledge_chunks.
// =============================================================================

import fs from "node:fs/promises";
import { pool } from "../db/pool.js";

// Chunking parameters. ~2000 chars is roughly 500 tokens for English text.
const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

// pgvector detection (cached after first check)
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

// Supported file types -> extractors
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".csv"]);

/**
 * Extract text content from a document based on its file type.
 *
 * @param {string} filePath - Absolute path to the file on disk
 * @param {string} fileType - Normalized extension (e.g. ".txt", ".pdf")
 * @returns {Promise<string>} Extracted plain text
 */
async function extractText(filePath, fileType) {
  if (TEXT_EXTENSIONS.has(fileType)) {
    return await fs.readFile(filePath, "utf-8");
  }

  if (fileType === ".pdf") {
    // Dynamic import: pdf-parse is an optional dependency. If not installed,
    // the caller should have a fallback or the error will propagate.
    const pdfParse = (await import("pdf-parse")).default;
    const buffer = await fs.readFile(filePath);
    const result = await pdfParse(buffer);
    return result.text || "";
  }

  if (fileType === ".docx") {
    // Dynamic import: mammoth converts .docx to plain text.
    const mammoth = await import("mammoth");
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  throw new Error(`Unsupported file type: ${fileType}`);
}

/**
 * Split text into overlapping chunks.
 *
 * @param {string} text - Full document text
 * @returns {string[]} Array of text chunks
 */
function chunkText(text) {
  if (!text || text.length === 0) return [];
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    // Try to break at a sentence or paragraph boundary for cleaner chunks.
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

/**
 * Generate embeddings for an array of text chunks via the OpenAI-compatible
 * embeddings API.
 *
 * @param {object} opts
 * @param {string}   opts.baseUrl - API base URL
 * @param {string}   opts.apiKey  - API key
 * @param {string[]} opts.chunks  - Array of text chunks
 * @returns {Promise<number[][]>} Array of 1536-dim embedding vectors
 */
async function generateEmbeddings({ baseUrl, apiKey, chunks, model }) {
  const url = `${baseUrl.replace(/\/+$/, "")}/embeddings`;
  const EMBEDDING_MODEL = model || "text-embedding-3-small";

  // Process in batches of 20 to avoid payload size limits.
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
        body: JSON.stringify({
          model: EMBEDDING_MODEL,
          input: batch,
        }),
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
    // OpenAI returns data sorted by index, matching our input order.
    for (const item of result.data) {
      allEmbeddings.push(item.embedding);
    }
  }

  return allEmbeddings;
}

/**
 * Process an uploaded document: extract text, chunk, embed, and store.
 *
 * This function is designed to be called asynchronously after the upload
 * handler inserts the ai_knowledge_base row with status='processing'.
 * On success it updates status to 'ready'; on failure to 'error'.
 *
 * @param {object} opts
 * @param {number} opts.documentId  - ai_knowledge_base row ID
 * @param {number} opts.assistantId - ai_assistant_configs row ID
 * @param {string} opts.filePath    - Absolute path to the uploaded file
 * @param {string} opts.fileType    - Normalized extension (e.g. ".txt")
 */
export async function processDocument({ documentId, assistantId, filePath, fileType }) {
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

    // 3. Get assistant API credentials for embedding generation.
    //    Prefer dedicated AI_EMBEDDING_* env vars; fall back to assistant config.
    const embeddingBaseUrl = process.env.AI_EMBEDDING_BASE_URL || "";
    const embeddingApiKey = process.env.AI_EMBEDDING_API_KEY || "";
    const embeddingModel = process.env.AI_EMBEDDING_MODEL || "text-embedding-3-small";

    let baseUrl = embeddingBaseUrl;
    let apiKey = embeddingApiKey;

    if (!baseUrl || !apiKey) {
      // Fall back to the assistant's own config
      const { rows: configRows } = await pool.query(
        `SELECT base_url, api_key_enc FROM ai_assistant_configs WHERE id = $1`,
        [assistantId],
      );
      if (configRows.length === 0) {
        throw new Error(`Assistant config ${assistantId} not found`);
      }
      if (!baseUrl) baseUrl = configRows[0].base_url;
      if (!apiKey) apiKey = configRows[0].api_key_enc;
    }

    if (!apiKey) {
      throw new Error("No API key configured for embeddings (set AI_EMBEDDING_API_KEY or configure the assistant)");
    }

    // 4. Generate embeddings
    const embeddings = await generateEmbeddings({ baseUrl, apiKey, chunks, model: embeddingModel });
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch: expected ${chunks.length}, got ${embeddings.length}`,
      );
    }

    // 5. Insert chunks + embeddings in a transaction.
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
        // Rough token estimate: ~4 chars per token for English text.
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
    console.error("[ai-knowledge-processor]", err.message);
    errorMessage = err.message.slice(0, 1000);
    status = "error";
  }

  // 6. Update the document record with the processing result.
  try {
    await pool.query(
      `UPDATE ai_knowledge_base
       SET status = $1, error_message = $2, chunk_count = $3, updated_at = NOW()
       WHERE id = $4`,
      [status, errorMessage, chunkCount, documentId],
    );
  } catch (updateErr) {
    console.error("[ai-knowledge-processor] failed to update document status:", updateErr.message);
  }

  // 7. Clean up the temp file.
  try {
    await fs.unlink(filePath);
  } catch {
    // Best-effort cleanup. The file may already have been deleted.
  }
}
