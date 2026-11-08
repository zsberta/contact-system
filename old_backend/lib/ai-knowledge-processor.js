// lib/ai-knowledge-processor.js
//
// =============================================================================
// Document processing launcher for the AI assistant RAG knowledge base.
//
// Spawns a detached child process (ai-knowledge-worker.js) so that the slow
// embedding API calls never block the main Express server or exhaust its
// connection pool.
// =============================================================================

import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "ai-knowledge-worker.js");

/**
 * Process an uploaded document in a detached child process.
 *
 * The worker has its own DB pool (max: 2) and runs independently.
 * The main server's pool is never touched during processing.
 * The worker updates the document status in the DB directly.
 *
 * @param {object} opts
 * @param {number} opts.documentId  - ai_knowledge_base row ID
 * @param {number} opts.assistantId - ai_assistant_configs row ID
 * @param {string} opts.filePath    - Absolute path to the uploaded file
 * @param {string} opts.fileType    - Normalized extension (e.g. ".txt")
 */
export function processDocument({ documentId, assistantId, filePath, fileType }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER_PATH, String(documentId), String(assistantId), filePath, fileType], {
      env: { ...process.env },
      stdio: "ignore",
      detached: true,
    });

    // Unref so the parent process doesn't wait for the child
    child.unref();

    // Resolve immediately — the worker runs independently
    // and updates the DB status on its own.
    resolve({ documentId, status: "processing" });

    child.on("error", (err) => {
      console.error("[ai-knowledge-processor] worker spawn error:", err.message);
    });
  });
}
