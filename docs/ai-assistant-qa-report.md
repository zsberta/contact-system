# AI Assistant Feature — QA Report

**Date:** 2025-07-25
**Baseline:** `f597879` (agent polish commit)
**Method:** Systematic verification of every requirement in `docs/ai-assistant-feature-plan.md`

---

## Summary

| Category | Status |
|---|---|
| Database schema | ✅ PASS |
| Admin routes (11) | ✅ PASS |
| Embed routes (4) | ✅ PASS |
| Preset routes (5) | ✅ PASS |
| Server mounts + CORS | ✅ PASS |
| Frontend pages (4) | ✅ PASS |
| Frontend components (8/9) | ⚠️ 1 missing |
| Frontend routing | ✅ PASS |
| Sidebar integration | ✅ PASS |
| ProjectViewPage integration | ✅ PASS |
| PortalIndexRedirect | ✅ PASS |
| i18n (EN + HU) | ✅ PASS (129 keys each, identical key sets) |
| Widget JS | ⚠️ 3 issues |
| API key encryption | ❌ PLACEHOLDER |
| Security constraints | ✅ PASS |

---

## CRITICAL Issues (must fix)

### 1. ❌ API key encryption is a placeholder

**Plan requirement (section Security > API key encryption):**
> API keys stored as `api_key_enc` using AES-256-GCM encryption at rest. Decrypted only at the point of use.

**What exists:**
- `routes/ai-assistant.js` line 317: stores the raw API key directly into `api_key_enc` column — no encryption.
- `routes/ai-assistant-embed.js` line 118-121: `decryptApiKey()` is a no-op placeholder:
  ```js
  function decryptApiKey(enc) {
    return enc || "";
    // Placeholder: in production, decrypt using AI_ASSISTANT_ENCRYPTION_KEY env var
  }
  ```

**Impact:** API keys are stored in plaintext in the database. If the DB is compromised, all API keys are exposed.

**Fix needed:**
- Add AES-256-GCM encrypt/decrypt functions using `AI_ASSISTANT_ENCRYPTION_KEY` env var (as specified in the plan).
- Encrypt in the admin route before INSERT/UPDATE.
- Decrypt in the embed route before calling the LLM.
- Use `crypto.createCipheriv`/`crypto.createDecipheriv` with a 256-bit key derived via scrypt or pbkdf2 from the env var.

### 2. ❌ LLM timeout is 60s, plan specifies 30s

**Plan requirement (section Security > Chat endpoint):**
> Response timeout: 30 seconds (LLM call)

**What exists:**
- `lib/ai-llm-client.js` line 37: default `timeoutMs = 60_000`
- `routes/ai-assistant-embed.js` line 373: calls `streamChat()` without passing `timeoutMs`, so it uses the 60s default.

**Fix needed:** Pass `timeoutMs: 30_000` in the `streamChat()` call, or change the default in `ai-llm-client.js` to 30000.

---

## HIGH Issues (should fix)

### 3. ⚠️ No SSE heartbeat

**Plan requirement:**
> SSE streaming with heartbeat every 15 seconds to prevent timeouts.

**What exists:** No heartbeat interval is set up in the SSE chat endpoint. If the LLM takes >30s to generate a response, the connection may be dropped by proxies/browsers.

**Fix needed:** Start a `setInterval` that writes `: heartbeat\n\n` every 15s, clear it on stream completion.

### 4. ⚠️ Widget doesn't follow the language detection priority order

**Plan requirement (section Widget > Language detection order):**
1. `data-lang` attribute on `<script>` tag
2. `<html lang="...">` attribute on host page
3. `navigator.language` / `navigator.languages[0]`
4. Fallback to assistant's `default_language`

**What exists:** The widget sets `currentLang = DEFAULT_LANGUAGE` (server-baked default) at init, then `watchDataLang()` sets up a MutationObserver that only reacts to *future changes* of `data-lang`. It never checks:
- The initial `data-lang` value on the script tag
- `<html lang="...">`
- `navigator.language`

**Fix needed:** Before setting `currentLang`, run the detection chain:
```js
var scriptEl = document.currentScript;
var initialLang =
  (scriptEl && scriptEl.getAttribute("data-lang")) ||
  document.documentElement.lang ||
  (navigator.languages && navigator.languages[0]) ||
  DEFAULT_LANGUAGE;
currentLang = initialLang;
```

### 5. ⚠️ Missing `AiChatPreview.tsx` component

**Plan requirement (components table):**
> `AiChatPreview.tsx` — Live preview of the chat widget (admin preview)

This component is listed in the plan but was not created. It would let admins preview the chat widget directly in the CRM admin UI.

**Impact:** Low-Medium. The widget can still be tested via the embed URL. But it's a missing deliverable from the plan.

---

## MEDIUM Issues (nice to fix)

### 6. ⚠️ Config endpoint SELECT * in chat query

`routes/ai-assistant-embed.js` line 262:
```sql
SELECT * FROM ai_assistant_configs WHERE secret_token = $1
```
This pulls all columns including `api_key_enc` into memory. While it's only used server-side (never sent to the client), it's unnecessary data exposure in the Node.js process. The admin route intentionally avoids `SELECT *` (line 526+). The chat endpoint should select only the columns it needs.

### 7. ⚠️ File uploaded to `os.tmpdir()` instead of a dedicated uploads directory

`routes/ai-assistant.js` line 512:
```js
dest: path.join(os.tmpdir(), "ai-assistant-uploads"),
```
The plan says "Files stored outside the web root with randomized filenames." While `os.tmpdir()` is technically outside the web root, it's not a dedicated directory. On Linux `/tmp` may be RAM-backed and lost on reboot. Should use a configurable upload directory.

### 8. ⚠️ No file type validation on MIME type (plan mentions MIME whitelist)

**Plan requirement:**
> Whitelist of allowed MIME types: `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`

**What exists:** Only extension-based validation (`.txt`, `.md`, `.pdf`, `.docx`, `.csv`). No MIME type check. This is acceptable but doesn't match the plan exactly.

---

## PASS Checklist

### Database (7/7 tables)
- [x] `ai_assistant_configs` with all columns, constraints, UNIQUE FK on project_id
- [x] `ai_assistant_translations` with UNIQUE (assistant_id, language)
- [x] `ai_config_presets` with all columns
- [x] `ai_knowledge_base` with status CHECK constraint
- [x] `ai_knowledge_chunks` with pgvector VECTOR(1536)
- [x] `ai_chat_sessions` with indexes
- [x] `ai_chat_messages` with indexes
- [x] pgvector extension created
- [x] IVFFlat index on embeddings
- [x] updated_at triggers on all relevant tables
- [x] CASCADE deletes on all FKs

### Admin API Routes (11/11)
- [x] GET `/` — paginated list
- [x] GET `/by-project/:projectId` — lazy create-or-return
- [x] GET `/:id` — single config
- [x] PUT `/:id` — update config
- [x] DELETE `/:id` — delete config
- [x] GET `/:id/snippet` — embed snippet
- [x] GET `/:id/knowledge` — list documents
- [x] POST `/:id/knowledge` — upload document (multer)
- [x] DELETE `/:id/knowledge/:docId` — delete document
- [x] GET `/:id/sessions` — chat sessions
- [x] GET `/:id/sessions/:sessionId` — session messages

### Public Embed Routes (4/4)
- [x] GET `/:secret_token/script.js` — serves widget with placeholder replacement
- [x] GET `/:secret_token/config` — lightweight config (no api_key leak)
- [x] POST `/:secret_token/chat` — SSE streaming chat
- [x] POST `/:secret_token/language` — language switch

### Preset Routes (5/5)
- [x] GET `/` — list
- [x] GET `/:id` — single
- [x] POST `/` — create
- [x] PUT `/:id` — update
- [x] DELETE `/:id` — delete

### Security
- [x] 404 masking (unknown token, disabled, origin mismatch all return 404)
- [x] Origin allowlist check in chat endpoint
- [x] Rate limiting (burst + sustained) on chat endpoint
- [x] Max message length: 2000 chars
- [x] Max conversation history: last 20 messages
- [x] Max RAG chunks: top 5
- [x] API key never returned in admin DTO (`rowToConfigDTO` excludes it)
- [x] Config endpoint excludes api_key from response
- [x] File type whitelist (extension-based)
- [x] Per-assistant file size limit
- [x] Auth required on admin routes, enduser mutations rejected

### Frontend Pages (4/4)
- [x] `AiAssistantPage.tsx` — paginated list
- [x] `AiAssistantViewPage.tsx` — 3-tab view (Details / Knowledge Base / Beágyazás)
- [x] `AiAssistantEditPage.tsx` — edit form
- [x] `PortalAiAssistantPage.tsx` — portal page

### Frontend Components (8/9 — 1 missing)
- [x] `AiAssistantActions.tsx` — row-level actions
- [x] `AiAssistantConfigForm.tsx` — form with 6 sections + preset save/load
- [x] `AiAssistantViewShell.tsx` — loading/error shell
- [x] `AiAssistantSnippetPanel.tsx` — snippet + copy + origin display
- [x] `AiKnowledgeBasePanel.tsx` — upload + list + status
- [x] `AiLanguageConfig.tsx` — language selector + translations editor
- [x] `AiChatSessionsPanel.tsx` — session viewer
- [x] `ProjectAiAssistant.tsx` — project card
- [ ] `AiChatPreview.tsx` — **MISSING** (admin chat preview)

### Integrations
- [x] `server.js` — 3 route mounts + CORS middleware for embed route
- [x] `Sidebar.tsx` — admin link + enduser conditional link
- [x] `App.tsx` — 4 routes (3 admin + 1 portal)
- [x] `ProjectViewPage.tsx` — `<ProjectAiAssistant>` rendered
- [x] `PortalIndexRedirect.tsx` — AI assistant feature detection + redirect
- [x] `src/i18n/en/navigation.json` — `ai_assistant` key
- [x] `src/i18n/hu/navigation.json` — `ai_assistant` key

### i18n
- [x] `src/i18n/en/ai-assistant.json` — 129 keys
- [x] `src/i18n/hu/ai-assistant.json` — 129 keys
- [x] Key sets are identical (diff confirmed)

### Widget JS
- [x] Shadow DOM for style isolation
- [x] `window.__aiAssistant.setLanguage()` API
- [x] `CustomEvent` listener (`ai-assistant:language-change`)
- [x] `MutationObserver` on `data-lang` (for changes)
- [x] SSE streaming via `fetch` + `ReadableStream` reader
- [x] Copyright: "Powered by Zsolt Berta" with link to zsoltberta.hu
- [x] Position support (bottom-right / bottom-left)
- [x] Mobile responsive (`@media` query)
- [x] Prevents double-init
- [x] Language switch: replaces greeting if no user messages, sends system message otherwise
- [x] Chat state persistence across close/reopen

### Backend Libraries
- [x] `lib/ai-knowledge-processor.js` — `processDocument()` export, chunkText, extraction
- [x] `lib/ai-llm-client.js` — `streamChat()` export, AbortController timeout, SSE parsing
- [x] `lib/vector-search.js` — `searchKnowledgeBase()` export, pgvector cosine search

### Design Decisions (per plan)
- [x] pgvector over separate vector DB
- [x] SSE streaming over WebSocket
- [x] Shadow DOM for widget
- [x] Lazy config creation (by-project)
- [x] One assistant per project (UNIQUE FK)
- [x] Language-agnostic RAG (no language tagging on documents)
- [x] Language switching entirely widget-side

---

## Recommended Fix Order

1. **API key encryption** (CRITICAL) — implement AES-256-GCM encrypt/decrypt
2. **LLM timeout** (CRITICAL) — change to 30s
3. **SSE heartbeat** (HIGH) — add 15s heartbeat
4. **Widget language detection** (HIGH) — add html lang + navigator.language fallback
5. **AiChatPreview** (HIGH) — create the missing component
6. Config endpoint SELECT * cleanup (MEDIUM)
7. Upload directory configuration (MEDIUM)
8. MIME type validation (MEDIUM)
