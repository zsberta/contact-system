import { useEffect, useState } from "react";
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
  CalendarDays,
  CircleDollarSign,
  MessageSquare,
} from "lucide-react";
import type {
  PaymentCreateUpdateDTO,
  PaymentDTO,
  PaymentOrigin,
  PaymentStatus,
} from "@/types/payment";

interface PaymentFormValues {
  amount: string;
  dueDate: string;
  status: PaymentStatus;
  paidAt: string;
  note: string;
  createdBy: PaymentOrigin;
}

interface PaymentFormProps {
  initialData?: PaymentDTO;
  projectId: number;
  mode: "create" | "edit";
  isSubmitting: boolean;
  onSubmit: (
    data: PaymentCreateUpdateDTO | Partial<PaymentCreateUpdateDTO>,
  ) => void;
}

const STATUS_OPTIONS: PaymentStatus[] = [
  "pending",
  "paid",
  "overdue",
  "cancelled",
];

// Hungarian date entry — plain text auto-formatted as ÉÉÉÉ.HH.NN, so no
// browser locale can re-localize it (same approach as the disabled-date form).
const ymdToHu = (ymd: string): string => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : ymd;
};

const formatHuDateInput = (raw: string): string => {
  const d = raw.replace(/[^0-9]/g, "").slice(0, 8);
  if (d.length <= 4) return d;
  if (d.length <= 6) return `${d.slice(0, 4)}.${d.slice(4)}`;
  return `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6)}`;
};

// Strict parse of ÉÉÉÉ.HH.NN — rejects impossible dates. Returns YYYY-MM-DD or null.
const parseHuDateInput = (s: string): string | null => {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(s);
  if (!m) return null;
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (
    dt.getFullYear() !== Number(m[1]) ||
    dt.getMonth() !== Number(m[2]) - 1 ||
    dt.getDate() !== Number(m[3])
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
};

const PaymentForm = ({
  initialData,
  projectId,
  mode,
  isSubmitting,
  onSubmit,
}: PaymentFormProps) => {
  const { t } = useTranslation(["payments", "common"]);

  const formSchema = z
    .object({
      amount: z
        .union([
          z.literal(""),
          z.coerce
            .number({
              invalid_type_error: "payments:amount_invalid",
            })
            .nonnegative({ message: "payments:amount_invalid" }),
        ])
        .refine(
          (val) => val !== "",
          { message: "payments:amount_invalid" },
        ),
      dueDate: z
        .string()
        .min(1, { message: "payments:due_date_required" })
        .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "payments:due_date_invalid" }),
      status: z.enum(["pending", "paid", "overdue", "cancelled"]),
      paidAt: z.string().optional().or(z.literal("")),
      note: z
        .string()
        .max(5000, { message: "payments:max_length" })
        .optional()
        .or(z.literal("")),
      createdBy: z.enum(["auto", "manual"]).optional(),
    });

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      amount:
        initialData?.amount !== null && initialData?.amount !== undefined
          ? String(initialData.amount)
          : "",
      dueDate: initialData?.dueDate ?? "",
      status: initialData?.status ?? "pending",
      paidAt: initialData?.paidAt ?? "",
      note: initialData?.note ?? "",
      createdBy: initialData?.createdBy ?? "manual",
    },
  });
  // Visible due-date text (Hungarian). The RHF field keeps the YYYY-MM-DD
  // wire value in sync; handleSubmit re-parses this as the source of truth.
  const [dueDisplay, setDueDisplay] = useState(() =>
    ymdToHu(initialData?.dueDate ?? ""),
  );
  const [paidDisplay, setPaidDisplay] = useState(() => {
    // Local parts, not the UTC slice: the stored instant is local-midnight
    // shifted to UTC, so slicing would show a day early in +timezones.
    if (!initialData?.paidAt) return "";
    const d = new Date(initialData.paidAt);
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}.${mm}.${dd}`;
  });
  const statusValue = form.watch("status");

  // Keep createdBy locked to "manual" for create mode (UI forces manual).
  useEffect(() => {
    if (mode === "create") {
      form.setValue("createdBy", "manual");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleSubmit = (values: PaymentFormValues) => {
    // Re-parse the visible input so a half-typed display can never submit
    // a stale wire value.
    if (dueDisplay.trim() !== "") {
      const ymd = parseHuDateInput(dueDisplay);
      if (!ymd) {
        form.setError("dueDate", { message: "payments:due_date_invalid" });
        return;
      }
      values.dueDate = ymd;
    }
    const payload: PaymentCreateUpdateDTO = {
      projectId,
      amount: values.amount === "" ? 0 : Number(values.amount),
      dueDate: values.dueDate,
      status: values.status,
      note: values.note ? values.note : null,
      createdBy: values.createdBy ?? "manual",
    };

    if (values.status === "paid") {
      if (paidDisplay.trim() !== "") {
        const ymd = parseHuDateInput(paidDisplay);
        if (!ymd) {
          form.setError("paidAt", { message: "payments:paid_at_invalid" });
          return;
        }
        const [y, m, d] = ymd.split("-").map(Number);
        payload.paidAt = new Date(y, m - 1, d).toISOString();
      } else {
        // No explicit date — keep the stored one, else stamp now().
        payload.paidAt = initialData?.paidAt ?? new Date().toISOString();
      }
    }

    onSubmit(payload);
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
                ? t("payments:create_payment")
                : t("payments:edit_payment")}
            </CardTitle>
            <CardDescription>
              {mode === "create"
                ? t("payments:create_payment_description")
                : t("payments:edit_payment_title")}
            </CardDescription>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Amount */}
            <FormField
              control={form.control}
              name="amount"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments:amount")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <CircleDollarSign className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        type="number"
                        min={0}
                        step="1"
                        placeholder={t("payments:amount_placeholder")}
                        className="pl-10 pr-12"
                        {...field}
                      />
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground pointer-events-none select-none">
                        Ft
                      </span>
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.amount?.message &&
                      t(form.formState.errors.amount.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Due date — Hungarian text input, never the browser-locale picker */}
            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments:due_date")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <CalendarDays className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                      <Input
                        type="text"
                        inputMode="numeric"
                        placeholder={t("payments:due_date_placeholder")}
                        className="pl-10"
                        name={field.name}
                        ref={field.ref}
                        onBlur={field.onBlur}
                        value={dueDisplay}
                        onChange={(e) => {
                          const formatted = formatHuDateInput(e.target.value);
                          setDueDisplay(formatted);
                          field.onChange(parseHuDateInput(formatted) ?? "");
                        }}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.dueDate?.message &&
                      t(form.formState.errors.dueDate.message as string)}
                  </FormMessage>
                </FormItem>
              )}
            />

            {/* Status */}
            <FormField
              control={form.control}
              name="status"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("payments:status")}</FormLabel>
                  <FormControl>
                    <Controller
                      control={form.control}
                      name="status"
                      render={({ field: ctrlField }) => (
                        <Select
                          value={ctrlField.value}
                          onValueChange={(v) =>
                            ctrlField.onChange(v as PaymentStatus)
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder={t("payments:status")} />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((s) => (
                              <SelectItem key={s} value={s}>
                                {t(`payments:status_${s}`)}
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
            {statusValue === "paid" && (
              <FormField
                control={form.control}
                name="paidAt"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("payments:paid_at")}</FormLabel>
                    <FormControl>
                      <div className="relative">
                        <CalendarDays className="absolute left-3 top-1/2 h-4 w-4 text-gray-400 transform -translate-y-1/2" />
                        <Input
                          type="text"
                          inputMode="numeric"
                          placeholder={t("payments:due_date_placeholder")}
                          className="pl-10"
                          name={field.name}
                          ref={field.ref}
                          onBlur={field.onBlur}
                          value={paidDisplay}
                          onChange={(e) => {
                            const formatted = formatHuDateInput(e.target.value);
                            setPaidDisplay(formatted);
                            const ymd = parseHuDateInput(formatted);
                            if (!ymd) {
                              field.onChange("");
                              return;
                            }
                            const [y, m, d] = ymd.split("-").map(Number);
                            field.onChange(
                              new Date(y, m - 1, d).toISOString(),
                            );
                          }}
                        />
                      </div>
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {t("payments:paid_at_hint")}
                    </p>
                    <FormMessage>
                      {form.formState.errors.paidAt?.message &&
                        t(form.formState.errors.paidAt.message as string)}
                    </FormMessage>
                  </FormItem>
                )}
              />
            )}

            {/* Note */}
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("payments:note")}</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <MessageSquare className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
                      <textarea
                        rows={4}
                        placeholder={t("payments:note_placeholder")}
                        maxLength={5000}
                        className="flex w-full rounded-md border border-input bg-background pl-10 pr-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage>
                    {form.formState.errors.note?.message &&
                      t(form.formState.errors.note.message as string)}
                  </FormMessage>
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
              : mode === "create"
                ? t("common:create")
                : t("common:save")}
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default PaymentForm;