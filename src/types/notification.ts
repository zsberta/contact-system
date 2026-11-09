export type NotificationType =
  | "BOOKING_CREATED"
  | "BOOKING_CANCELLED"
  | "GATEWAY_PAYMENT_PAID"
  | "GATEWAY_PAYMENT_FAILED"
  | "GATEWAY_PAYMENT_REFUNDED"
  | "FORM_SUBMISSION_CREATED"
  | "SYSTEM_ERROR"
  | "SYSTEM";

export interface Notification {
  id: number;
  userId: number;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationsPage {
  notifications: Notification[];
  nextCursor: string | null;
}
