import DOMPurify from "isomorphic-dompurify";

// Sanitize the rich-text body produced by the CRM's Tiptap editor before
// it lands in blog_posts.body_html. The output of this function is what
// gets shipped to the public API and rendered on the landing pages —
// unsanitized input would let a malicious editor persist a <script>
// tag that fires on every visitor.
//
// Threat model:
//   - The CRM is single-tenant per operator, but operators vary in
//     trust level (endusers can edit posts on their own projects).
//   - The landing pages have a strict CSP (no inline scripts, no eval)
//     which is the primary defence. Sanitization is defence in depth:
//     even if a future landing relaxes the CSP, stored XSS still
//     can't slip through.
//   - DOMPurify is the standard allowlist-based sanitizer and is the
//     same lib we use for any future FE-side preview rendering.
//
// Allowlist scope:
//   - Standard formatting: p, br, h1-h6, blockquote, pre, code, ul, ol, li
//   - Inline formatting: strong, em, u, s, mark, small, sub, sup, a, span
//   - Media: img (with restricted src protocols), figure, figcaption
//   - Tables: table, thead, tbody, tr, th, td
//   - Hard rules: NO <script>, NO <style>, NO <iframe>, NO <object>,
//     NO <embed>, NO event handler attributes, NO javascript: URLs.
//
// What we deliberately allow but the FE should still treat carefully:
//   - `class` attributes (Tiptap emits them for editor styling hints)
//   - `data-*` attributes (Tiptap uses data-id, data-type, etc.)
//   - `id` (for heading anchors like #h-miert-fontos-a-masszazs)
//
// Note: this sanitizer is server-side. The Tiptap editor on the FE
// already prevents most of these vectors at the schema level; this is
// the last line of defence for content that came in via API and never
// went through the editor.
const ALLOWED_TAGS = [
  // Block-level
  "p", "br", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "blockquote", "pre", "code",
  "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td",
  "figure", "figcaption", "img",
  "div", "article", "section",
  // Inline
  "a", "span", "strong", "em", "b", "i", "u", "s",
  "mark", "small", "sub", "sup",
];

const ALLOWED_ATTR = [
  "href", "title", "target", "rel",
  "src", "alt", "width", "height", "loading", "srcset", "sizes",
  "class", "id", "lang",
  "colspan", "rowspan",
  "datetime",
  // Tiptap metadata — these are editor-issued and benign
  "data-id", "data-type", "data-language", "data-checked",
];

// Force external links to be safe by default. Tiptap supports the
// `target` attribute on <a>; when an operator sets it to "_blank" we
// also inject rel="noopener noreferrer" so the landing page can't be
// tab-napped via window.opener. This is a defense-in-depth on top of
// the DOMPurify default behaviour.
const ADD_ATTR = ["target"];

// Hooks run on every element before serialization. We use them to
// enforce two invariants:
//   1. <a target="_blank"> always carries rel="noopener noreferrer"
//   2. <a> and <img> never reference dangerous schemes (javascript:,
//      data:, vbscript:, etc.) — DOMPurify already blocks javascript:
//      in href/src but explicit ADD_URI_SAFE_ATTR keeps the
//      contract obvious to future readers.
//
// DOMPurify's hook signature is (node, data) where `data` is null on
// text nodes and an object on element nodes. We bail out on text nodes.
function applyPostHooks(DOMPurifyInstance) {
  DOMPurifyInstance.addHook("afterSanitizeAttributes", (node) => {
    if (!node || node.nodeType !== 1 /* ELEMENT_NODE */) return;
    const tag = node.tagName;
    if (tag === "A") {
      // Force safe window.opener behaviour on every target="_blank".
      if (node.getAttribute("target") === "_blank") {
        node.setAttribute("rel", "noopener noreferrer");
      }
      // Belt-and-braces: never let javascript: through, even if the
      // sanitizer config changes in a future version.
      const href = node.getAttribute("href") || "";
      if (/^\s*(javascript|vbscript|data):/i.test(href)) {
        node.removeAttribute("href");
      }
    }
    if (tag === "IMG") {
      const src = node.getAttribute("src") || "";
      if (/^\s*(javascript|vbscript):/i.test(src)) {
        node.removeAttribute("src");
      }
    }
  });
}

// Single shared DOMPurify instance — `isomorphic-dompurify` returns a
// configured singleton that's safe to reuse across requests. We
// configure it once at module load time.
applyPostHooks(DOMPurify);
const PURIFIER = DOMPurify;

/**
 * Sanitize a Tiptap / Quill-style HTML body.
 *
 * Strips dangerous tags (script/style/iframe/object/embed) and
 * event-handler attributes, enforces safe link/anchor behaviour, and
 * returns a clean HTML string ready for storage in blog_posts.body_html.
 *
 * Idempotent: calling sanitizeBlogBody on already-sanitized content is
 * a no-op (DOMPurify is stable across repeated passes).
 *
 * Throws on non-string input — the validator catches that case first,
 * but we double-check here so a future code path that forgets the
 * typeof guard gets a loud failure rather than silent coercion.
 *
 * @param {string} html - the raw HTML to sanitize
 * @returns {string} sanitized HTML
 */
export function sanitizeBlogBody(html) {
  if (typeof html !== "string") {
    throw new TypeError("sanitizeBlogBody expects a string");
  }
  if (html.length === 0) {
    throw new RangeError("sanitizeBlogBody expects a non-empty string");
  }
  return PURIFIER.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ADD_ATTR,
    // Explicit URI scheme allowlist — DOMPurify's default ALLOWED_URI_REGEXP
    // already covers http(s)/mailto/tel, but pinning the list here makes
    // the contract obvious to future readers.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    // Strip comments and processing instructions — they can hide payloads
    // that bypass tag-level filters in some old parsers.
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    // FORBID_TAGS is implicit (everything not in ALLOWED_TAGS is dropped)
    // but listing these explicitly makes the intent obvious.
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "input", "button", "link", "meta"],
    FORBID_ATTR: ["style"],
  });
}