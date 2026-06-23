import express from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";

export const router = express.Router();
router.use(requireAuth);

// All routes require a valid JWT — CSRF is enforced globally for non-GET elsewhere.
// We declare requireAuth on each handler (mirrors the users route pattern) to make
// the contract obvious at the call site.
const UPLOAD_ROOT = process.env.UPLOADS_DIR || "/app/uploads";
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

// Whitelist of sniffed mime types we accept. We deliberately do NOT trust the
// client's Content-Type header — file-type sniffs the first ~4KB of the buffer.
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function rowToAttachmentDTO(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    paymentId: Number(row.payment_id),
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    uploadedAt: new Date(row.uploaded_at).toISOString(),
  };
}

// Multer error handler for the upload route. Translates known errors into the
// project's standard { errorMessage } shape.
function handleMulterError(err, _req, res, next) {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ errorMessage: "File too large" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ errorMessage: err.message });
  }
  return next(err);
}

// ---- GET /api/payments/:paymentId/attachments ----
router.get("/:paymentId/attachments", async (req, res) => {
  const paymentId = parseInt(req.params.paymentId, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  try {
    // Verify the payment exists so we can return a clean 404 instead of [].
    const pay = await pool.query(`SELECT id FROM payments WHERE id = $1`, [paymentId]);
    if (pay.rowCount === 0) {
      return res.status(404).json({ errorMessage: "Payment not found" });
    }
    const { rows } = await pool.query(
      `SELECT id, payment_id, original_filename, stored_filename, mime_type,
              size_bytes, uploaded_at
       FROM payment_attachments WHERE payment_id = $1
       ORDER BY uploaded_at DESC, id DESC`,
      [paymentId],
    );
    return res.json(rows.map(rowToAttachmentDTO));
  } catch (err) {
    console.error("[payments/attachments/list]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- POST /api/payments/:paymentId/attachments ----
// Multipart upload. Field name is "file". 100 MB hard cap. We sniff the
// actual mime (file-type) — never trust req.file.mimetype.
router.post(
  "/:paymentId/attachments",
  (req, res, next) => {
    const paymentId = parseInt(req.params.paymentId, 10);
    if (!Number.isFinite(paymentId) || paymentId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    req._paymentId = paymentId;
    next();
  },
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) return handleMulterError(err, req, res, next);
      next();
    });
  },
  async (req, res) => {
    const paymentId = req._paymentId;
    if (!req.file) {
      return res.status(400).json({ errorMessage: "No file uploaded" });
    }

    // Sniff the real mime from the buffer. fileTypeFromBuffer returns
    // undefined when it can't determine a type — treat that as unknown/reject.
    let sniff;
    try {
      sniff = await fileTypeFromBuffer(req.file.buffer);
    } catch (e) {
      console.error("[payments/attachments/upload] sniff failed", e.message);
      sniff = null;
    }
    const sniffedMime = sniff?.mime ?? null;
    if (!sniffedMime || !ALLOWED_MIME.has(sniffedMime)) {
      return res.status(400).json({ errorMessage: "File type not allowed" });
    }

    // Verify the payment exists before we drop a file on disk.
    try {
      const pay = await pool.query(`SELECT id FROM payments WHERE id = $1`, [paymentId]);
      if (pay.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Payment not found" });
      }
    } catch (err) {
      console.error("[payments/attachments/upload] payment lookup", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }

    const ext = path.extname(req.file.originalname || "");
    const stored = `${crypto.randomUUID()}${ext}`;
    const paymentDir = path.join(UPLOAD_ROOT, "payments", String(paymentId));
    const fullPath = path.join(paymentDir, stored);

    try {
      await fsp.mkdir(paymentDir, { recursive: true });
      await fsp.writeFile(fullPath, req.file.buffer);
    } catch (err) {
      console.error("[payments/attachments/upload] write failed", err.message);
      return res.status(500).json({ errorMessage: "Failed to store file" });
    }

    try {
      const { rows } = await pool.query(
        `INSERT INTO payment_attachments
          (payment_id, original_filename, stored_filename, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, payment_id, original_filename, stored_filename, mime_type,
                   size_bytes, uploaded_at`,
        [
          paymentId,
          req.file.originalname,
          stored,
          sniffedMime,
          req.file.size,
        ],
      );
      return res.status(201).json(rowToAttachmentDTO(rows[0]));
    } catch (err) {
      // Roll back the disk write if the DB insert fails so we don't leak orphans.
      try {
        await fsp.unlink(fullPath);
      } catch {
        /* ignore */
      }
      console.error("[payments/attachments/upload] db insert", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }
  },
);

// ---- GET /api/payments/:paymentId/attachments/:attId/download ----
router.get("/:paymentId/attachments/:attId/download", async (req, res) => {
  const paymentId = parseInt(req.params.paymentId, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(attId) || attId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid attachment id" });
  }
  try {
    const { rows } = await pool.query(
      `SELECT original_filename, stored_filename, mime_type
       FROM payment_attachments
       WHERE id = $1 AND payment_id = $2`,
      [attId, paymentId],
    );
    if (rows.length === 0) {
      return res.status(404).json({ errorMessage: "Attachment not found" });
    }
    const att = rows[0];
    const fullPath = path.join(UPLOAD_ROOT, "payments", String(paymentId), att.stored_filename);

    // Use async stat instead of createReadStream's auto-handling so we can
    // distinguish ENOENT (file vanished) from a stream error.
    try {
      await fsp.access(fullPath);
    } catch {
      return res.status(410).json({ errorMessage: "File is no longer available" });
    }

    // RFC 5987 + quoted filename for the original name. Use a generic
    // ascii-safe fallback for the quoted form to keep headers parseable.
    const ascii = att.original_filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "");
    const utf8 = encodeURIComponent(att.original_filename);
    res.setHeader("Content-Type", att.mime_type);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`,
    );
    const stream = fs.createReadStream(fullPath);
    stream.on("error", (err) => {
      console.error("[payments/attachments/download] stream error", err.message);
      if (!res.headersSent) {
        res.status(500).json({ errorMessage: "Failed to read file" });
      } else {
        res.destroy(err);
      }
    });
    stream.pipe(res);
  } catch (err) {
    console.error("[payments/attachments/download]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});

// ---- DELETE /api/payments/:paymentId/attachments/:attId ----
router.delete("/:paymentId/attachments/:attId", async (req, res) => {
  const paymentId = parseInt(req.params.paymentId, 10);
  const attId = parseInt(req.params.attId, 10);
  if (!Number.isFinite(paymentId) || paymentId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }
  if (!Number.isFinite(attId) || attId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid attachment id" });
  }
  try {
    const { rows, rowCount } = await pool.query(
      `DELETE FROM payment_attachments
       WHERE id = $1 AND payment_id = $2
       RETURNING stored_filename`,
      [attId, paymentId],
    );
    if (rowCount === 0) {
      return res.status(404).json({ errorMessage: "Attachment not found" });
    }
    const fullPath = path.join(UPLOAD_ROOT, "payments", String(paymentId), rows[0].stored_filename);
    try {
      await fsp.unlink(fullPath);
    } catch (fsErr) {
      // File already gone — log but don't fail the request.
      console.error(
        "[payments/attachments/delete] unlink failed",
        fullPath,
        fsErr.message,
      );
    }
    return res.status(204).send();
  } catch (err) {
    console.error("[payments/attachments/delete]", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});
