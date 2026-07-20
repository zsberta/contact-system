import express from "express";
import multer from "multer";
import { fileTypeFromBuffer } from "file-type";
import crypto from "node:crypto";
import path from "node:path";
import fsp from "node:fs/promises";
import { pool } from "../db/pool.js";
import { requireAuth } from "../middleware/jwtAuth.js";
import { resolvePublicUrl } from "../lib/email.js";

// Admin upload endpoint for blog post images. Two purposes:
//   - "cover": the post's hero/cover image (single per post).
//   - "inline": images embedded in the Tiptap body (multiple per post).
//
// The body upload uses a different endpoint (Tiptap-image extension
// could call it) but we keep them on the same router for now to
// share the sniff + storage logic. If the inline-image volume grows
// beyond what an in-DB lookup can find quickly, we may need to
// rewrite inline-image references in body_json to point at the
// stored_filename URL — not implemented in v1 because Tiptap
// stores URLs verbatim.

export const router = express.Router();
router.use(requireAuth);

const isEnduser = (req) => req.user && req.user.role === "enduser";
const forbidEnduserMutation = (req, res) => {
  if (isEnduser(req)) {
    return res.status(403).json({ errorMessage: "Endusers have read-only access" });
  }
  return null;
};

const UPLOAD_ROOT = process.env.UPLOADS_DIR || "/app/uploads";

// 10 MB hard cap. Photos are bigger than PDFs and we want to keep
// the request body sane. Operators can resize before upload if
// their original is bigger; the landing's <picture> element with
// srcset can serve multiple resolutions later if we want.
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Image-only mime allowlist. The order of this list is the
// priority order for server-side conversions (when we add a
// server-side webp encoder) and for the FE upload accept attribute.
const ALLOWED_MIME = [
  "image/webp",  // preferred — best size/quality tradeoff
  "image/png",
  "image/jpeg",
  "image/avif",  // newer, smaller, supported by all modern browsers
];

const ALLOWED_MIME_SET = new Set(ALLOWED_MIME);

// Extension chosen by sniffed mime, not by the user's filename.
// This is important because the user might upload "photo.jpg" that
// actually sniffs as webp (some cameras do this) — we'd save the
// file with .webp and the URL would reflect that.
const EXT_FOR_MIME = {
  "image/webp": ".webp",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/avif": ".avif",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function rowToAttachmentDTO(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    postId: Number(row.post_id),
    originalFilename: row.original_filename,
    storedFilename: row.stored_filename,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    purpose: row.purpose,
    uploadedAt: new Date(row.uploaded_at).toISOString(),
  };
}

function handleMulterError(err, _req, res, next) {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ errorMessage: "File too large" });
  }
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ errorMessage: err.message });
  }
  return next(err);
}

// ---- POST /api/blog/:id/cover ----
// Multipart upload. Field name "file". Single image, 10 MB cap.
// Returns the URL where the image is served, which the FE saves
// into blog_posts.cover_image_url.
router.post(
  "/:id/cover",
  (req, res, next) => {
    const guard = forbidEnduserMutation(req, res);
    if (guard) return guard;
    const postId = parseInt(req.params.id, 10);
    if (!Number.isFinite(postId) || postId <= 0) {
      return res.status(400).json({ errorMessage: "Invalid id" });
    }
    req._postId = postId;
    next();
  },
  (req, res, next) => {
    upload.single("file")(req, res, (err) => handleMulterError(err, req, res, next));
  },
  async (req, res) => {
    const postId = req._postId;
    if (!req.file) {
      return res.status(400).json({ errorMessage: "No file uploaded" });
    }

    // Sniff the real mime. fileTypeFromBuffer returns undefined
    // when it can't determine a type (e.g. HEIC without an extra
    // libheif-js sidecar — which we don't bundle).
    let sniff;
    try {
      sniff = await fileTypeFromBuffer(req.file.buffer);
    } catch (e) {
      console.error("[blog/cover] sniff failed:", e.message);
      sniff = null;
    }
    const sniffedMime = sniff?.mime ?? null;
    if (!sniffedMime || !ALLOWED_MIME_SET.has(sniffedMime)) {
      return res.status(400).json({
        errorMessage: `File type not allowed. Accepted: ${ALLOWED_MIME.join(", ")}`,
      });
    }

    // Verify the post exists before dropping bytes on disk.
    try {
      const p = await pool.query(`SELECT id FROM blog_posts WHERE id = $1`, [postId]);
      if (p.rowCount === 0) {
        return res.status(404).json({ errorMessage: "Blog post not found" });
      }
    } catch (err) {
      console.error("[blog/cover] post lookup:", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }

    const ext = EXT_FOR_MIME[sniffedMime];
    const stored = `${crypto.randomUUID()}${ext}`;
    const postDir = path.join(UPLOAD_ROOT, "blog", String(postId));
    const fullPath = path.join(postDir, stored);

    try {
      await fsp.mkdir(postDir, { recursive: true });
      await fsp.writeFile(fullPath, req.file.buffer);
    } catch (err) {
      console.error("[blog/cover] write failed:", err.message);
      return res.status(500).json({ errorMessage: "Failed to store file" });
    }

    // Delete previous cover image (if any). One row per (post,
    // purpose='cover'). Cascade delete on post-delete cleans up
    // orphans when the post itself is removed.
    try {
      const prev = await pool.query(
        `SELECT stored_filename FROM blog_attachments
         WHERE post_id = $1 AND purpose = 'cover'`,
        [postId],
      );
      for (const row of prev.rows) {
        const prevPath = path.join(postDir, row.stored_filename);
        try {
          await fsp.unlink(prevPath);
        } catch {
          // File already gone — fine, log only.
        }
      }
      await pool.query(
        `DELETE FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'`,
        [postId],
      );
    } catch (err) {
      // Non-fatal — the new file is on disk; the old row cleanup
      // will happen on next upload or via the cascade on post-delete.
      console.error("[blog/cover] cleanup prev:", err.code, err.message);
    }

    let inserted;
    try {
      const { rows } = await pool.query(
        `INSERT INTO blog_attachments
          (post_id, original_filename, stored_filename, mime_type, size_bytes, purpose, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, 'cover', $6)
         RETURNING id, post_id, original_filename, stored_filename, mime_type,
                   size_bytes, purpose, uploaded_at`,
        [
          postId,
          req.file.originalname,
          stored,
          sniffedMime,
          req.file.size,
          req.user?.id ?? null,
        ],
      );
      inserted = rows[0];
    } catch (err) {
      // Roll back the disk write so we don't leak orphans.
      try { await fsp.unlink(fullPath); } catch { /* ignore */ }
      console.error("[blog/cover] db insert:", err.code, err.message);
      return res.status(500).json({ errorMessage: "Internal server error" });
    }

    // Update the post's cover_image_url to point at the new public
    // asset. The public route (mounted under /api/public/blog/
    // attachments/:filename) serves it.
    //
    // We return an absolute URL because the browser fetches it from
    // outside the Docker container — a path-only URL would resolve
    // relative to whatever origin the SPA is served from, which
    // works for the SPA itself but breaks image previews in
    // content-management contexts (e.g. email, social cards). In
    // production, APP_PUBLIC_URL is set to the canonical CRM origin
    // (https://crm.zsoltberta.hu); in dev, we fall back to the
    // request's own host so localhost / docker compose setups work.
    const publicBase = resolvePublicUrl(req).replace(/\/+$/, "");
    const url = `${publicBase}/api/public/blog/attachments/${stored}`;
    try {
      await pool.query(
        `UPDATE blog_posts SET cover_image_url = $1 WHERE id = $2`,
        [url, postId],
      );
    } catch (err) {
      console.error("[blog/cover] update cover_image_url:", err.code, err.message);
      // Non-fatal — the file is uploaded, the URL is returned, the
      // operator can retry the post save. Don't roll back here.
    }

    return res.status(201).json({
      ...rowToAttachmentDTO(inserted),
      url,
    });
  },
);

// ---- DELETE /api/blog/:id/cover ----
router.delete("/:id/cover", async (req, res) => {
  const guard = forbidEnduserMutation(req, res);
  if (guard) return guard;

  const postId = parseInt(req.params.id, 10);
  if (!Number.isFinite(postId) || postId <= 0) {
    return res.status(400).json({ errorMessage: "Invalid id" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT stored_filename FROM blog_attachments
       WHERE post_id = $1 AND purpose = 'cover'`,
      [postId],
    );
    for (const row of rows) {
      const fullPath = path.join(UPLOAD_ROOT, "blog", String(postId), row.stored_filename);
      try { await fsp.unlink(fullPath); } catch { /* already gone */ }
    }
    await pool.query(
      `DELETE FROM blog_attachments WHERE post_id = $1 AND purpose = 'cover'`,
      [postId],
    );
    await pool.query(
      `UPDATE blog_posts SET cover_image_url = NULL WHERE id = $1`,
      [postId],
    );
    return res.status(204).end();
  } catch (err) {
    console.error("[blog/cover delete]:", err.code, err.message);
    return res.status(500).json({ errorMessage: "Internal server error" });
  }
});