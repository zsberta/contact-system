// Service DTOs (admin). Mirrors the BE surface in routes/service.js.

export type ServiceItemStatus = "draft" | "published";

export interface ServiceItemDTO {
  id: number;
  projectId: number;
  projectName: string;
  titleHu: string;
  titleEn: string;
  descriptionHu: string;
  descriptionEn: string;
  priceHu: string;
  priceEn: string;
  sortOrder: number;
  status: ServiceItemStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: number | null;
}

export interface ServiceItemCreateDTO {
  projectId: number;
  titleHu: string;
  titleEn?: string;
  descriptionHu?: string;
  descriptionEn?: string;
  priceHu?: string;
  priceEn?: string;
  sortOrder?: number;
  status?: ServiceItemStatus;
}

export interface ServiceItemUpdateDTO {
  titleHu?: string;
  titleEn?: string;
  descriptionHu?: string;
  descriptionEn?: string;
  priceHu?: string;
  priceEn?: string;
  sortOrder?: number;
  status?: ServiceItemStatus;
}

// Public read DTO (from routes/service-public.js).
export interface PublicServiceItemDTO {
  title: string;
  description: string;
  price: string;
  sortOrder: number;
}

// Public response — flat array of items for the requested locale.
export interface PublicServiceResponse {
  items: PublicServiceItemDTO[];
}
