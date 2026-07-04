// ----------------------------------------------------------------------------
// FormForm — shared create/edit form for the Form entity.
//
// Pattern: RHF + zod, Controller-wrapped Selects, conditional fields.
// Differences from a generic scaffold:
//   - No `kind` (only one form purpose), no `fields`, no consent/CSS
//   - `slug` is editable on the FE in CREATE mode (entered manually);
//     on EDIT mode it is read-only with a tooltip — slug is documented
//     as changeable in the BE (with 409 on collision) but the
//     orchestrator chose to lock it on EDIT for the MVP to reduce
//     operator surprise. The BE still allows the change if the FE ever
//     wants to expose it.
//   - `secretToken` is always read-only with a copy button. Immutable.
//   - `projectId` is read-only in EDIT (immutable after create).
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
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
  FormCreateDTO,
  FormDTO,
  FormStatus,
  FormUpdateDTO,
} from "@/types/form";
import { FormProjectSelectorModal } from "@/components/forms/FormProjectSelectorModal";
import { showError, showSuccess } from "@/utils/toast";

interface FormFormValues {
  projectId: number | null;
  projectName: string;
  name: string;
  slug: string;
  status: FormStatus;
  allowedOrigins: string[];
}

interface FormFormProps {
  initialData?: FormDTO;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (data: FormCreateDTO | FormUpdateDTO) => void;
}

const STATUS_OPTIONS: FormStatus[] = ["active", "disabled"];
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FormForm = ({
  initialData,
  mode,
  isSubmitting,
  onSubmit,
}: FormFormProps) => {
  const { t } = useTranslation(["forms", "common"]);

  // Refine the slug field: 1..50 chars, lowercase kebab-case.
  const slugSchema = z
    .string()
    .min(1, { message: "forms:slug_required" })
    .max(50)
    .regex(SLUG_RE, { message: "forms:slug_invalid" });

  const formSchema = z.object({
    projectId: z
      .number({ invalid_type_error: "forms:project_required" })
      .int()
      .positive({ message: "forms:project_required" }),
    projectName: z.string(),
    name: z
      .string()
      .min(1, { message: "forms:required_field" })
      .max(200, { message: "forms:max_length" }),
    slug: slugSchema,
    status: z.enum(["active", "disabled"]),
  });

  const form = useForm<FormFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      projectId: initialData?.projectId ?? null,
      projectName: initialData?.projectName ?? "",
      name: initialData?.name ?? "",
      slug: initialData?.slug ?? "",
      status: initialData?.status ?? "active",
    },
  });

  // Lifted state for the allowed-origins list — no Controller per row,
  // trim-on-submit only.
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    if (initialData && Array.isArray(initialData.allowedOrigins)) {
      return initialData.allowedOrigins.filter((d) => typeof d === "string");
    }
    return [];
  });

  const handleSubmit = (values: FormFormValues) => {
    const cleanedOrigins = allowedOrigins
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (mode === "create") {
      const payload: FormCreateDTO = {
        name: values.name.trim(),
        slug: values.slug.trim(),
        projectId: values.projectId!,
        allowedOrigins: cleanedOrigins,
        status: values.status,
      };
      onSubmit(payload);
    } else {
      // PUT (partial) — only send fields the operator actually changed.
      // The BE rejects projectId changes; we leave it out entirely.
      const payload: FormUpdateDTO = {
        name: values.name.trim(),
        slug: values.slug.trim(),
        allowedOrigins: cleanedOrigins,
        status: values.status,
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
        showSuccess(t("forms:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("forms:secret_token_copied"));
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
                ? t("forms:edit_form")
                : t("forms:create_form")}
            </CardTitle>
            <CardDescription>
              {isEdit
                ? (initialData?.name ?? "")
                : t("forms:create_form_description")}
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
                    {t("forms:project")}
                  </FormLabel>
                  <FormControl>
                    {isEdit ? (
                      <Input
                        readOnly
                        value={initialData?.projectName ?? ""}
                        title={t("forms:project_immutable_tooltip")}
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
                  <FormLabel required>{t("forms:name")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("forms:name_placeholder")}
                      maxLength={200}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Slug — always editable on the form, but in EDIT mode the
                orchestrator chose to lock it on EDIT for the MVP. The BE
                still supports changing it (with a 409 on collision), so
                future recovery is one prop flip away. */}
            <FormField
              control={form.control}
              name="slug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("forms:slug")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("forms:slug_placeholder")}
                      maxLength={50}
                      readOnly={isEdit}
                      title={
                        isEdit
                          ? t("forms:slug_immutable_tooltip")
                          : undefined
                      }
                      aria-readonly={isEdit}
                      className={isEdit ? "bg-muted font-mono text-xs" : "font-mono text-xs"}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("forms:slug_help")}
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
                  {t("forms:secret_token")}
                </FormLabel>
                <div className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={initialData.secretToken}
                    title={t("forms:secret_token_immutable_tooltip")}
                    className="bg-muted font-mono text-xs"
                    aria-readonly
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={copySecretToken}
                    title={t("forms:secret_token_immutable_tooltip")}
                    aria-label={t("forms:secret_token")}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <FormDescription>
                  {t("forms:secret_token_help")}
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
                {t("forms:allowed_origins_label")}
              </FormLabel>
              <FormDescription>
                {t("forms:allowed_origins_help")}
              </FormDescription>
              <div className="space-y-2">
                {allowedOrigins.length === 0 && (
                  <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                    {t("forms:allowed_origins_empty_warning")}
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
                      placeholder={t("forms:allowed_origins_placeholder")}
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
                      aria-label={t("forms:allowed_origins_remove")}
                      title={t("forms:allowed_origins_remove")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                {allowedOrigins.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("forms:allowed_origins_count", {
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
                  {t("forms:allowed_origins_add")}
                </Button>
              </div>
            </div>

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("forms:status")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="status"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={ctrlField.value}
                          onValueChange={(v) =>
                            ctrlField.onChange(v as FormStatus)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t("forms:status_placeholder")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {t(`forms:status_${s}`)}
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

export default FormForm;
