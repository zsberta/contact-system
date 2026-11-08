-- Up Migration
--
-- 0018: Blog attachments — image storage for blog_posts.cover_image_url
-- and any inline images the operator pastes into the Tiptap editor
-- body. Files are stored on disk under UPLOADS_DIR/blog/<post_id>/,
-- served via routes/blog-public.js GET /api/public/blog/attachments/:filename.
--
-- ============================================================================
-- WHY A SEPARATE TABLE
-- ============================================================================
-- We could share project_attachments, but a blog post is conceptually
-- owned by the post (delete-post cascades the attachments), not by the
-- project (which may outlive any single post). A dedicated table also
-- keeps the public read endpoint trivial — the public surface doesn't
-- need to walk through project_attachments, and a project with N posts
-- doesn't have its attachments list polluted with N×M cover images.
--
-- ============================================================================
-- ALLOWED MIME POLICY (mirrored in the upload route handler)
-- ============================================================================
-- WebP first, then PNG/JPEG, then AVIF as a quality-of-life add.
-- SVG is intentionally NOT accepted — the operator would have to
-- remember to wrap it in a CSP-friendly <img>, and the on-disk cost
-- of a PNG cover image is small. Sniffing happens server-side
-- (file-type), we never trust req.file.mimetype. The mime column
-- stores the SNIFFED value, not the client-advertised one.
--
-- ============================================================================
-- STORAGE LAYOUT
-- ============================================================================
-- Files go to UPLOADS_DIR/blog/<post_id>/<uuid>.<ext>. The post_id
-- directory isolates one post's uploads from another so a bulk
-- delete-by-post is a single rmdir. The uuid filename prevents
-- collisions when two operators upload files with the same
-- originalFilename at the same time.
--
-- ============================================================================
-- TRANSACTION NOTE
-- ============================================================================
-- node-pg-migrate wraps each migration in a single transaction by
-- default. CREATE INDEX IF NOT EXISTS (without CONCURRENTLY) is safe
-- inside a transaction.

-- ---------------------------------------------------------------------------
-- Recovery block
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  DROP TABLE IF EXISTS blog_attachments CASCADE;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '0018: recovery drop of blog_attachments skipped: %', SQLERRM;
END $$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blog_attachments (
  id                 BIGSERIAL PRIMARY KEY,
  post_id            BIGINT NOT NULL REFERENCES blog_posts(id) ON DELETE CASCADE,
  original_filename  TEXT NOT NULL,
  stored_filename    TEXT NOT NULL UNIQUE,
  mime_type          TEXT NOT NULL,
  size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  purpose            TEXT NOT NULL DEFAULT 'cover'
                     CHECK (purpose IN ('cover', 'inline')),
  uploaded_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cover image lookup — "give me the cover for this post" is the
-- common read path (BlogViewPage preview + the landing's prerender).
CREATE INDEX IF NOT EXISTS idx_blog_attachments_post_cover
  ON blog_attachments (post_id)
  WHERE purpose = 'cover';

-- Inline-image lookup — less common but cheap to support. The body
-- may have many inline images, all under one post.
CREATE INDEX IF NOT EXISTS idx_blog_attachments_post_inline
  ON blog_attachments (post_id, uploaded_at DESC)
  WHERE purpose = 'inline';

-- Down Migration

DROP INDEX IF EXISTS idx_blog_attachments_post_inline;
DROP INDEX IF EXISTS idx_blog_attachments_post_cover;
DROP TABLE IF EXISTS blog_attachments;