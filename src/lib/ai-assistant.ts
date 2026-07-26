// FE lib for the AI Assistant module. Mirrors src/lib/analytics.ts shape.
// All calls go through apiFetch (auth, CSRF, JSON encoding handled).

import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AiAssistantConfigDTO,
  AiAssistantUpdateDTO,
  AiAssistantSnippetResponse,
  AiKnowledgeBaseDocument,
  AiChatSessionDTO,
  AiChatMessageDTO,
} from "@/types/ai-assistant";

export type PageAiAssistantConfigDTO = Page<AiAssistantConfigDTO>;

export interface GetAllAiAssistantConfigsParams extends QueryParams {
  projectId?: number;
}

export const getAllAiAssistantConfigsPaged = (
  params: GetAllAiAssistantConfigsParams = {},
): Promise<PageAiAssistantConfigDTO> => {
  return apiFetch<PageAiAssistantConfigDTO>(
    `/ai-assistant?${buildQueryString(params)}`,
  );
};

export const getAiAssistantConfigById = (
  id: number,
): Promise<AiAssistantConfigDTO> => {
  return apiFetch<AiAssistantConfigDTO>(`/ai-assistant/${id}`);
};

export const getOrCreateAiAssistantConfigByProject = (
  projectId: number,
): Promise<AiAssistantConfigDTO> => {
  return apiFetch<AiAssistantConfigDTO>(
    `/ai-assistant/by-project/${projectId}`,
  );
};

export const updateAiAssistantConfig = (
  id: number,
  data: AiAssistantUpdateDTO,
): Promise<AiAssistantConfigDTO> => {
  return apiFetch<AiAssistantConfigDTO>(`/ai-assistant/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteAiAssistantConfig = (id: number): Promise<void> => {
  return apiFetch<void>(`/ai-assistant/${id}`, { method: "DELETE" });
};

export const getAiAssistantSnippet = (
  id: number,
): Promise<AiAssistantSnippetResponse> => {
  return apiFetch<AiAssistantSnippetResponse>(`/ai-assistant/${id}/snippet`);
};

// Knowledge base
export const getKnowledgeBaseDocuments = (
  assistantId: number,
): Promise<AiKnowledgeBaseDocument[]> => {
  return apiFetch<AiKnowledgeBaseDocument[]>(
    `/ai-assistant/${assistantId}/knowledge`,
  );
};

export const uploadKnowledgeBaseDocument = async (
  assistantId: number,
  file: File,
): Promise<AiKnowledgeBaseDocument> => {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<AiKnowledgeBaseDocument>(
    `/ai-assistant/${assistantId}/knowledge`,
    {
      method: "POST",
      body: formData,
      // Don't set Content-Type — browser sets multipart boundary automatically
      headers: {},
    },
  );
};

export const deleteKnowledgeBaseDocument = (
  assistantId: number,
  docId: number,
): Promise<void> => {
  return apiFetch<void>(
    `/ai-assistant/${assistantId}/knowledge/${docId}`,
    { method: "DELETE" },
  );
};

// Chat sessions
export const getChatSessions = (
  assistantId: number,
  params: QueryParams = {},
): Promise<Page<AiChatSessionDTO>> => {
  return apiFetch<Page<AiChatSessionDTO>>(
    `/ai-assistant/${assistantId}/sessions?${buildQueryString(params)}`,
  );
};

export const getChatMessages = (
  assistantId: number,
  sessionId: string,
): Promise<AiChatMessageDTO[]> => {
  return apiFetch<AiChatMessageDTO[]>(
    `/ai-assistant/${assistantId}/sessions/${sessionId}/messages`,
  );
};

// Avatar upload
export const uploadAvatar = async (
  assistantId: number,
  file: File,
): Promise<{ avatarUrl: string }> => {
  const formData = new FormData();
  formData.append("file", file);
  return apiFetch<{ avatarUrl: string }>(
    `/ai-assistant/${assistantId}/avatar`,
    {
      method: "POST",
      body: formData,
      headers: {},
    },
  );
};

export const deleteAvatar = (assistantId: number): Promise<void> => {
  return apiFetch<void>(`/ai-assistant/${assistantId}/avatar`, {
    method: "DELETE",
  });
};
