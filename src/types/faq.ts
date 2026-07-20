// FAQ DTOs (admin). Mirrors the BE surface in routes/faq.js.

export type FaqItemStatus = "draft" | "published";

export interface FaqItemDTO {
  id: number;
  projectId: number;
  projectName: string;
  question: string;
  answer: string;
  sortOrder: number;
  locale: string;
  status: FaqItemStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
}

export interface FaqItemCreateDTO {
  projectId: number;
  question: string;
  answer: string;
  sortOrder?: number;
  locale?: string;
  status?: FaqItemStatus;
}

export interface FaqItemUpdateDTO {
  question?: string;
  answer?: string;
  sortOrder?: number;
  status?: FaqItemStatus;
}

// Public read DTO (from routes/faq-public.js).
export interface PublicFaqItemDTO {
  question: string;
  answer: string;
  sortOrder: number;
}

export interface PublicFaqResponse {
  items: PublicFaqItemDTO[];
}
