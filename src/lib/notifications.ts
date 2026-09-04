import { apiFetch } from "./api";
import type { NotificationsPage } from "@/types/notification";

export function getNotifications(cursor?: string, limit = 20): Promise<NotificationsPage> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  params.set("limit", String(limit));
  return apiFetch(`/notifications?${params}`);
}

export function getUnreadCount(since: string): Promise<{ count: number }> {
  return apiFetch(`/notifications/unread-count?since=${encodeURIComponent(since)}`);
}

export function markNotificationsOpened(): Promise<{ openedAt: string }> {
  return apiFetch("/notifications/opened", { method: "POST" });
}

export function subscribePush(subscription: PushSubscription, deviceName: string) {
  // Extract keys from the subscription
  const json = subscription.toJSON();
  const keys = json.keys as { p256dh: string; auth: string } | undefined;
  if (!keys) throw new Error("Missing subscription keys");

  return apiFetch("/notifications/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys,
      deviceName,
    }),
  });
}

export function unsubscribePush(endpoint: string) {
  return apiFetch("/notifications/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export function getVapidPublicKey(): Promise<{ publicKey: string }> {
  return apiFetch("/settings/vapid-public-key");
}
