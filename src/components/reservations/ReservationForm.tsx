// ----------------------------------------------------------------------------
// ReservationForm — shared create/edit form for the Reservation entity.
//
// Pattern: RHF + zod, Controller-wrapped Selects, conditional fields.
//
// Differences vs. FormForm:
//   - Adds Granularity Select (day / hour / minute)
//   - Adds Slot duration minutes Input (only when granularity is hour/minute)
//   - Adds Lead time minutes Input (≥ 0)
//   - Adds Max advance days Input (≥ 1)
//   - Adds Extra fields enabled Switch
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
  Copy,
  ClipboardCheck,
  Globe,
  Lock,
  Trash2,
  Clock,
  Hourglass,
  CalendarRange,
  FilePen,
} from "lucide-react";
import type {
  ReservationCreateDTO,
  ReservationDTO,
  ReservationGranularity,
  ReservationStatus,
  ReservationUpdateDTO,
} from "@/types/reservation";
import { FormProjectSelectorModal } from "@/components/forms/FormProjectSelectorModal";
import { showError, showSuccess } from "@/utils/toast";

interface ReservationFormValues {
  projectId: number | null;
  projectName: string;
  name: string;
  slug: string;
  status: ReservationStatus;
  granularity: ReservationGranularity;
  slotDurationMinutes: string | null | undefined;
  leadTimeMinutes: number;
  maxAdvanceDays: number;
  extraFieldsEnabled: boolean;
}

interface ReservationFormProps {
  initialData?: ReservationDTO;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (data: ReservationCreateDTO | ReservationUpdateDTO) => void;
}

const STATUS_OPTIONS: ReservationStatus[] = ["active", "disabled"];
const GRANULARITY_OPTIONS: ReservationGranularity[] = [
  "day",
  "hour",
  "minute",
];

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const ReservationForm = ({
  initialData,
  mode,
  isSubmitting,
  onSubmit,
}: ReservationFormProps) => {
  const { t } = useTranslation(["reservations", "common"]);

  const slugSchema = z
    .string()
    .min(1, { message: "reservations:slug_required" })
    .max(50)
    .regex(SLUG_RE, { message: "reservations:slug_invalid" });

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
    slug: slugSchema,
    status: z.enum(["active", "disabled"]),
    granularity: z.enum(["day", "hour", "minute"]),
    // Editable string-shaped field that converts to number on submit.
    // Using string here keeps the FE validation simple (max length, etc.)
    // — we parse to a positive int at submit time.
    slotDurationMinutes: z
      .union([
        z
          .string()
          .max(6, { message: "reservations:max_length" })
          .regex(/^\d+$/, { message: "reservations:slot_duration_invalid" }),
        z.null(),
      ])
      .optional(),
    leadTimeMinutes: z.coerce
      .number({ invalid_type_error: "reservations:required_field" })
      .int()
      .min(0)
      .max(60 * 24 * 30, { message: "reservations:max_length" }),
    maxAdvanceDays: z.coerce
      .number({ invalid_type_error: "reservations:required_field" })
      .int()
      .min(1)
      .max(365, { message: "reservations:max_length" }),
    extraFieldsEnabled: z.boolean(),
  });

  const form = useForm<ReservationFormValues, unknown, ReservationFormValues>({
    resolver: zodResolver(formSchema) as Resolver<ReservationFormValues>,
    defaultValues: {
      projectId: initialData?.projectId ?? null,
      projectName: initialData?.projectName ?? "",
      name: initialData?.name ?? "",
      slug: initialData?.slug ?? "",
      status: initialData?.status ?? "active",
      granularity: initialData?.granularity ?? "hour",
      slotDurationMinutes:
        initialData?.slotDurationMinutes === null ||
        initialData?.slotDurationMinutes === undefined
          ? null
          : String(initialData.slotDurationMinutes),
      leadTimeMinutes: initialData?.leadTimeMinutes ?? 60,
      maxAdvanceDays: initialData?.maxAdvanceDays ?? 90,
      extraFieldsEnabled: initialData?.extraFieldsEnabled ?? false,
    },
  });

  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    if (initialData && Array.isArray(initialData.allowedOrigins)) {
      return initialData.allowedOrigins.filter((d) => typeof d === "string");
    }
    return [];
  });

  const granularity = form.watch("granularity");
  const showSlotDuration = granularity === "hour" || granularity === "minute";

  const handleSubmit = (values: ReservationFormValues) => {
    const cleanedOrigins = allowedOrigins
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    let slot: number | null;
    if (!showSlotDuration) {
      slot = null;
    } else if (
      values.slotDurationMinutes === null ||
      values.slotDurationMinutes === undefined ||
      values.slotDurationMinutes === ""
    ) {
      slot = null;
    } else {
      const n = parseInt(String(values.slotDurationMinutes), 10);
      slot = Number.isFinite(n) && n > 0 ? n : null;
    }

    if (mode === "create") {
      const payload: ReservationCreateDTO = {
        name: values.name.trim(),
        slug: values.slug.trim(),
        projectId: values.projectId!,
        allowedOrigins: cleanedOrigins,
        status: values.status,
        granularity: values.granularity,
        slotDurationMinutes: slot,
        leadTimeMinutes: values.leadTimeMinutes,
        maxAdvanceDays: values.maxAdvanceDays,
        extraFieldsEnabled: values.extraFieldsEnabled,
      };
      onSubmit(payload);
    } else {
      const payload: ReservationUpdateDTO = {
        name: values.name.trim(),
        slug: values.slug.trim(),
        allowedOrigins: cleanedOrigins,
        status: values.status,
        granularity: values.granularity,
        slotDurationMinutes: slot,
        leadTimeMinutes: values.leadTimeMinutes,
        maxAdvanceDays: values.maxAdvanceDays,
        extraFieldsEnabled: values.extraFieldsEnabled,
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

            {/* Slug — read-only in edit (orchestrator chose strict lock) */}
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("reservations:slug")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("reservations:slug_placeholder")}
                      maxLength={50}
                      readOnly={isEdit}
                      title={
                        isEdit
                          ? t("reservations:slug_immutable_tooltip")
                          : undefined
                      }
                      aria-readonly={isEdit}
                      className={isEdit ? "bg-muted font-mono text-xs" : "font-mono text-xs"}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:slug_help")}
                  </FormDescription>
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

            {/* Granularity */}
            <FormField
              control={form.control}
              name="granularity"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required className="flex items-center gap-2">
                    <CalendarRange className="h-4 w-4" />
                    {t("reservations:granularity")}
                  </FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="granularity"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={ctrlField.value}
                          onValueChange={(v) =>
                            ctrlField.onChange(v as ReservationGranularity)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t("reservations:granularity_placeholder")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {GRANULARITY_OPTIONS.map((g) => (
                              <SelectItem key={g} value={g}>
                                {t(`reservations:granularity_${g}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:granularity_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Slot duration minutes — only when hour/minute */}
            {showSlotDuration && (
              <FormField
                control={form.control}
                name="slotDurationMinutes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Clock className="h-4 w-4" />
                      {t("reservations:slot_duration_minutes")}
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        max={1440}
                        step={1}
                        placeholder={t(
                          "reservations:slot_duration_minutes_placeholder",
                        )}
                        value={field.value ?? ""}
                        onChange={(e) =>
                          field.onChange(
                            e.target.value === "" ? null : e.target.value,
                          )
                        }
                        className="font-mono text-xs"
                      />
                    </FormControl>
                    <FormDescription>
                      {t("reservations:slot_duration_minutes_help")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Lead time minutes */}
            <FormField
              control={form.control}
              name="leadTimeMinutes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-2">
                    <Hourglass className="h-4 w-4" />
                    {t("reservations:lead_time_minutes")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0}
                      max={60 * 24 * 30}
                      step={1}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:lead_time_minutes_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Max advance days */}
            <FormField
              control={form.control}
              name="maxAdvanceDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="flex items-center gap-2">
                    <CalendarRange className="h-4 w-4" />
                    {t("reservations:max_advance_days")}
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      max={365}
                      step={1}
                      className="font-mono text-xs"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("reservations:max_advance_days_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

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
