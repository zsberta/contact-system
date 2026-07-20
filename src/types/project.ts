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
  // Landing integration — see migration 0017 and lib/landing-rebuild.js.
  // A project may opt out of the blog/landing integration entirely by
  // leaving landingEnabled=false and landingRepoDir=null.
  landingRepoDir: string | null;
  landingBuildCommand: string;
  landingBuildEnv: Record<string, string | number | boolean>;
  landingDistPath: string | null;
  landingEnabled: boolean;
  landingLastBuildAt: string | null;
  landingLastBuildStatus: "success" | "failed" | null;
  landingLastBuildLog: string | null;
  // Brand color in HSL space (e.g. "212 73% 18%"). Used for blog
  // post theming and landing page accent colors.
  brandColor: string | null;
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
  // Landing integration (optional — projects without a landing site
  // can leave these unset).
  landingRepoDir?: string | null;
  landingBuildCommand?: string;
  landingBuildEnv?: Record<string, string | number | boolean>;
  landingDistPath?: string | null;
  landingEnabled?: boolean;
  brandColor?: string | null;
}

export type PageProjectDTO = Page<ProjectDTO>;