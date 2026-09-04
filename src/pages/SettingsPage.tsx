import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { showSuccess, showError } from "@/utils/toast";
import { apiFetch } from "@/lib/api";

const SettingsPage: React.FC = () => {
  const { t } = useTranslation(["settings", "common"]);
  const [workerEmail, setWorkerEmail] = useState(true);
  const [workerPush, setWorkerPush] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const { settings } = await apiFetch<{ settings: Record<string, boolean> }>("/settings");
        setWorkerEmail(settings.worker_email_notifications !== false);
        setWorkerPush(settings.worker_push_notifications !== false);
      } catch {
        showError(t("settings:save_error"));
      } finally {
        setIsLoading(false);
      }
    };
    load();
  }, [t]);

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

  return (
    <div className="mx-auto w-full max-w-2xl">
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
