// ----------------------------------------------------------------------------
// AnalyticsConfigForm — shared create/edit form. For analytics, "create"
// is never used directly: the lazy GET /by-project/:id endpoint creates
// the row on demand, so the FE only ever edits an existing config.
// The component is still typed to support both modes for symmetry with
// the forms module — if a future iteration adds a dedicated create
// wizard, the form is already shaped for it.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Copy, ClipboardCheck, Globe, Lock, Trash2 } from "lucide-react";
import type {
  AnalyticsConfigDTO,
  AnalyticsConfigUpdateDTO,
  AnalyticsStatus,
} from "@/types/analytics";
import { showError, showSuccess } from "@/utils/toast";

interface AnalyticsConfigFormValues {
  name: string;
  status: AnalyticsStatus;
}

interface AnalyticsConfigFormProps {
  initialData: AnalyticsConfigDTO;
  isSubmitting: boolean;
  onSubmit: (data: AnalyticsConfigUpdateDTO) => void;
}

const STATUS_OPTIONS: AnalyticsStatus[] = ["active", "disabled"];

const AnalyticsConfigForm = ({
  initialData,
  isSubmitting,
  onSubmit,
}: AnalyticsConfigFormProps) => {
  const { t } = useTranslation(["analytics", "common"]);

  const formSchema = z.object({
    name: z
      .string()
      .min(1, { message: "analytics:required_field" })
      .max(200, { message: "analytics:max_length" }),
    status: z.enum(["active", "disabled"]),
  });

  const form = useForm<AnalyticsConfigFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialData.name,
      status: initialData.status,
    },
  });

  // Lifted state for the allowed-origins list.
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    if (Array.isArray(initialData.allowedOrigins)) {
      return initialData.allowedOrigins.filter((d) => typeof d === "string");
    }
    return [];
  });

  const handleSubmit = (values: AnalyticsConfigFormValues) => {
    const cleanedOrigins = allowedOrigins
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
    const payload: AnalyticsConfigUpdateDTO = {
      name: values.name.trim(),
      status: values.status,
      allowedOrigins: cleanedOrigins,
    };
    onSubmit(payload);
  };

  const copySecretToken = async () => {
    if (!initialData.secretToken) return;
    const token = initialData.secretToken;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
        showSuccess(t("analytics:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("analytics:secret_token_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
    }
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="max-w-2xl mx-auto space-y-6 w-full"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              {t("analytics:edit_analytics")}
            </CardTitle>
            <CardDescription>{initialData.name}</CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Project (read-only — the analytics row is keyed to a project) */}
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                {t("analytics:project")}
              </FormLabel>
              <FormControl>
                <Input
                  readOnly
                  value={initialData.projectName ?? ""}
                  title={t("analytics:project_immutable_tooltip")}
                  aria-readonly
                  className="bg-muted"
                />
              </FormControl>
            </FormItem>

            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("analytics:name")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("analytics:name_placeholder")}
                      maxLength={200}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("analytics:name_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Secret token — read-only, copyable */}
            <FormItem>
              <FormLabel className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                {t("analytics:secret_token")}
              </FormLabel>
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={initialData.secretToken}
                  title={t("analytics:secret_token_immutable_tooltip")}
                  className="bg-muted font-mono text-xs"
                  aria-readonly
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={copySecretToken}
                  title={t("analytics:secret_token_immutable_tooltip")}
                  aria-label={t("analytics:secret_token")}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <FormDescription>
                {t("analytics:secret_token_help")}
              </FormDescription>
              <span className="sr-only">
                <ClipboardCheck />
              </span>
            </FormItem>

            {/* Allowed origins */}
            <div className="space-y-2">
              <FormLabel className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t("analytics:allowed_origins_label")}
              </FormLabel>
              <FormDescription>
                {t("analytics:allowed_origins_help")}
              </FormDescription>
              <div className="space-y-2">
                {allowedOrigins.length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("analytics:allowed_origins_empty_warning")}
                  </p>
                )}
                {allowedOrigins.map((origin, index) => (
                  <div
                    key={`origin-${index}`}
                    className="flex items-center gap-2"
                  >
                    <Input
                      value={origin}
                      onChange={(e) => {
                        const next = [...allowedOrigins];
                        next[index] = e.target.value;
                        setAllowedOrigins(next);
                      }}
                      placeholder={t("analytics:allowed_origins_placeholder")}
                      maxLength={253}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      onClick={() => {
                        setAllowedOrigins(
                          allowedOrigins.filter((_, i) => i !== index),
                        );
                      }}
                      aria-label={t("analytics:allowed_origins_remove")}
                      title={t("analytics:allowed_origins_remove")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {allowedOrigins.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("analytics:allowed_origins_count", {
                      count: allowedOrigins.length,
                    })}
                  </p>
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAllowedOrigins([...allowedOrigins, ""])}
                >
                  {t("analytics:allowed_origins_add")}
                </Button>
              </div>
            </div>

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("analytics:status")}</FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(v) =>
                        field.onChange(v as AnalyticsStatus)
                      }
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={t("analytics:status_placeholder")}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {t(`analytics:status_${s}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => window.history.back()}
            disabled={isSubmitting}
          >
            {t("common:cancel")}
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? t("common:saving")
              : t("common:save")}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default AnalyticsConfigForm;
