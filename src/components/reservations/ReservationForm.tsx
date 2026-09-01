// ----------------------------------------------------------------------------
// ReservationForm — shared create/edit form for the Reservation entity.
//
// Pattern: RHF + zod, Controller-wrapped Selects, conditional fields.
//
// Differences vs. FormForm:
//   - Adds Extra fields enabled Switch
//   - Adds Embed title Input
//
// secretToken, slug, projectId behave exactly like the form module:
// immutable in edit mode; secretToken copy button is read-only with copy.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useForm, Controller, Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useTranslation } from "react-i18next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Copy, Clock,
  ClipboardCheck,
  Globe,
  Lock,
  Trash2,
  FilePen,
} from "lucide-react";
import type {
  ReservationCreateDTO,
  ReservationDTO,
  ReservationStatus,
  ReservationUpdateDTO,
} from "@/types/reservation";
import { FormProjectSelectorModal } from "@/components/forms/FormProjectSelectorModal";
import { showError, showSuccess } from "@/utils/toast";

interface ReservationFormValues {
  projectId: number | null;
  projectName: string;
  name: string;
  status: ReservationStatus;
  extraFieldsEnabled: boolean;
  embedTitle: string;
  brandColor: string;
  iframeWidth: string;
  iframeHeight: string;
  privacyPolicyUrl: string;
  cookiePolicyUrl: string;
}

interface ReservationFormProps {
  initialData?: ReservationDTO;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (data: ReservationCreateDTO | ReservationUpdateDTO) => void;
}

const STATUS_OPTIONS: ReservationStatus[] = ["active", "disabled"];


const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const TIMEZONE_OPTIONS = [
  "UTC",
  "Europe/Budapest",
  "Europe/Berlin",
  "Europe/London",
  "Europe/Paris",
  "Europe/Rome",
  "Europe/Vienna",
  "Europe/Warsaw",
  "Europe/Prague",
  "Europe/Bratislava",
  "Europe/Ljubljana",
  "Europe/Zagreb",
  "Europe/Belgrade",
  "Europe/Bucharest",
  "Europe/Sofia",
  "Europe/Athens",
  "Europe/Istanbul",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Australia/Sydney",
];

const ReservationForm = ({
  initialData,
  mode,
  isSubmitting,
  onSubmit,
}: ReservationFormProps) => {
  const { t } = useTranslation(["reservations", "common"]);

  const formSchema = z.object({
    projectId: z
      .number({ invalid_type_error: "reservations:project_required" })
      .int()
      .positive({ message: "reservations:project_required" }),
    projectName: z.string(),
    name: z
      .string()
      .min(1, { message: "reservations:required_field" })
      .max(200, { message: "reservations:max_length" }),
    status: z.enum(["active", "disabled"]),
    extraFieldsEnabled: z.boolean(),
    embedTitle: z.string().min(1),
    brandColor: z.string(),
    iframeWidth: z.string(),
    iframeHeight: z.string(),
    privacyPolicyUrl: z.string(),
    cookiePolicyUrl: z.string(),
  });

  const form = useForm<ReservationFormValues, unknown, ReservationFormValues>({
    resolver: zodResolver(formSchema) as Resolver<ReservationFormValues>,
    defaultValues: {
      projectId: initialData?.projectId ?? null,
      projectName: initialData?.projectName ?? "",
      name: initialData?.name ?? "",
      status: initialData?.status ?? "active",
      extraFieldsEnabled: initialData?.extraFieldsEnabled ?? false,
      embedTitle: initialData?.embedTitle ?? "Időpont foglalás",
      brandColor: initialData?.brandColor ?? "#0A2540",
      iframeWidth: initialData?.iframeWidth ?? "100%",
      iframeHeight: initialData?.iframeHeight ?? "760px",
      privacyPolicyUrl: initialData?.privacyPolicyUrl ?? "",
      cookiePolicyUrl: initialData?.cookiePolicyUrl ?? "",
    },
  });

  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    if (initialData && Array.isArray(initialData.allowedOrigins)) {
      return initialData.allowedOrigins.filter((d) => typeof d === "string");
    }
    return [];
  });

  const handleSubmit = (values: ReservationFormValues) => {
    const cleanedOrigins = allowedOrigins
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (mode === "create") {
      const payload: ReservationCreateDTO = {
        name: values.name.trim(),
        projectId: values.projectId!,
        allowedOrigins: cleanedOrigins,
        status: values.status,
        extraFieldsEnabled: values.extraFieldsEnabled,
        embedTitle: values.embedTitle,
        brandColor: values.brandColor,
        iframeWidth: values.iframeWidth,
        iframeHeight: values.iframeHeight,
        privacyPolicyUrl: values.privacyPolicyUrl || null,
        cookiePolicyUrl: values.cookiePolicyUrl || null,
        timezone: values.timezone,
      };
      onSubmit(payload);
    } else {
      const payload: ReservationUpdateDTO = {
        name: values.name.trim(),
        allowedOrigins: cleanedOrigins,
        status: values.status,
        extraFieldsEnabled: values.extraFieldsEnabled,
        embedTitle: values.embedTitle,
        brandColor: values.brandColor,
        iframeWidth: values.iframeWidth,
        iframeHeight: values.iframeHeight,
        privacyPolicyUrl: values.privacyPolicyUrl || null,
        cookiePolicyUrl: values.cookiePolicyUrl || null,
        timezone: values.timezone,
      };
      onSubmit(payload);
    }
  };

  const copySecretToken = async () => {
    if (!initialData?.secretToken) return;
    const token = initialData.secretToken;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
        showSuccess(t("reservations:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("reservations:secret_token_copied"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showError(message);
    }
  };

  const isEdit = mode === "edit";

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="max-w-2xl mx-auto space-y-6 w-full"
      >
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">
              {isEdit
                ? t("reservations:edit_reservation")
                : t("reservations:create_reservation")}
            </CardTitle>
            <CardDescription>
              {isEdit
                ? (initialData?.name ?? "")
                : t("reservations:create_reservation_description")}
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Project picker */}
            <FormField
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required={!isEdit}>
                    {t("reservations:project")}
                  </FormLabel>
                  <FormControl>
                    {isEdit ? (
                      <Input
                        readOnly
                        value={initialData?.projectName ?? ""}
                        title={t("reservations:project_immutable_tooltip")}
                        aria-readonly
                        className="bg-muted"
                      />
                    ) : (
                      <div className="space-y-2">
                        <input type="hidden" {...field} value={field.value ?? ""} />
                        <FormProjectSelectorModal
                          selectedId={field.value}
                          onSelect={(project) => {
                            form.setValue("projectId", project.id, {
                              shouldValidate: true,
                              shouldDirty: true,
                            });
                            form.setValue("projectName", project.name);
                          }}
                        />
                      </div>
                    )}
                  </FormControl>
                  {!isEdit && <FormMessage />}
                </FormItem>
              )}
            />

            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("reservations:name")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("reservations:name_placeholder")}
                      maxLength={200}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Secret token — always read-only with a copy button */}
            {isEdit && initialData?.secretToken && (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  {t("reservations:secret_token")}
                </FormLabel>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={initialData.secretToken}
                    title={t("reservations:secret_token_immutable_tooltip")}
                    className="bg-muted font-mono text-xs"
                    aria-readonly
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copySecretToken}
                    title={t("reservations:secret_token_immutable_tooltip")}
                    aria-label={t("reservations:secret_token")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <FormDescription>
                  {t("reservations:secret_token_help")}
                </FormDescription>
                <span className="sr-only">
                  <ClipboardCheck />
                </span>
              </FormItem>
            )}

            {/* Allowed origins */}
            <div className="space-y-2">
              <FormLabel className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t("reservations:allowed_origins_label")}
              </FormLabel>
              <FormDescription>
                {t("reservations:allowed_origins_help")}
              </FormDescription>
              <div className="space-y-2">
                {allowedOrigins.length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("reservations:allowed_origins_empty_warning")}
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
                      placeholder={t("reservations:allowed_origins_placeholder")}
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
                      aria-label={t("reservations:allowed_origins_remove")}
                      title={t("reservations:allowed_origins_remove")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {allowedOrigins.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("reservations:allowed_origins_count", {
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
                  {t("reservations:allowed_origins_add")}
                </Button>
              </div>
            </div>

            {/* Extra fields enabled */}
            <FormField
              control={form.control}
              name="extraFieldsEnabled"
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-center gap-2">
                    <FormLabel className="flex items-center gap-2 m-0">
                      <FilePen className="h-4 w-4" />
                      {t("reservations:extra_fields_enabled")}
                    </FormLabel>
                    <FormControl>
                      <Checkbox
                        checked={!!field.value}
                        onCheckedChange={(checked) =>
                          field.onChange(checked === true)
                        }
                        aria-label={t("reservations:extra_fields_enabled")}
                      />
                    </FormControl>
                  </div>
                  <FormDescription>
                    {t("reservations:extra_fields_enabled_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Embed widget title */}
            <FormField
              control={form.control}
              name="embedTitle"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("reservations:embed_title", { defaultValue: "Embed widget title" })}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Időpont foglalás" />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:embed_title_help", { defaultValue: "Heading shown in the public booking widget" })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Timezone */}
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    {t("reservations:timezone", { defaultValue: "Timezone" })}
                  </FormLabel>
                  <FormControl>
                    <Select
                      value={field.value}
                      onValueChange={(v) => field.onChange(v)}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="UTC" />
                      </SelectTrigger>
                      <SelectContent>
                        {TIMEZONE_OPTIONS.map((tz) => (
                          <SelectItem key={tz} value={tz}>
                            {tz}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </FormControl>
                  <FormDescription>
                    {t("reservations:timezone_help", { defaultValue: "Timezone used for email notifications and date display." })}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Embed widget settings */}
            <div className="grid grid-cols-3 gap-4">
              <FormField
                control={form.control}
                name="brandColor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("reservations:brand_color", { defaultValue: "Brand color" })}</FormLabel>
                    <FormControl>
                      <div className="flex gap-2">
                        <Input {...field} placeholder="#0A2540" className="font-mono text-xs" />
                        <input type="color" value={field.value} onChange={field.onChange} className="h-9 w-9 rounded border cursor-pointer shrink-0" />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="iframeWidth"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("reservations:iframe_width", { defaultValue: "Iframe width" })}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="100%" className="font-mono text-xs" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="iframeHeight"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("reservations:iframe_height", { defaultValue: "Iframe height" })}</FormLabel>
                    <FormControl>
                      <Input {...field} placeholder="760px" className="font-mono text-xs" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>


            {/* Privacy policy URL */}
            <FormField
              control={form.control}
              name="privacyPolicyUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("reservations:privacy_policy_url")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t("reservations:privacy_policy_url_placeholder")} type="url" />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:privacy_policy_url_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Cookie policy URL */}
            <FormField
              control={form.control}
              name="cookiePolicyUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("reservations:cookie_policy_url")}</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder={t("reservations:cookie_policy_url_placeholder")} type="url" />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:cookie_policy_url_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("reservations:status")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="status"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={ctrlField.value}
                          onValueChange={(v) =>
                            ctrlField.onChange(v as ReservationStatus)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t("reservations:status_placeholder")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {t(`reservations:status_${s}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
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
              : isEdit
                ? t("common:save")
                : t("common:create")}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default ReservationForm;
