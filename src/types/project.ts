import type { Page } from "./common";

export type ProjectStatus =
  | "under_construction"
  | "customer_paid"
  | "waiting_for_payment"
  | "notified_customer"
  | "have_to_notify"
  | "paid"
  | "cancelled"
  | "completed";

export type BillingPeriod = "monthly" | "yearly" | "one_off";

export interface ProjectDTO {
  id: number;
  name: string;
  domainAddress: string | null;
  price: number | null;
  fordulonap: string | null;
  billingPeriod: BillingPeriod | null;
  status: ProjectStatus;
  comment: string | null;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  createdAt: string;
  updatedAt: string;
  lastStatusChangeAt: string;
}

export interface ProjectAttachmentDTO {
  id: number;
  projectId: number;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface ProjectDetails extends ProjectDTO {
  attachments: ProjectAttachmentDTO[];
}

export interface ProjectCreateUpdateDTO {
  name: string;
  domainAddress?: string | null;
  price?: number | null;
  fordulonap?: string | null;
  billingPeriod?: BillingPeriod | null;
  status: ProjectStatus;
  comment?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
}

export type PageProjectDTO = Page<ProjectDTO>;