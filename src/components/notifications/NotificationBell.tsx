import React, { useState, useEffect, useRef, useCallback } from "react";
import { Bell, Settings, Wifi, WifiOff } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslation } from "react-i18next";
import { format, formatDistanceToNow } from "date-fns";
import { hu, enUS } from "date-fns/locale";
import {
  getNotifications,
  getUnreadCount,
  markNotificationsOpened,
  subscribePush,
  unsubscribePush,
  getVapidPublicKey,
} from "@/lib/notifications";
import { urlBase64ToUint8Array } from "@/lib/vapid";
import type { Notification } from "@/types/notification";

const STORAGE_KEY = "nexus_notifications_last_opened";

export const NotificationBell: React.FC = () => {
  const { t, i18n } = useTranslation(["notifications"]);
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);

  // Push subscription state
  const [pushSupported, setPushSupported] = useState(false);
  const [pushPermission, setPushPermission] = useState<NotificationPermission>("default");
  const [isPushSubscribed, setIsPushSubscribed] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);

  const nextCursorRef = useRef<string | null>(null);
  const loadMoreRef = useRef<() => void>(() => {});
  const dateFnsLocale = i18n.language === "hu" ? hu : enUS;

  // ── Fetch initial notifications ──────────────────────────────────────────
  const fetchInitial = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await getNotifications(undefined, 20);
      setNotifications(data.notifications);
      setNextCursor(data.nextCursor);
      nextCursorRef.current = data.nextCursor;

      const lastOpened = localStorage.getItem(STORAGE_KEY);
      if (lastOpened) {
        const { count } = await getUnreadCount(lastOpened);
        setHasUnread(count > 0);
      } else {
        setHasUnread(data.notifications.length > 0);
      }
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ── Load more — stored in ref to avoid stale closure ─────────────────────
  loadMoreRef.current = useCallback(async () => {
    if (!nextCursorRef.current || isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const data = await getNotifications(nextCursorRef.current, 20);
      setNotifications((prev) => [...prev, ...data.notifications]);
      setNextCursor(data.nextCursor);
      nextCursorRef.current = data.nextCursor;
    } catch {
      // silently fail
    } finally {
      setIsLoadingMore(false);
    }
  }, [isLoadingMore]);

  // ── Scroll handler for infinite scroll ───────────────────────────────────
  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const target = event.target as HTMLDivElement;
      const { scrollTop, scrollHeight, clientHeight } = target;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < 100;

      if (isNearBottom && nextCursorRef.current && !isLoadingMore) {
        loadMoreRef.current();
      }
    },
    [isLoadingMore],
  );

  // ── Fetch on mount (for red dot without opening) ─────────────────────────
  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  // ── Check push support ───────────────────────────────────────────────────
  useEffect(() => {
    if ("serviceWorker" in navigator && "PushManager" in window) {
      setPushSupported(true);
      navigator.serviceWorker.ready.then((reg) => {
        reg.pushManager.getSubscription().then((sub) => {
          setIsPushSubscribed(!!sub);
        });
      });
      setPushPermission(Notification.permission);
    }
  }, []);

  // ── Handle popover open ──────────────────────────────────────────────────
  const handleOpenChange = async (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      try {
        const { openedAt } = await markNotificationsOpened();
        localStorage.setItem(STORAGE_KEY, openedAt);
        setHasUnread(false);
      } catch {
        // still open the popover, just keep the dot
      }
      fetchInitial();
    }
  };

  // ── Push subscribe ───────────────────────────────────────────────────────
  const handleSubscribe = async () => {
    setPushLoading(true);
    try {
      const permission = await Notification.requestPermission();
      setPushPermission(permission);
      if (permission !== "granted") return;

      const reg = await navigator.serviceWorker.ready;
      const vapidRes = await getVapidPublicKey();
      if (!vapidRes.publicKey) return;

      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidRes.publicKey),
      });

      const deviceName =
        navigator.userAgentData?.platform || navigator.platform || "Unknown";
      await subscribePush(subscription, deviceName);
      setIsPushSubscribed(true);
    } catch (err) {
      console.error("[push] subscribe failed:", err);
    } finally {
      setPushLoading(false);
    }
  };

  // ── Push unsubscribe ─────────────────────────────────────────────────────
  const handleUnsubscribe = async () => {
    setPushLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePush(sub.endpoint);
        await sub.unsubscribe();
      }
      setIsPushSubscribed(false);
    } catch (err) {
      console.error("[push] unsubscribe failed:", err);
    } finally {
      setPushLoading(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative group">
          <Bell className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
          {hasUnread && (
            <span className="absolute top-1 right-1 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-destructive" />
          )}
          <span className="sr-only">{t("notifications:title")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[85vw] max-w-[380px] p-0 mt-2 border shadow-lg rounded-xl overflow-hidden"
        align="end" 

      >
        <div className="flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h3 className="font-semibold text-sm">{t("notifications:title")}</h3>
          </div>

          {/* Notification list — fixed height scrollable */}
          <div
            className="h-[400px] w-full overflow-y-auto"
            onScroll={handleScroll}
          >
            {isLoading ? (
              <div className="p-4 space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3">
                    <Skeleton className="h-8 w-8 rounded-full shrink-0" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                <Bell className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">{t("notifications:no_notifications")}</p>
              </div>
            ) : (
              <>
                {notifications.map((n) => {
                  const titleKey = n.type === "BOOKING_CREATED"
                    ? "notifications:booking_created"
                    : "notifications:system";
                  let displayMessage = n.message;
                  if (n.metadata?.customerName && n.metadata?.serviceName) {
                    const notifLocale = (n.metadata.locale as string) || "hu";
                    const notifTz = (n.metadata.timezone as string) || "UTC";
                    const dateStr = n.metadata.startsAt
                      ? new Intl.DateTimeFormat(notifLocale === "en" ? "en-GB" : "hu-HU", {
                          timeZone: notifTz,
                          year: "numeric",
                          month: "long",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }).format(new Date(n.metadata.startsAt as string))
                      : "";
                    displayMessage = t("notifications:booking_message", {
                      customerName: n.metadata.customerName as string,
                      serviceName: n.metadata.serviceName as string,
                      date: dateStr,
                    });
                  }
                  return (
                    <div
                      key={n.id}
                      className="flex gap-3 px-4 py-3 border-b last:border-b-0 hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-tight">{t(titleKey)}</p>
                        <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                          {displayMessage}
                        </p>
                        <p className="text-[10px] text-muted-foreground mt-1">
                          {formatDistanceToNow(new Date(n.createdAt), {
                            addSuffix: true,
                            locale: dateFnsLocale,
                          })}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {isLoadingMore && (
                  <div className="flex justify-center py-3">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
                  </div>
                )}
                {!nextCursor && notifications.length > 0 && (
                  <p className="text-center text-xs text-muted-foreground py-3">
                    —
                  </p>
                )}
              </>
            )}
          </div>

          {/* Push subscription section */}
          {pushSupported && (
            <div className="border-t px-4 py-3">
              {pushPermission === "denied" ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <WifiOff className="h-3 w-3" />
                  {t("notifications:push_blocked")}
                </p>
              ) : isPushSubscribed ? (
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Wifi className="h-3 w-3 text-green-500" />
                    {t("notifications:push_active")}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-muted-foreground"
                    onClick={handleUnsubscribe}
                    disabled={pushLoading}
                  >
                    {t("notifications:disable_push")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-8 text-xs"
                  onClick={handleSubscribe}
                  disabled={pushLoading}
                >
                  <Settings className="h-3 w-3 mr-1.5" />
                  {t("notifications:enable_push")}
                </Button>
              )}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
};
