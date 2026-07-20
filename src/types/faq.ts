// FAQ DTOs (admin). Mirrors the BE surface in routes/faq.js.

export type FaqItemStatus = "draft" | "published";

export interface FaqItemDTO {
  id: number;
  projectId: number;
  projectName: string;
  questionHu: string;
  answerHu: string;
  questionEn: string;
  answerEn: string;
  sortOrder: number;
  status: FaqItemStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
}

export interface FaqItemCreateDTO {
  projectId: number;
  questionHu: string;
  answerHu: string;
  questionEn?: string;
  answerEn?: string;
  sortOrder?: number;
  status?: FaqItemStatus;
}

export interface FaqItemUpdateDTO {
  questionHu?: string;
  answerHu?: string;
  questionEn?: string;
  answerEn?: string;
  sortOrder?: number;
  status?: FaqItemStatus;
}

// Public read DTO (from routes/faq-public.js).
export interface PublicFaqItemDTO {
  question: string;
  answer: string;
  sortOrder: number;
}

// Public response — flat array of items for the requested locale.
export interface PublicFaqResponse {
  items: PublicFaqItemDTO[];
}
