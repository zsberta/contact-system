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
import { fork } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "ai-knowledge-worker.js");

/**
 * Process an uploaded document in a detached child process.
 *
 * The worker has its own DB pool (max: 2) and runs independently.
 * The main server's pool is never touched during processing.
 *
 * @param {object} opts
 * @param {number} opts.documentId  - ai_knowledge_base row ID
 * @param {number} opts.assistantId - ai_assistant_configs row ID
 * @param {string} opts.filePath    - Absolute path to the uploaded file
 * @param {string} opts.fileType    - Normalized extension (e.g. ".txt")
 */
export function processDocument({ documentId, assistantId, filePath, fileType }) {
  return new Promise((resolve, reject) => {
    const child = fork(WORKER_PATH, [], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    let resolved = false;

    child.on("message", (msg) => {
      if (!resolved) {
        resolved = true;
        resolve(msg);
      }
    });

    child.on("error", (err) => {
      console.error("[ai-knowledge-processor] worker error:", err.message);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    child.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        if (code === 0) {
          resolve({ documentId, status: "ready" });
        } else {
          reject(new Error(`Worker exited with code ${code}`));
        }
      }
    });

    // Send work to the child
    child.send({ documentId, assistantId, filePath, fileType });
  });
}
