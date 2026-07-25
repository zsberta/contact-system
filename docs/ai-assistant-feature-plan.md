# AI Assistant Widget — Feature Plan

## Overview

An embeddable AI chat widget that endusers can create per-project in the CRM. Customers visiting landing pages (or any page where the snippet is placed) can chat with an AI assistant powered by a configurable LLM backend. The assistant has a per-project RAG knowledge base (PDFs, text, docs) and fully customizable branding. The feature lives under the "Beágyazás" (Embed) tab alongside analytics/forms, admin-only for configuration. **Multilanguage**: the RAG knowledge base is language-agnostic (searches all documents regardless of language). Language switching happens on the landing page side via a JS API/event that tells the widget to change its UI language and greet the visitor in the new language.

---

## Architecture

The feature follows the exact same pattern as the **Analytics module** (the closest sibling):

| Layer | Analytics equivalent | AI Assistant equivalent |
|---|---|---|
| Admin CRUD route | `routes/analytics.js` → `/api/analytics` | `routes/ai-assistant.js` → `/api/ai-assistant` |
| Public embed route | `routes/analytics-embed.js` → `/api/public/analytics` | `routes/ai-assistant-embed.js` → `/api/public/ai-assistant` |
| DB migration | `0013_add_analytics.sql` | `0024_add_ai_assistant.sql` |
| Frontend pages | `AnalyticsPage`, `AnalyticsViewPage`, `AnalyticsEditPage` | `AiAssistantPage`, `AiAssistantViewPage`, `AiAssistantEditPage` |
| Snippet panel | `AnalyticsSnippetPanel` | `AiAssistantSnippetPanel` |
| Project card | `ProjectAnalytics` | `ProjectAiAssistant` |
| Portal page | `PortalAnalyticsPage` | `PortalAiAssistantPage` |
| Types | `src/types/analytics.ts` | `src/types/ai-assistant.ts` |
| FE lib | `src/lib/analytics.ts` | `src/lib/ai-assistant.ts` |
| Components | `src/components/analytics/` | `src/components/ai-assistant/` |
| i18n | `src/i18n/{en,hu}/analytics.json` | `src/i18n/{en,hu}/ai-assistant.json` |

### Embed script delivery

The JS widget script is served from the public embed route (`GET /api/public/ai-assistant/:secret_token/script.js`), identical to how analytics serves its loader. The script:

1. Injects a shadow DOM chat widget into the host page
2. Communicates with the backend via `POST /api/public/ai-assistant/:secret_token/chat`
3. Fetches the assistant's theme config (colors, name, language pack) from a lightweight config endpoint baked into the script
4. Exposes a global JS API (`window.__aiAssistant.setLanguage(lang)`) and listens for custom events so the host page can switch the widget's language at any time
5. Sends the current language with every chat request so the backend responds in the correct language

### Embed snippet (multilanguage)

The snippet rendered in the Beágyazás tab looks like:

```html
<!-- Default: uses defaultLanguage from CRM config -->
<script src="https://your-app.com/api/public/ai-assistant/aB3_xK9mP2qR5tY7wZ1vL0/script.js" defer></script>

<!-- With explicit default language (overrides CRM default) -->
<script src="https://your-app.com/api/public/ai-assistant/aB3_xK9mP2qR5tY7wZ1vL0/script.js" data-lang="hu" defer></script>
```

The `data-lang` attribute sets the widget's initial language. Priority:
1. `data-lang` attribute on `<script>` tag (explicit override from the embedder)
2. `defaultLanguage` from the CRM config
3. Fallback: `"en"`

### Language switching API (landing page side)

The widget exposes two ways for the host page to change language. When language changes:

1. The widget UI instantly switches (greeting text, placeholder, etc.)
2. If the chat is open and no user message has been sent yet (fresh greeting state), the old greeting is removed and a new one is sent in the new language
3. If the chat already has messages, the widget sends a system context message like "The visitor switched to English" so the AI naturally continues in the new language

**Method 1: Global JS function**
```javascript
window.__aiAssistant.setLanguage('en');
```

**Method 2: CustomEvent on document**
```javascript
document.dispatchEvent(new CustomEvent('ai-assistant:language-change', { detail: { lang: 'en' } }));
```

**Method 3: Reactive via `data-lang` attribute**
If the landing page dynamically changes the `data-lang` attribute on the script tag, the widget observes it via MutationObserver and switches automatically:
```html
<script id="ai-assistant-widget" src="..." data-lang="hu" defer></script>
<script>
  // When the landing page switches language:
  document.getElementById('ai-assistant-widget').setAttribute('data-lang', 'en');
  // Widget picks it up automatically via MutationObserver
</script>
```

**Language flow example:**
1. Visitor opens widget on a Hungarian landing page (`<html lang="hu">`)
2. Widget loads with `lang=hu`, greets: "Szép napot, miben segíthetek?"
3. Visitor switches language on the landing page (e.g. clicks EN button)
4. Landing page calls `window.__aiAssistant.setLanguage('en')`
5. Widget UI immediately swaps to English: header, placeholder text
6. Widget sends a system message: "The visitor switched language to English."
7. AI responds naturally in English: "Hi, how can I help you?"
8. All subsequent messages are in English

---

## Database Schema

### Table: `ai_assistant_configs`

One row per assistant, one assistant per project (UNIQUE FK on `project_id`, same as analytics).

```sql
CREATE TABLE IF NOT EXISTS ai_assistant_configs (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  secret_token    TEXT NOT NULL UNIQUE CHECK (length(secret_token) = 22),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),

  -- AI configuration (admin-only fields)
  ai_config_id    BIGINT REFERENCES ai_config_presets(id) ON DELETE SET NULL,
  model           TEXT NOT NULL DEFAULT 'gpt-4o',
  base_url        TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  api_key_enc     TEXT,              -- encrypted API key (AES-256-GCM at rest)
  base_prompt     TEXT NOT NULL DEFAULT 'You are a helpful assistant.',

  -- Widget branding (admin/configurable per assistant)
  display_name    TEXT NOT NULL DEFAULT 'AI Assistant',
  primary_color   TEXT NOT NULL DEFAULT '#3b82f6',
  secondary_color TEXT NOT NULL DEFAULT '#ffffff',
  greeting_message TEXT NOT NULL DEFAULT 'Hello! How can I help you today?',
  avatar_url      TEXT,              -- optional custom avatar for the widget
  position        TEXT NOT NULL DEFAULT 'bottom-right' CHECK (position IN ('bottom-right', 'bottom-left')),

  -- Multilanguage support
  default_language TEXT NOT NULL DEFAULT 'en',  -- initial language for the widget
  supported_languages TEXT[] NOT NULL DEFAULT '{en}',  -- languages this assistant has UI translations for

  -- Security
  allowed_origins TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_burst    INT NOT NULL DEFAULT 30,     -- per IP per minute
  rate_limit_sustained INT NOT NULL DEFAULT 500,   -- per IP per day

  -- File upload size limits for knowledge base
  max_upload_size_mb  INT NOT NULL DEFAULT 20,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `ai_assistant_translations`

Per-language UI overrides for greeting messages, display name, and input placeholder. These control what the widget shows in each language. Without a row for a given language, the assistant uses the defaults from `ai_assistant_configs`.

```sql
CREATE TABLE IF NOT EXISTS ai_assistant_translations (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  language        TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 10),  -- e.g. 'en', 'hu', 'de', 'fr', 'sk'
  display_name    TEXT,              -- override widget header name (NULL = use config default)
  greeting_message TEXT,             -- override greeting (NULL = use config default)
  placeholder     TEXT,              -- input placeholder text (NULL = use config default)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assistant_id, language)
);
```

### Table: `ai_config_presets`

Reusable AI configuration presets. Admins create these once and can apply them across multiple assistants/projects.

```sql
CREATE TABLE IF NOT EXISTS ai_config_presets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  model       TEXT NOT NULL DEFAULT 'gpt-4o',
  base_url    TEXT NOT NULL DEFAULT 'https://api.openai.com/v1',
  api_key_enc TEXT,              -- encrypted API key
  base_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `ai_knowledge_base`

Documents uploaded to an assistant's knowledge base. Each document is chunked and embedded into the vector store after upload.

```sql
CREATE TABLE IF NOT EXISTS ai_knowledge_base (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  file_type       TEXT NOT NULL,           -- 'pdf', 'txt', 'md', 'docx', 'csv', etc.
  file_size_bytes BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'ready', 'error')),
  error_message   TEXT,                    -- populated if chunking/embedding fails
  chunk_count     INT NOT NULL DEFAULT 0,  -- number of chunks created
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Table: `ai_knowledge_chunks`

Vector embeddings for RAG retrieval. Each chunk belongs to a knowledge base document and is scoped to a single assistant.

```sql
CREATE TABLE IF NOT EXISTS ai_knowledge_chunks (
  id              BIGSERIAL PRIMARY KEY,
  document_id     BIGINT NOT NULL REFERENCES ai_knowledge_base(id) ON DELETE CASCADE,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  chunk_index     INT NOT NULL,
  content         TEXT NOT NULL,           -- the raw text chunk
  embedding       VECTOR(1536),            -- pgvector column (OpenAI ada-002 dimension)
  token_count     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_assistant
  ON ai_knowledge_chunks (assistant_id);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_chunks_embedding
  ON ai_knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Table: `ai_chat_sessions`

Tracks chat sessions per visitor for conversation history and context.

```sql
CREATE TABLE IF NOT EXISTS ai_chat_sessions (
  id              BIGSERIAL PRIMARY KEY,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,           -- client-generated session UUID
  visitor_id      TEXT,                    -- long-lived visitor ID from localStorage
  language        TEXT NOT NULL DEFAULT 'en',  -- detected language for this session
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_assistant_session
  ON ai_chat_sessions (assistant_id, session_id);
```

### Table: `ai_chat_messages`

Append-only chat message log. Each message is either from the user or the assistant.

```sql
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id              BIGSERIAL PRIMARY KEY,
  session_id      BIGINT NOT NULL REFERENCES ai_chat_sessions(id) ON DELETE CASCADE,
  assistant_id    BIGINT NOT NULL REFERENCES ai_assistant_configs(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',  -- language used for this message
  tokens_used     INT NOT NULL DEFAULT 0,
  rag_sources     JSONB,                  -- array of {document_id, filename, chunk_content} used
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session
  ON ai_chat_messages (session_id, created_at);
```

### Vector Database: pgvector extension

We use the `pgvector` PostgreSQL extension rather than a separate vector database. This keeps the stack simple (no new infrastructure), leverages the existing Postgres instance, and `pgvector` is production-ready with IVFFlat and HNSW indexing.

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

**Embedding model**: OpenAI `text-embedding-3-small` (1536 dimensions) by default, configurable per assistant if using a compatible provider. The embedding call is made server-side when documents are uploaded/chunked, NOT from the client.

---

## Backend Routes

### Admin API: `/api/ai-assistant` (auth required, admin-only mutations)

Follows the exact same pattern as `routes/analytics.js`:

| Method | Path | Description |
|---|---|---|
| GET | `/` | Paged list of all assistant configs (filtered by project for endusers) |
| GET | `/by-project/:projectId` | Lazy create-or-return for a project (admin only) |
| GET | `/:id` | Get single assistant config |
| PUT | `/:id` | Update assistant config (name, model, prompt, branding, origins, rate limits) |
| DELETE | `/:id` | Delete assistant config and all associated data |
| GET | `/:id/snippet` | Rendered embed `<script>` snippet |
| GET | `/:id/knowledge` | List knowledge base documents |
| POST | `/:id/knowledge` | Upload document(s) to knowledge base |
| DELETE | `/:id/knowledge/:docId` | Delete a knowledge base document |
| GET | `/:id/sessions` | Paged list of chat sessions |
| GET | `/:id/sessions/:sessionId/messages` | Messages for a chat session |

### AI Config Presets API: `/api/ai-config-presets` (admin only)

| Method | Path | Description |
|---|---|---|
| GET | `/` | List all presets for current user |
| POST | `/` | Create a new preset |
| PUT | `/:id` | Update a preset |
| DELETE | `/:id` | Delete a preset |

### Public Embed API: `/api/public/ai-assistant` (no auth, CSRF-exempt)

| Method | Path | Description |
|---|---|---|
| GET | `/:secret_token/script.js` | Serve the widget JS (with theme + config baked in) |
| GET | `/:secret_token/config` | Lightweight config endpoint for theme/name/languages (CORS-enabled) |
| POST | `/:secret_token/chat` | Send a chat message, get assistant response (SSE stream) |
| POST | `/:secret_token/language` | Switch the session's language (called by widget on `setLanguage`) |

**Chat endpoint flow** (`POST /:secret_token/chat`):

1. Validate secret_token, check status=active, check origin allowlist
2. Rate limit check (per-IP burst + sustained, using config values)
3. Upsert or create `ai_chat_sessions` row (language tracked per session)
4. Store user message in `ai_chat_messages`
5. **RAG retrieval** (language-agnostic): Embed the user query → query `ai_knowledge_chunks` for top-k similar chunks via pgvector cosine similarity. Searches ALL documents regardless of language.
6. Build messages array: system prompt + language instruction ("Respond in {current_language}.") + RAG context + conversation history (last N messages)
7. Call the configured LLM API (OpenAI-compatible endpoint) with streaming
8. Stream response back to client via Server-Sent Events (SSE)
9. Store complete assistant response in `ai_chat_messages` with token count, RAG sources, and current language

**Language switch endpoint** (`POST /:secret_token/language`):

Called by the widget when the host page triggers `setLanguage()`. Updates the session's language. If the chat already has a greeting-only state (no user messages yet), the widget will immediately call `/chat` with a new greeting request in the new language.

Body: `{ sessionId: string, lang: string }`
Response: `{ ok: true, language: string }`

The `lang` parameter is validated against the assistant's `supported_languages`. If unsupported, falls back to `default_language`.

### Document Processing Pipeline

When a document is uploaded (`POST /:id/knowledge`):

1. Validate file type (PDF, TXT, MD, DOCX, CSV) and size against `max_upload_size_mb`
2. Store original file in a secure uploads directory
3. Create `ai_knowledge_base` row with status='processing'
4. **Async processing** (via a background job or simple async handler):
   - Extract text from the document (pdf-parse for PDFs, mammoth for DOCX, plain read for TXT/MD/CSV)
   - Split into chunks (~500 tokens each, with 50-token overlap)
   - Generate embeddings for each chunk via the configured embedding API
   - Insert chunks into `ai_knowledge_chunks` with their embeddings
   - Update `ai_knowledge_base` status to 'ready' with chunk_count
5. If any step fails, set status='error' with error_message

---

## Frontend Components

### New pages (admin)

| Page | Route | Description |
|---|---|---|
| `AiAssistantPage.tsx` | `/ai-assistant` | Paged list of all assistant configs |
| `AiAssistantViewPage.tsx` | `/ai-assistant/view/:id` | 3-tab view: Details / Knowledge Base / Beágyazás |
| `AiAssistantEditPage.tsx` | `/ai-assistant/edit/:id` | Edit form for assistant config |

### View page tabs (AiAssistantViewPage)

1. **Details tab**: Name, project, status, AI model, rate limits, branding preview
2. **Knowledge Base tab** (`AiKnowledgeBasePanel.tsx`): Upload documents, view/delete existing, status indicators
3. **Beágyazás tab** (`AiAssistantSnippetPanel.tsx`): Embeddable `<script>` snippet with copy button, origin warnings

### New components (`src/components/ai-assistant/`)

| Component | Description |
|---|---|
| `AiAssistantActions.tsx` | Row-level actions (view, edit, delete, enable/disable) |
| `AiAssistantConfigForm.tsx` | Create/edit form with all config fields |
| `AiAssistantViewShell.tsx` | Loading/error shell for the view page |
| `AiAssistantSnippetPanel.tsx` | Snippet display + copy (mirrors `AnalyticsSnippetPanel`) |
| `AiKnowledgeBasePanel.tsx` | Document upload + list + status management |
| `AiChatPreview.tsx` | Live preview of the chat widget (admin preview) |
| `ProjectAiAssistant.tsx` | Card on ProjectViewPage (mirrors `ProjectAnalytics`) |

### Portal pages (enduser)

| Page | Route | Description |
|---|---|---|
| `PortalAiAssistantPage.tsx` | `/portal/ai-assistant` | Read-only view: chat sessions list + knowledge base upload |

### Chat Widget (public embed)

A standalone JS file (served from the public embed route) that:

1. Creates a floating chat button on the host page
2. Opens a chat panel (shadow DOM for style isolation) on click
3. Fetches config from `/:secret_token/config` for theme/name/language pack
4. Sends messages via `POST /:secret_token/chat` with SSE streaming, including the detected `lang` parameter
5. Displays streaming responses in real-time
6. Shows copyright: `Powered by <a href="https://zsoltberta.hu">Zsolt Berta</a>`
7. Respects the configured position (bottom-right/bottom-left)

**Language detection order**:
1. `data-lang` attribute on the `<script>` tag (explicit override: `<script src="..." data-lang="hu">`)
2. `<html lang="...">` attribute on the host page
3. `navigator.language` / `navigator.languages[0]`
4. Fallback to the assistant's `default_language`

**Widget appearance**: Modern chat bubble similar to Intercom/Drift. Customizable:
- Primary color (button + header background)
- Secondary color (text/bg)
- Display name (header title, language-specific if translation exists)
- Greeting message (initial bot message, language-specific)
- Position on screen
- Placeholder text in the input field ("Type a message..." localized per language)

### ProjectViewPage integration

Add `<ProjectAiAssistant projectId={project.id} />` between `<ProjectAnalytics>` and `<ProjectPayments>`, following the exact pattern of `ProjectAnalytics`.

### EnduserSidebar integration

Add AI Assistant link (visible when the project has an assistant config):

```tsx
const { data: aiData } = useQuery({
  queryKey: ["portal", "sidebar-has-ai-assistant", projectId],
  queryFn: () => getAllAiAssistantConfigsPaged({ projectId: projectId!, page: 0, size: 1 }),
  enabled: !!projectId,
});
const hasAiAssistant = (aiData?.totalElements ?? 0) > 0;

{hasAiAssistant && (
  <NavLink to="/portal/ai-assistant" onClick={() => onClose?.()} className={linkClass}>
    <Bot className="h-4 w-4" />
    <span>{t("navigation:ai_assistant")}</span>
  </NavLink>
)}
```

### Admin Sidebar

Add AI Assistant nav link under the existing nav items (after Analytics):

```tsx
<NavLink to="/ai-assistant" onClick={() => onClose?.()} className={linkClass}>
  <Bot className="h-4 w-4" />
  <span>{t("navigation:ai_assistant")}</span>
</NavLink>
```

### Frontend routing (App.tsx)

```tsx
// Admin routes
<Route path="/ai-assistant" element={<AiAssistantPage />} />
<Route path="/ai-assistant/view/:id" element={<AiAssistantViewPage />} />
<Route path="/ai-assistant/edit/:id" element={<AiAssistantEditPage />} />

// Portal routes (inside EnduserPortal)
<Route path="ai-assistant" element={<PortalAiAssistantPage />} />
```

---

## Frontend Types

### AiAssistantUpdateDTO

```typescript
export interface AiAssistantUpdateDTO {
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;                      // only sent when changing
  basePrompt?: string;
  aiConfigPresetId?: number | null;
  displayName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  avatarUrl?: string | null;
  position?: "bottom-right" | "bottom-left";
  allowedOrigins?: string[];
  rateLimitBurst?: number;
  rateLimitSustained?: number;
  status?: AiAssistantStatus;
  // Multilanguage
  defaultLanguage?: string;
  supportedLanguages?: string[];
  translations?: AiAssistantTranslationUpdate[];
}

export interface AiAssistantTranslationUpdate {
  id?: number;                          // existing translation to update (omit to create new)
  language: string;
  displayName?: string | null;
  greetingMessage?: string | null;
  placeholder?: string | null;           // input placeholder text for this language
  _delete?: boolean;                    // flag to remove a translation
}
```

### AiKnowledgeBaseDocument

```typescript
export interface AiKnowledgeBaseDocument {
  id: number;
  assistantId: number;
  filename: string;
  originalFilename: string;
  fileType: string;
  fileSizeBytes: number;
  status: "processing" | "ready" | "error";
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}
```

### AiConfigPreset

```typescript
export interface AiConfigPreset {
  id: number;
  userId: number;
  name: string;
  model: string;
  baseUrl: string;
  basePrompt: string;
  createdAt: string;
  updatedAt: string;
}
```

### AiChatSession

```typescript
export interface AiChatSession {
  id: number;
  assistantId: number;
  sessionId: string;
  visitorId: string | null;
  language: string;                     // detected language for this session
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}
```

### AiChatMessage

```typescript
export interface AiChatMessage {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  content: string;
  language: string;                     // language used for this message
  tokensUsed: number;
  ragSources: Array<{
    documentId: number;
    filename: string;
    chunkContent: string;
  }> | null;
  createdAt: string;
}
```

---

## Security

### Same security model as analytics

- **Secret token**: 22-char base64url (16 random bytes, 128-bit entropy), server-generated, immutable
- **Origin allowlist**: same wildcard/exact-match semantics as forms/analytics; empty = open
- **Rate limiting**: per-IP burst + sustained, configurable per assistant via `rate_limit_burst` and `rate_limit_sustained`
- **404 masking**: unknown token, disabled config, and origin mismatch all return identical 404

### API key encryption

- API keys stored as `api_key_enc` using AES-256-GCM encryption at rest
- Encryption key derived from a server-side env var (`AI_ASSISTANT_ENCRYPTION_KEY`)
- Decrypted only at the point of use (when calling the LLM API)
- Never returned in API responses

### Chat endpoint additional protections

- Max message length: 2000 characters
- Max conversation history sent to LLM: last 20 messages (prevents context overflow)
- Max RAG context chunks: top 5 per query
- Response timeout: 30 seconds (LLM call)
- SSE streaming with heartbeat every 15 seconds to prevent timeouts

### File upload protections

- Whitelist of allowed MIME types: `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- File size limit per assistant (configurable, default 20MB)
- Virus scan integration placeholder (future: ClamAV or similar)
- Files stored outside the web root with randomized filenames

---

## i18n Keys

### `src/i18n/en/ai-assistant.json`

```json
{
  "ai_assistant_management": "AI Assistant Management",
  "ai_assistant_config": "AI Assistant Configuration",
  "create_ai_assistant": "Create AI Assistant",
  "edit_ai_assistant": "Edit AI Assistant",
  "ai_assistant_details": "AI Assistant Details",
  "ai_assistant_not_found": "AI Assistant not found",
  "back_to_ai_assistant": "Back to AI Assistants",
  "name": "Name",
  "name_placeholder": "e.g. Customer Support Bot",
  "name_help": "A human-readable label for this assistant",
  "project": "Project",
  "project_immutable_tooltip": "Project cannot be changed after creation",
  "secret_token": "Secret Token",
  "secret_token_copied": "Secret token copied to clipboard",
  "secret_token_immutable_tooltip": "Secret token is auto-generated and immutable",
  "secret_token_help": "This token identifies your assistant. Include it in the embed URL.",
  "status": "Status",
  "status_active": "Active",
  "status_disabled": "Disabled",
  "action_enable": "Enable",
  "action_disable": "Disable",
  "enable_confirm_title": "Enable AI Assistant?",
  "enable_confirm_description": "This will make the AI assistant available on the host page.",
  "disable_confirm_title": "Disable AI Assistant?",
  "disable_confirm_description": "This will take the AI assistant offline. Existing chat sessions will be interrupted.",
  "confirm_delete_title": "Delete AI Assistant?",
  "confirm_delete_description": "This will permanently delete this AI assistant, its knowledge base, and all chat history. This action cannot be undone.",
  "details_tab": "Details",
  "knowledge_tab": "Knowledge Base",
  "snippet_tab": "Beágyazás",
  "config_section_ai_assistant_title": "AI Assistant",
  "config_section_ai_assistant_empty": "No AI assistant configured for this project yet.",
  "config_section_create_ai_assistant": "Enable AI Assistant",
  "config_section_no_project": "Select a project to manage AI assistant.",
  "allowed_origins_label": "Allowed Origins",
  "allowed_origins_help": "Domains allowed to embed this assistant. Leave empty for unrestricted.",
  "allowed_origins_placeholder": "https://example.com",
  "allowed_origins_add": "Add Origin",
  "allowed_origins_none": "No origin restrictions",
  "snippet_title": "Embed Code",
  "snippet_description": "Copy this snippet and paste it into your website's HTML",
  "copy_snippet": "Copy Snippet",
  "snippet_copied": "Snippet copied to clipboard",
  "snippet_help": "Place this snippet before the closing </body> tag on your website.",
  "ai_config_section": "AI Configuration",
  "model": "Model",
  "base_url": "API Base URL",
  "api_key": "API Key",
  "api_key_help": "Your API key for the AI provider",
  "base_prompt": "System Prompt",
  "base_prompt_help": "Instructions that define the assistant's behavior",
  "branding_section": "Widget Branding",
  "display_name": "Display Name",
  "display_name_help": "Name shown in the chat widget header",
  "primary_color": "Primary Color",
  "secondary_color": "Secondary Color",
  "greeting_message": "Greeting Message",
  "greeting_message_help": "First message the assistant sends when a chat starts",
  "position": "Widget Position",
  "position_bottom_right": "Bottom Right",
  "position_bottom_left": "Bottom Left",
  "security_section": "Security & Rate Limits",
  "rate_limit_burst": "Burst Limit (per minute)",
  "rate_limit_sustained": "Sustained Limit (per day)",
  "max_upload_size": "Max Upload Size (MB)",
  "language_section": "Language & Localization",
  "default_language": "Default Language",
  "default_language_help": "Initial language when the widget first loads. The landing page can override this via JavaScript.",
  "supported_languages": "Supported Languages",
  "supported_languages_help": "Languages this assistant has UI translations for. The landing page can switch the widget language via JavaScript.",
  "translations": "UI Translations",
  "translations_help": "Customize the display name, greeting, and placeholder text per language. These are the UI texts the widget shows. Without an override, the default values are used.",
  "add_translation": "Add Language",
  "translation_language": "Language",
  "translation_display_name": "Display Name",
  "translation_greeting": "Greeting Message",
  "translation_placeholder": "Input Placeholder",
  "translation_delete": "Remove",
  "knowledge_base_title": "Knowledge Base",
  "knowledge_base_description": "Upload documents to give your AI assistant context. Supported formats: PDF, TXT, Markdown, DOCX, CSV.",
  "upload_documents": "Upload Documents",
  "upload_progress": "Processing...",
  "upload_ready": "Ready",
  "upload_error": "Error",
  "upload_chunks": "chunks",
  "delete_document": "Delete",
  "delete_document_confirm": "Delete this document and all its chunks?",
  "preset_section": "AI Config Presets",
  "preset_save": "Save as Preset",
  "preset_load": "Load Preset",
  "preset_name": "Preset Name",
  "ai_assistant_stats_title": "Chat Statistics"
}
```

### `src/i18n/hu/ai-assistant.json`

Hungarian translations following the same pattern.

### `src/i18n/{en,hu}/navigation.json`

Add: `"ai_assistant": "AI Assistant"` / `"ai_assistant": "AI Asszisztens"`

---

## Migration files

1. `0024_add_ai_assistant.sql` — All new tables (ai_assistant_configs, ai_config_presets, ai_knowledge_base, ai_knowledge_chunks, ai_chat_sessions, ai_chat_messages), pgvector extension, indexes, triggers
2. No modifications to existing migrations

---

## File inventory (new files to create)

### Backend
- `db/migrations/0024_add_ai_assistant.sql`
- `routes/ai-assistant.js`
- `routes/ai-assistant-embed.js`
- `routes/ai-config-presets.js`
- `lib/ai-knowledge-processor.js` (text extraction + chunking + embedding)
- `lib/ai-llm-client.js` (OpenAI-compatible streaming client)
- `lib/vector-search.js` (pgvector similarity search)

### Frontend types + lib
- `src/types/ai-assistant.ts`
- `src/lib/ai-assistant.ts`
- `src/lib/ai-config-presets.ts`

### Frontend pages
- `src/pages/AiAssistantPage.tsx`
- `src/pages/AiAssistantViewPage.tsx`
- `src/pages/AiAssistantEditPage.tsx`
- `src/pages/PortalAiAssistantPage.tsx`

### Frontend components
- `src/components/ai-assistant/AiAssistantActions.tsx`
- `src/components/ai-assistant/AiAssistantConfigForm.tsx`
- `src/components/ai-assistant/AiAssistantViewShell.tsx`
- `src/components/ai-assistant/AiAssistantSnippetPanel.tsx`
- `src/components/ai-assistant/AiKnowledgeBasePanel.tsx`
- `src/components/ai-assistant/AiChatPreview.tsx`
- `src/components/ai-assistant/ProjectAiAssistant.tsx`
- `src/components/ai-assistant/AiLanguageConfig.tsx` (language selector + translations editor)

### i18n
- `src/i18n/en/ai-assistant.json`
- `src/i18n/hu/ai-assistant.json`

### Chat widget
- `public/ai-assistant-widget.js` (standalone, served via the embed route)

### Tests
- `scripts/ai-assistant-smoke.mjs`

### Documentation
- This plan file

---

## Files to modify

| File | Change |
|---|---|
| `server.js` | Import + mount `aiAssistantRouter` at `/api/ai-assistant`, `aiAssistantEmbedRouter` at `/api/public/ai-assistant`, `aiConfigPresetsRouter` at `/api/ai-config-presets`, add CORS handler for `/api/public/ai-assistant` |
| `src/components/Sidebar.tsx` | Add AI Assistant link to admin sidebar + enduser sidebar (with query check) |
| `src/pages/ProjectViewPage.tsx` | Add `<ProjectAiAssistant>` component |
| `src/App.tsx` | Add admin routes + portal route |
| `src/i18n/en/navigation.json` | Add `ai_assistant` key |
| `src/i18n/hu/navigation.json` | Add `ai_assistant` key |
| `src/pages/PortalIndexRedirect.tsx` | Add AI assistant feature detection + redirect fallback |

---

## Implementation phases

### Phase 1: Core infrastructure
1. Database migration (all tables + pgvector extension)
2. Backend admin CRUD routes (`routes/ai-assistant.js`)
3. Frontend types, lib, pages (list/view/edit)
4. Snippet panel (Beágyazás tab)
5. ProjectViewPage integration
6. Sidebar + routing integration
7. i18n files

### Phase 2: AI config presets
1. DB table already in Phase 1 migration
2. Backend CRUD routes (`routes/ai-config-presets.js`)
3. Frontend preset selector in config form

### Phase 2.5: Multilanguage support
1. `ai_assistant_translations` table (already in Phase 1 migration)
2. Widget JS: initial language from `default_language`, detect from `<html lang>` if available
3. Widget JS: expose `window.__aiAssistant.setLanguage(lang)` API + CustomEvent listener + MutationObserver on `data-lang`
4. Widget JS: on language change, swap UI texts and send greeting or system message in new language
5. Backend: `POST /:secret_token/language` endpoint to update session language
6. Backend: inject "Respond in {language}" into system prompt on every chat request
7. Per-language translations editor in config form (`AiLanguageConfig` component)

### Phase 3: Knowledge base
1. Backend document upload + processing pipeline
2. Text extraction (pdf-parse, mammoth)
3. Chunking logic
4. Embedding generation
5. pgvector storage + indexing
6. Frontend `AiKnowledgeBasePanel` component
7. Upload UI with status tracking

### Phase 4: Chat + RAG
1. Backend chat endpoint with SSE streaming
2. RAG retrieval (embed query → pgvector search → context injection)
3. LLM client (OpenAI-compatible streaming)
4. Frontend chat widget JS (shadow DOM, streaming display)
5. Copyright text + branding
6. Conversation history management

### Phase 5: Security hardening
1. API key encryption at rest
2. Rate limit configuration per assistant
3. Origin allowlist enforcement
4. File upload validation + size limits
5. Message length limits + conversation truncation

---

## Key design decisions

1. **pgvector over separate vector DB**: No new infrastructure. The existing Postgres handles it. IVFFlat indexing is sufficient for the expected scale (thousands of chunks per assistant, not millions).

2. **SSE streaming over WebSocket**: Simpler implementation, no connection state management, works with the existing CORS/CSRF model, and matches the analytics pattern of stateless public endpoints.

3. **Shadow DOM for the chat widget**: Style isolation from the host page. The widget's CSS can't leak into the host page and vice versa. This is critical for a reliable embed.

4. **Server-side API key encryption**: Even if the database is compromised, API keys are safe. The encryption key is an env var, not in the DB.

5. **Lazy config creation**: Like analytics, the assistant config is created on first access from the project view, not via a separate "create" page.

6. **One assistant per project (MVP)**: The UNIQUE FK on project_id enforces this. Future: relax to allow multiple assistants per project (e.g., different bots for different pages).

7. **Streaming via the BE**: The client sends the message to our server, our server calls the LLM and streams back. The API key never reaches the client. This is the only secure approach.

8. **Language-agnostic RAG, widget-side language switching**: The knowledge base has no language tags. RAG searches ALL documents regardless of language. Language switching is entirely a widget-side concern: the landing page calls `window.__aiAssistant.setLanguage('en')` (or dispatches a CustomEvent), the widget swaps its UI texts (greeting, placeholder, header name) from the translations table, and sends the new language to the server so subsequent AI responses are in that language. This keeps the CRM simple (no language selection on upload) while giving full multilanguage control to the landing page.
