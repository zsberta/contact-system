import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { BellRing, Loader2 } from "lucide-react";
import { showSuccess, showError } from "@/utils/toast";
import { apiFetch } from "@/lib/api";

// Admin-only notification categories (must stay in sync with
// backend/src/push.rs ALL_ADMIN_CATEGORIES + admin_category_for_type).
const ALL_ADMIN_TYPES = [
  "bookings",
  "form_submissions",
  "payments",
  "system_errors",
] as const;

type AdminNotificationType = (typeof ALL_ADMIN_TYPES)[number];

const SETTINGS_KEY_BY_TYPE: Record<AdminNotificationType, { title: string; desc: string }> = {
  bookings: {
    title: "settings:admin_notifications_bookings",
    desc: "settings:admin_notifications_bookings_desc",
  },
  form_submissions: {
    title: "settings:admin_notifications_form_submissions",
    desc: "settings:admin_notifications_form_submissions_desc",
  },
  payments: {
    title: "settings:admin_notifications_payments",
    desc: "settings:admin_notifications_payments_desc",
  },
  system_errors: {
    title: "settings:admin_notifications_system_errors",
    desc: "settings:admin_notifications_system_errors_desc",
  },
};

function parseAdminTypes(raw: unknown): AdminNotificationType[] {
  if (Array.isArray(raw)) {
    const known = new Set<string>(ALL_ADMIN_TYPES);
    const parsed = (raw as unknown[]).filter(
      (v): v is AdminNotificationType => typeof v === "string" && known.has(v),
    );
    return [...new Set(parsed)];
  }
  // Missing / unexpected shape → all enabled (preserves current behaviour).
  return [...ALL_ADMIN_TYPES];
}

// NOTE: this route is mounted under <ProtectedRoute roles={["admin"]}> and
// the /api/settings endpoints enforce require_admin — endusers never reach
// this UI nor the underlying API.
const SettingsPage: React.FC = () => {
  const { t } = useTranslation(["settings", "common"]);
  const [workerEmail, setWorkerEmail] = useState(true);
  const [workerPush, setWorkerPush] = useState(true);
  const [adminTypes, setAdminTypes] = useState<AdminNotificationType[]>([...ALL_ADMIN_TYPES]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const { settings } = await apiFetch<{ settings: Record<string, unknown> }>("/settings");
        setWorkerEmail(settings.worker_email_notifications !== false);
        setWorkerPush(settings.worker_push_notifications !== false);
        setAdminTypes(parseAdminTypes(settings.admin_notification_types));
      } catch {
        showError(t("settings:save_error"));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [t]);

  const toggleAdminType = (type: AdminNotificationType) => {
    setAdminTypes((prev) =>
      prev.includes(type) ? prev.filter((v) => v !== type) : [...prev, type],
    );
  };

  const selectAllAdmin = () => setAdminTypes([...ALL_ADMIN_TYPES]);
  const clearAdmin = () => setAdminTypes([]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await apiFetch("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: {
            worker_email_notifications: workerEmail,
            worker_push_notifications: workerPush,
            admin_notification_types: adminTypes,
          },
        }),
      });
      showSuccess(t("settings:save_success"));
    } catch {
      showError(t("settings:save_error"));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <CardContent className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const allSelected = adminTypes.length === ALL_ADMIN_TYPES.length;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-2xl font-bold">{t("settings:title")}</CardTitle>
          <CardDescription>{t("settings:description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Worker Email Notifications */}
          <div className="flex items-center justify-between space-x-4">
            <div className="flex-1 space-y-1">
              <Label className="text-sm font-medium">{t("settings:worker_email_notifications")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("settings:worker_email_notifications_desc")}
              </p>
            </div>
            <Switch
              checked={workerEmail}
              onCheckedChange={setWorkerEmail}
            />
          </div>

          <div className="h-px bg-border" />

          {/* Worker Push Notifications */}
          <div className="flex items-center justify-between space-x-4">
            <div className="flex-1 space-y-1">
              <Label className="text-sm font-medium">{t("settings:worker_push_notifications")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("settings:worker_push_notifications_desc")}
              </p>
            </div>
            <Switch
              checked={workerPush}
              onCheckedChange={setWorkerPush}
            />
          </div>
        </CardContent>
      </Card>

      {/* Admin notification type multiselector — admins only */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-muted-foreground" />
            <CardTitle className="text-lg font-bold">{t("settings:admin_notifications_title")}</CardTitle>
            <Badge variant="secondary">{t("settings:admin_only_badge")}</Badge>
          </div>
          <CardDescription>{t("settings:admin_notifications_desc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ALL_ADMIN_TYPES.map((type) => {
            const checked = adminTypes.includes(type);
            return (
              <label
                key={type}
                className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer hover:bg-muted/50 transition-colors"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggleAdminType(type)}
                  className="mt-0.5"
                  aria-label={t(SETTINGS_KEY_BY_TYPE[type].title)}
                />
                <span className="flex-1 space-y-1">
                  <span className="block text-sm font-medium">
                    {t(SETTINGS_KEY_BY_TYPE[type].title)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(SETTINGS_KEY_BY_TYPE[type].desc)}
                  </span>
                </span>
              </label>
            );
          })}

          {adminTypes.length === 0 && (
            <p className="text-xs text-destructive">
              {t("settings:admin_notifications_none_warning")}
            </p>
          )}

          <div className="flex items-center justify-between pt-1">
            <p className="text-xs text-muted-foreground">
              {t("settings:admin_notifications_selected", {
                count: adminTypes.length,
                total: ALL_ADMIN_TYPES.length,
              })}
            </p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={selectAllAdmin} disabled={allSelected}>
                {t("settings:admin_notifications_select_all")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAdmin}
                disabled={adminTypes.length === 0}
              >
                {t("settings:admin_notifications_clear")}
              </Button>
            </div>
          </div>

          {/* Save button */}
          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  {t("common:saving")}
                </>
              ) : (
                t("settings:save")
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
};

export default SettingsPage;
