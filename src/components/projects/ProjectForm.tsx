import { useEffect } from "react";
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
import {
  Building2,
  Globe,
  MessageSquare,
  User,
  Phone,
  Mail,
} from "lucide-react";
import type {
  ProjectCreateUpdateDTO,
  ProjectDetails,
  ProjectStatus,
  BillingPeriod,
} from "@/types/project";

interface ProjectFormValues {
  name: string;
  domainAddress: string;
  price: string;
  billingPeriod: BillingPeriod | "";
  fordulonap: string;
  status: ProjectStatus;
  comment: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
}

interface ProjectFormProps {
  initialData?: ProjectDetails;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (data: ProjectCreateUpdateDTO) => void;
}

const STATUS_OPTIONS: ProjectStatus[] = [
  "under_construction",
  "customer_paid",
  "waiting_for_payment",
  "notified_customer",
  "have_to_notify",
  "paid",
  "cancelled",
  "completed",
];

const PERIOD_OPTIONS: BillingPeriod[] = ["monthly", "yearly", "one_off"];

// Yearly day picker: two selects (month + day) → "MM-DD" wire format.
// We split the field.value into month + day, and on change combine them.
function YearlyDayPicker({
  field,
}: {
  field: { value: string; onChange: (v: string) => void };
}) {
  const { t } = useTranslation(["projects", "common"]);
  // Parse "MM-DD" (or legacy "YYYY-MM-DD") into separate month + day parts.
  let month = "";
  let day = "";
  if (field.value && field.value.includes("-")) {
    const parts = field.value.split("-");
    if (parts.length === 2) {
      [month, day] = parts;
    } else if (parts.length === 3) {
      // Legacy ISO date stored in the DB — surface as MM-DD for editing.
      [month, day] = [parts[1], parts[2]];
    }
  }

  const MONTHS = [
    { value: "01", label: t("common:month_january") },
    { value: "02", label: t("common:month_february") },
    { value: "03", label: t("common:month_march") },
    { value: "04", label: t("common:month_april") },
    { value: "05", label: t("common:month_may") },
    { value: "06", label: t("common:month_june") },
    { value: "07", label: t("common:month_july") },
    { value: "08", label: t("common:month_august") },
    { value: "09", label: t("common:month_september") },
    { value: "10", label: t("common:month_october") },
    { value: "11", label: t("common:month_november") },
    { value: "12", label: t("common:month_december") },
  ];
  const DAYS = Array.from({ length: 31 }, (_, i) => {
    const d = String(i + 1).padStart(2, "0");
    return { value: d, label: d };
  });

  const update = (newMonth: string, newDay: string) => {
    if (!newMonth || !newDay) {
      field.onChange("");
      return;
    }
    field.onChange(`${newMonth}-${newDay}`);
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      <Select
        value={month || undefined}
        onValueChange={(v) => update(v, day || "")}
      >
        <SelectTrigger>
          <SelectValue placeholder={t("projects:fordulonap_month_placeholder")} />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((m) => (
            <SelectItem key={m.value} value={m.value}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={day || undefined}
        onValueChange={(v) => update(month || "", v)}
      >
        <SelectTrigger>
          <SelectValue placeholder={t("projects:fordulonap_day_placeholder")} />
        </SelectTrigger>
        <SelectContent>
          {DAYS.map((d) => (
            <SelectItem key={d.value} value={d.value}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const ProjectForm = ({
  initialData,
  mode,
  isSubmitting,
  onSubmit,
}: ProjectFormProps) => {
  const { t } = useTranslation(["projects", "common", "auth"]);

  const formSchema = z
    .object({
      name: z
        .string()
        .min(1, { message: "common:required_field" })
        .max(200, { message: "projects:max_length" }),
      domainAddress: z
        .string()
        .max(500, { message: "projects:max_length" })
        .optional()
        .or(z.literal(""))
        .refine(
          (val) => !val || val === "" || z.string().url().safeParse(val).success,
          { message: "projects:invalid_url" },
        ),
      price: z
        .union([
          z.literal(""),
          z.coerce
            .number({ invalid_type_error: "projects:price_negative" })
            .nonnegative({ message: "projects:price_negative" }),
        ])
        .optional(),
      billingPeriod: z
        .union([z.literal(""), z.enum(["monthly", "yearly", "one_off"])])
        .nullable()
        .optional()
        .refine(
          (val) =>
            val === "" ||
            val === null ||
            val === undefined ||
            PERIOD_OPTIONS.includes(val as BillingPeriod),
          { message: "projects:billing_period_invalid" },
        ),
      fordulonap: z.string().optional().or(z.literal("")),
      status: z.enum([
        "under_construction",
        "customer_paid",
        "waiting_for_payment",
        "notified_customer",
        "have_to_notify",
        "paid",
        "cancelled",
        "completed",
      ]),
      comment: z
        .string()
        .max(5000, { message: "projects:max_length" })
        .optional()
        .or(z.literal("")),
      customerName: z
        .string()
        .max(200, { message: "projects:max_length" })
        .optional()
        .or(z.literal("")),
      customerPhone: z
        .string()
        .max(50, { message: "projects:max_length" })
        .optional()
        .or(z.literal("")),
      customerEmail: z
        .string()
        .max(255, { message: "projects:max_length" })
        .email({ message: "auth:invalid_email" })
        .optional()
        .or(z.literal("")),
    })
    .superRefine((data, ctx) => {
      if (data.fordulonap && data.fordulonap !== "") {
        if (data.billingPeriod === "monthly") {
          const n = Number(data.fordulonap);
          if (!Number.isInteger(n) || n < 1 || n > 28) {
            ctx.addIssue({
              code: "custom",
              path: ["fordulonap"],
              message: "projects:fordulonap_monthly_invalid",
            });
          }
        } else if (data.billingPeriod === "yearly") {
          // yearly sends "MM-DD" (e.g. "06-15")
          if (!/^\d{2}-\d{2}$/.test(data.fordulonap)) {
            ctx.addIssue({
              code: "custom",
              path: ["fordulonap"],
              message: "projects:fordulonap_date_invalid",
            });
          }
        } else if (data.billingPeriod === "one_off") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(data.fordulonap)) {
            ctx.addIssue({
              code: "custom",
              path: ["fordulonap"],
              message: "projects:fordulonap_date_invalid",
            });
          }
        } else {
          ctx.addIssue({
            code: "custom",
            path: ["fordulonap"],
            message: "projects:fordulonap_period_required",
          });
        }
      }
    });

  const form = useForm<ProjectFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialData?.name ?? "",
      domainAddress: initialData?.domainAddress ?? "",
      price:
        initialData?.price !== null && initialData?.price !== undefined
          ? String(initialData.price)
          : "",
      billingPeriod: initialData?.billingPeriod ?? "",
      fordulonap: initialData?.fordulonap ?? "",
      status: initialData?.status ?? "under_construction",
      comment: initialData?.comment ?? "",
      customerName: initialData?.customerName ?? "",
      customerPhone: initialData?.customerPhone ?? "",
      customerEmail: initialData?.customerEmail ?? "",
    },
  });

  // Watch billingPeriod so the fordulonap input type swaps live.
  const billingPeriod = form.watch("billingPeriod");

  // Reset fordulonap when switching to a different period type to avoid
  // stale-format data lingering in the input.
  useEffect(() => {
    if (billingPeriod === "monthly") {
      const v = form.getValues("fordulonap");
      // monthly expects a 1-2 digit day number. Clear if it's a date (ISO or MM-DD).
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{2}-\d{2}$/.test(v)) {
        form.setValue("fordulonap", "");
      }
    } else if (billingPeriod === "yearly") {
      const v = form.getValues("fordulonap");
      // yearly expects "MM-DD" (5 chars). Clear if it's a full ISO date or a day number.
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}$/.test(v)) {
        form.setValue("fordulonap", "");
      }
    } else if (billingPeriod === "one_off") {
      const v = form.getValues("fordulonap");
      // one_off expects full ISO date. Clear if it's MM-DD or a day number.
      if (/^\d{2}-\d{2}$/.test(v) || /^\d{1,2}$/.test(v)) {
        form.setValue("fordulonap", "");
      }
    } else {
      form.setValue("fordulonap", "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingPeriod]);

  const handleSubmit = (values: ProjectFormValues) => {
    // Map fordulonap to its wire encoding before passing to onSubmit.
    let fordulonap: string | null = null;
    if (values.fordulonap && values.fordulonap !== "") {
      if (values.billingPeriod === "monthly") {
        fordulonap = values.fordulonap; // "DD"
      } else if (values.billingPeriod === "yearly") {
        // YearlyDayPicker already emits "MM-DD". Just pass through.
        fordulonap = values.fordulonap;
      } else if (values.billingPeriod === "one_off") {
        fordulonap = values.fordulonap; // "YYYY-MM-DD"
      }
    }

    const payload: ProjectCreateUpdateDTO = {
      name: values.name,
      status: values.status,
      domainAddress: values.domainAddress ? values.domainAddress : null,
      price:
        values.price === "" || values.price === undefined
          ? null
          : Number(values.price),
      billingPeriod: values.billingPeriod ? values.billingPeriod : null,
      fordulonap,
      comment: values.comment ? values.comment : null,
      customerName: values.customerName ? values.customerName : null,
      customerPhone: values.customerPhone ? values.customerPhone : null,
      customerEmail: values.customerEmail ? values.customerEmail : null,
    };
    onSubmit(payload);
  };

  const renderFordulonapHelperKey = (): string => {
    if (billingPeriod === "monthly") return "projects:fordulonap_monthly_helper";
    if (billingPeriod === "yearly") return "projects:fordulonap_yearly_helper";
    if (billingPeriod === "one_off")
      return "projects:fordulonap_one_off_helper";
    return "projects:fordulonap_period_required";
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
              {mode === "create"
                ? t("projects:create_project")
                : t("projects:edit_project")}
            </CardTitle>
            <CardDescription>
              {mode === "create"
                ? t("projects:create_project_description")
                : initialData?.name}
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("projects:name")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Building2 className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        placeholder={t("projects:name_placeholder")}
                        maxLength={200}
                        className="pl-10"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.name?.message &&
                      t(form.formState.errors.name.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Domain */}
            <FormField
              control={form.control}
              name="domainAddress"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("projects:domain_address")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Globe className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        placeholder={t("projects:domain_address_placeholder")}
                        maxLength={500}
                        className="pl-10"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.domainAddress?.message &&
                      t(form.formState.errors.domainAddress.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Price */}
            <FormField
              control={form.control}
              name="price"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("projects:price")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        placeholder={t("projects:price_placeholder")}
                        className="pr-12"
                        {...field}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground pointer-events-none select-none">
                        Ft
                      </span>
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.price?.message &&
                      t(form.formState.errors.price.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Billing period */}
            <FormField
              control={form.control}
              name="billingPeriod"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("projects:billing_period")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="billingPeriod"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={
                            ctrlField.value === "" ||
                            ctrlField.value === null ||
                            ctrlField.value === undefined
                              ? "__none__"
                              : ctrlField.value
                          }
                          onValueChange={(v) =>
                            ctrlField.onChange(
                              v === "__none__" ? "" : (v as BillingPeriod),
                            )
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t(
                                "projects:billing_period_placeholder",
                              )}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">
                              {t("projects:billing_period_none")}
                            </SelectItem>
                            {PERIOD_OPTIONS.map((p) => (
                              <SelectItem key={p} value={p}>
                                {t(`projects:billing_period_${p}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.billingPeriod?.message &&
                      t(
                        form.formState.errors.billingPeriod.message as string,
                      )}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Fordulonap — conditional input type based on billingPeriod */}
            {billingPeriod && (
              <FormField
                control={form.control}
                name="fordulonap"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("projects:fordulonap")}</FormLabel>
                    <FormControl>
                      {billingPeriod === "monthly" ? (
                        // Monthly: just the day number
                        <Input
                          type="number"
                          min={1}
                          max={28}
                          placeholder={t("projects:fordulonap_placeholder")}
                          {...field}
                          value={field.value ?? ""}
                        />
                      ) : billingPeriod === "yearly" ? (
                        // Yearly: two selects for month + day, no year
                        <YearlyDayPicker field={field} />
                      ) : (
                        // one_off: full date
                        <Input
                          type="date"
                          {...field}
                          value={field.value ?? ""}
                        />
                      )}
                    </FormControl>
                    <FormDescription>
                      {t(renderFordulonapHelperKey())}
                    </FormDescription>
                    <FormMessage>
                      {form.formState.errors.fordulonap?.message &&
                        t(form.formState.errors.fordulonap.message as string)}
                    </FormMessage>
                  </FormItem>
                )}
              />
            )}

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("projects:status")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="status"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={ctrlField.value}
                          onValueChange={(v) =>
                            ctrlField.onChange(v as ProjectStatus)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t("projects:status_placeholder")}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {t(`projects:status_${s}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.status?.message &&
                      t(form.formState.errors.status.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Comment */}
            <FormField
              control={form.control}
              name="comment"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("projects:comment")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <MessageSquare className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <textarea
                        rows={4}
                        placeholder={t("projects:comment_placeholder")}
                        maxLength={5000}
                        className="flex w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.comment?.message &&
                      t(form.formState.errors.comment.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Customer section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">
              {t("projects:customer_section")}
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            <FormField
              control={form.control}
              name="customerName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("projects:customer_name")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        placeholder={t("projects:customer_name_placeholder")}
                        maxLength={200}
                        className="pl-10"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.customerName?.message &&
                      t(form.formState.errors.customerName.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="customerPhone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("projects:customer_phone")}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          placeholder={t(
                            "projects:customer_phone_placeholder",
                          )}
                          maxLength={50}
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.customerPhone?.message &&
                        t(
                          form.formState.errors.customerPhone
                            .message as string,
                        )}
                    </FormMessage>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="customerEmail"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("projects:customer_email")}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Mail className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          type="email"
                          placeholder={t(
                            "projects:customer_email_placeholder",
                          )}
                          maxLength={255}
                          className="pl-10"
                          {...field}
                        />
                      </div>
                    </FormControl>
                    <FormMessage>
                      {form.formState.errors.customerEmail?.message &&
                        t(
                          form.formState.errors.customerEmail
                            .message as string,
                        )}
                    </FormMessage>
                  </FormItem>
                )}
              />
            </div>
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
              : mode === "create"
                ? t("common:create")
                : t("common:save")}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default ProjectForm;