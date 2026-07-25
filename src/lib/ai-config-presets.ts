// FE lib for AI config presets. Mirrors the pattern of src/lib/ai-assistant.ts.

import { apiFetch, buildQueryString } from "@/lib/api";
import type { Page, QueryParams } from "@/types/common";
import type {
  AiConfigPresetDTO,
  AiConfigPresetCreateDTO,
  AiConfigPresetUpdateDTO,
} from "@/types/ai-assistant";

export type PageAiConfigPresetDTO = Page<AiConfigPresetDTO>;

export const getAllAiConfigPresetsPaged = (
  params: QueryParams = {},
): Promise<PageAiConfigPresetDTO> => {
  return apiFetch<PageAiConfigPresetDTO>(
    `/ai-config-presets?${buildQueryString(params)}`,
  );
};

export const getAiConfigPresetById = (
  id: number,
): Promise<AiConfigPresetDTO> => {
  return apiFetch<AiConfigPresetDTO>(`/ai-config-presets/${id}`);
};

export const createAiConfigPreset = (
  data: AiConfigPresetCreateDTO,
): Promise<AiConfigPresetDTO> => {
  return apiFetch<AiConfigPresetDTO>(`/ai-config-presets`, {
    method: "POST",
    body: JSON.stringify(data),
  });
};

export const updateAiConfigPreset = (
  id: number,
  data: AiConfigPresetUpdateDTO,
): Promise<AiConfigPresetDTO> => {
  return apiFetch<AiConfigPresetDTO>(`/ai-config-presets/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
};

export const deleteAiConfigPreset = (id: number): Promise<void> => {
  return apiFetch<void>(`/ai-config-presets/${id}`, { method: "DELETE" });
};
