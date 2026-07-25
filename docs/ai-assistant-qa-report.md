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

## ~~CRITICAL Issues~~ All Fixed ✅

### 1. ✅ API key encryption (FIXED in `a036be2`)

Implemented AES-256-GCM encryption via `lib/ai-encryption.js`:
- Admin route encrypts API keys before INSERT/UPDATE
- Embed route decrypts before calling the LLM
- Legacy plaintext keys supported via graceful fallback
- Key derived from `AI_ASSISTANT_ENCRYPTION_KEY` env var via PBKDF2

### 2. ✅ LLM timeout changed to 30s (FIXED in `a036be2`)

Passes `timeoutMs: 30_000` to `streamChat()`.

---

## ~~HIGH Issues~~ All Fixed ✅

### 3. ✅ SSE heartbeat added (FIXED in `a036be2`)

15s heartbeat interval writes `: heartbeat\n\n` to the SSE stream, cleared on done/error.

### 4. ✅ Widget language detection order fixed (FIXED in `a036be2`)

Now follows the plan's priority chain:
1. `data-lang` attribute on `<script>` tag
2. `<html lang="...">` on host page
3. `navigator.language` / `navigator.languages[0]`
4. Fallback to `DEFAULT_LANGUAGE`

### 5. ✅ AiChatPreview.tsx created (FIXED in `a036be2`)

Admin live preview component showing the widget with current branding settings. Integrated into `AiAssistantViewPage` Details tab.

---

## ~~MEDIUM Issues~~ All Fixed ✅

### 6. ✅ Config endpoint SELECT * replaced (FIXED in `a036be2`)

Chat endpoint now selects only: `id, status, base_prompt, model, base_url, api_key_enc, default_language, allowed_origins`.

### 7. ✅ Upload directory configurable (FIXED in `a036be2`)

Uses `AI_ASSISTANT_UPLOAD_DIR` env var, falls back to `os.tmpdir()/ai-assistant-uploads`.

### 8. ✅ MIME type validation added (FIXED in `a036be2`)

Both extension and MIME type are validated. Allowed MIME types: `text/plain`, `text/markdown`, `text/csv`, `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/octet-stream`.

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

### Frontend Components (9/9)
- [x] `AiAssistantActions.tsx` — row-level actions
- [x] `AiAssistantConfigForm.tsx` — form with 6 sections + preset save/load
- [x] `AiAssistantViewShell.tsx` — loading/error shell
- [x] `AiAssistantSnippetPanel.tsx` — snippet + copy + origin display
- [x] `AiKnowledgeBasePanel.tsx` — upload + list + status
- [x] `AiLanguageConfig.tsx` — language selector + translations editor
- [x] `AiChatSessionsPanel.tsx` — session viewer
- [x] `ProjectAiAssistant.tsx` — project card
- [x] `AiChatPreview.tsx` — admin chat preview (integrated in ViewPage Details tab)

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

## ~~Recommended Fix Order~~ All Complete ✅

All 8 issues fixed in commit `a036be2` (2025-07-25). TypeScript compile and Vite build both pass cleanly. `.env.example` updated with `AI_ASSISTANT_ENCRYPTION_KEY`, `AI_ASSISTANT_UPLOAD_DIR`, and rate limit env vars.
