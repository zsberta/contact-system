// AI Assistant DTOs. Mirrors the existing analytics/form type pattern.
// Keeps the FE DTO contract independent of the BE route file.

export type AiAssistantStatus = "active" | "disabled";

// Returned by GET /api/ai-assistant, GET /api/ai-assistant/:id,
// PUT /api/ai-assistant/:id, GET /api/ai-assistant/by-project/:projectId.
export interface AiAssistantConfigDTO {
  id: number;
  projectId: number;
  projectName: string;
  name: string;
  secretToken: string;
  status: AiAssistantStatus;

  // AI config
  aiConfigPresetId: number | null;
  model: string;
  baseUrl: string;
  basePrompt: string;

  // Branding
  displayName: string;
  primaryColor: string;
  secondaryColor: string;
  greetingMessage: string;
  legalMessage: string;
  avatarUrl: string | null;
  position: "bottom-right" | "bottom-left";

  // Multilanguage
  defaultLanguage: string;
  supportedLanguages: string[];

  // Security
  allowedOrigins: string[];
  rateLimitBurst: number;
  rateLimitSustained: number;
  maxUploadSizeMb: number;

  // Translations
  translations: AiAssistantTranslationDTO[];

  createdAt: string;
  updatedAt: string;
}

export interface AiAssistantTranslationDTO {
  id: number;
  assistantId: number;
  language: string;
  displayName: string | null;
  greetingMessage: string | null;
  placeholder: string | null;
  createdAt: string;
  updatedAt: string;
}

// PUT /api/ai-assistant/:id body.
export interface AiAssistantUpdateDTO {
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  basePrompt?: string;
  aiConfigPresetId?: number | null;
  displayName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  greetingMessage?: string;
  legalMessage?: string;
  avatarUrl?: string | null;
  position?: "bottom-right" | "bottom-left";
  allowedOrigins?: string[];
  rateLimitBurst?: number;
  rateLimitSustained?: number;
  maxUploadSizeMb?: number;
  status?: AiAssistantStatus;
  defaultLanguage?: string;
  supportedLanguages?: string[];
  translations?: AiAssistantTranslationUpdateDTO[];
}

export interface AiAssistantTranslationUpdateDTO {
  id?: number;
  language: string;
  displayName?: string | null;
  greetingMessage?: string | null;
  placeholder?: string | null;
  _delete?: boolean;
}

// Snippet response from GET /api/ai-assistant/:id/snippet.
export interface AiAssistantSnippetResponse {
  html: string;
  scriptUrl: string;
  secretToken: string;
  origin: string;
  defaultLanguage: string;
  allowedOrigins: string[];
}

// Knowledge base document
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

// Knowledge base document chunk (from GET /api/ai-assistant/:id/knowledge/:docId/chunks)
export interface AiKnowledgeChunk {
  id: number;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  createdAt: string;
}

export interface AiKnowledgeChunksResponse {
  document: {
    id: number;
    originalFilename: string;
    fileType: string;
    chunkCount: number;
    status: string;
  };
  chunks: AiKnowledgeChunk[];
}

// AI config preset
export interface AiConfigPresetDTO {
  id: number;
  userId: number;
  name: string;
  model: string;
  baseUrl: string;
  basePrompt: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiConfigPresetCreateDTO {
  name: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  basePrompt: string;
}

export interface AiConfigPresetUpdateDTO {
  name?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  basePrompt?: string;
}

// Chat session
export interface AiChatSessionDTO {
  id: number;
  assistantId: number;
  sessionId: string;
  visitorId: string | null;
  language: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

// Chat message
export interface AiChatMessageDTO {
  id: number;
  sessionId: number;
  role: "user" | "assistant" | "system";
  content: string;
  language: string;
  tokensUsed: number;
  ragSources: Array<{
    documentId: number;
    filename: string;
    chunkContent: string;
  }> | null;
  createdAt: string;
}
