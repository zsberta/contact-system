export type NotificationType = "BOOKING_CREATED" | "BOOKING_CANCELLED" | "SYSTEM";

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
