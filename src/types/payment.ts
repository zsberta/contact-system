export type PaymentStatus = "pending" | "paid" | "overdue" | "cancelled";

export type PaymentPeriod = "monthly" | "yearly" | "one_off" | null;

export type PaymentOrigin = "auto" | "manual";

export interface PaymentDTO {
  id: number;
  projectId: number;
  amount: number | null;
  status: PaymentStatus;
  dueDate: string;
  period: PaymentPeriod;
  createdBy: PaymentOrigin;
  paidAt: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentCreateUpdateDTO {
  projectId: number;
  amount: number;
  dueDate: string;
  status?: PaymentStatus;
  period?: PaymentPeriod | null;
  createdBy?: PaymentOrigin;
  note?: string | null;
  paidAt?: string | null;
}

export interface PaymentAttachmentDTO {
  id: number;
  paymentId: number;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

export interface UpcomingPaymentDTO {
  paymentId: number;
  projectId: number;
  projectName: string;
  amount: number;
  dueDate: string;
  status: "pending" | "overdue";
  customerName: string | null;
}

export interface DashboardStatsDTO {
  revenue30d: number;
  revenue90d: number;
  revenue365d: number;
  outstanding: number;
  counts: {
    pending: number;
    overdue: number;
    paid: number;
    cancelled: number;
  };
  monthlyRevenue: Array<{ month: string; amount: number }>;
  upcomingPayments: UpcomingPaymentDTO[];
}import type { Page } from "./common";
export type PagePaymentDTO = Page<PaymentDTO>;
