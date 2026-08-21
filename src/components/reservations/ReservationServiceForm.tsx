// ReservationServiceForm — create/edit form for reservation services.
// Uses RHF+zod + existing shadcn controls. Edits duration, price/currency,
// capacity, active/disabled, worker, order, translations, and custom fields.

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type {
  ReservationServiceDTO,
  ReservationServiceCreateDTO,
  ReservationServiceUpdateDTO,
  ReservationWorkerDTO,
} from "@/types/reservation";
import { Loader2 } from "lucide-react";
import { ReservationServiceImageUploader } from "./ReservationServiceImageUploader";

const serviceSchema = z.object({
  durationMinutes: z.number().min(1, "Duration must be at least 1 minute"),
  priceAmount: z.number().min(0, "Price must be non-negative"),
  currency: z.string().length(3, "Currency must be 3 letters"),
  capacity: z.number().min(1, "Capacity must be at least 1"),
  granularity: z.enum(["day", "hour", "minute"]),
  slotDurationMinutes: z.number().nullable().optional(),
  leadTimeMinutes: z.number().min(0),
  maxAdvanceDays: z.number().min(1),
  sortOrder: z.number().min(0),
  status: z.enum(["active", "disabled"]),
  workerUserId: z.number().nullable().optional(),
  nameHu: z.string().min(1, "Hungarian name is required"),
  descriptionHu: z.string().optional(),
  nameEn: z.string().optional(),
  descriptionEn: z.string().optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface ReservationServiceFormProps {
  service?: ReservationServiceDTO | null;
  workers: ReservationWorkerDTO[];
  onSubmit: (data: ReservationServiceCreateDTO | ReservationServiceUpdateDTO) => void;
  onCancel: () => void;
  isSubmitting?: boolean;
  /** Called when the service image is uploaded or deleted, so the parent can refresh data. */
  onImageChange?: () => void;
}

export const ReservationServiceForm: React.FC<ReservationServiceFormProps> = ({
  service,
  workers,
  onSubmit,
  onCancel,
  isSubmitting = false,
  onImageChange,
}) => {
  const { t } = useTranslation(["reservations", "common"]);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      durationMinutes: service?.durationMinutes ?? 60,
      priceAmount: service?.priceAmount ?? 0,
      currency: service?.currency ?? "HUF",
      capacity: service?.capacity ?? 1,
      granularity: service?.granularity ?? "hour",
      slotDurationMinutes: service?.slotDurationMinutes ?? null,
      leadTimeMinutes: service?.leadTimeMinutes ?? 60,
      maxAdvanceDays: service?.maxAdvanceDays ?? 90,
      sortOrder: service?.sortOrder ?? 0,
      status: service?.status ?? "active",
      workerUserId: service?.workerUserId != null ? Number(service.workerUserId) : null,
      nameHu: service?.name ?? "",
      descriptionHu: service?.description ?? "",
      nameEn: "",
      descriptionEn: "",
    },
  });

  // Load translations from service data
  useEffect(() => {
    if (service?.translations) {
      const huTrans = service.translations.find((t) => t.locale === "hu");
      const enTrans = service.translations.find((t) => t.locale === "en");
      if (huTrans) {
        setValue("nameHu", huTrans.name || "");
        setValue("descriptionHu", huTrans.description || "");
      }
      if (enTrans) {
        setValue("nameEn", enTrans.name || "");
        setValue("descriptionEn", enTrans.description || "");
      }
    }
  }, [service, setValue]);

  const handleFormSubmit = (values: ServiceFormValues) => {
    const translations: Record<string, { name: string; description?: string | null }> = {
      hu: { name: values.nameHu, description: values.descriptionHu || null },
    };
    if (values.nameEn) {
      translations.en = { name: values.nameEn, description: values.descriptionEn || null };
    }
    onSubmit({
      durationMinutes: values.durationMinutes,
      priceAmount: values.priceAmount,
      currency: values.currency,
      capacity: values.capacity,
      granularity: values.granularity,
      slotDurationMinutes: values.slotDurationMinutes ?? null,
      leadTimeMinutes: values.leadTimeMinutes,
      maxAdvanceDays: values.maxAdvanceDays,
      sortOrder: values.sortOrder,
      status: values.status,
      workerUserId: values.workerUserId || null,
      translations,
    });
  };

  const status = watch("status");
  const workerUserId = watch("workerUserId");

  return (
    <form onSubmit={handleSubmit(handleFormSubmit)} className="space-y-6">
      {/* Basic Info */}
      <Card>
        <CardHeader>
          <CardTitle>{t("reservations:service_details")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{t("reservations:duration_minutes")}</Label>
              <Input type="number" {...register("durationMinutes", { valueAsNumber: true })} />
              {errors.durationMinutes && <p className="text-sm text-destructive">{errors.durationMinutes.message}</p>}
            </div>
            <div>
              <Label>{t("reservations:capacity")}</Label>
              <Input type="number" {...register("capacity", { valueAsNumber: true })} />
              {errors.capacity && <p className="text-sm text-destructive">{errors.capacity.message}</p>}
            </div>
            <div>
              <Label>{t("reservations:price")}</Label>
              <Input type="number" step="0.01" {...register("priceAmount", { valueAsNumber: true })} />
            </div>
            <div>
              <Label>{t("reservations:currency")}</Label>
              <Input {...register("currency")} maxLength={3} />
            </div>
            <div>
              <Label>{t("reservations:sort_order")}</Label>
              <Input type="number" {...register("sortOrder", { valueAsNumber: true })} />
            </div>
            <div>
              <Label>{t("reservations:status")}</Label>
              <Select value={status} onValueChange={(v) => setValue("status", v as "active" | "disabled")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{t("reservations:active")}</SelectItem>
                  <SelectItem value="disabled">{t("reservations:disabled")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Scheduling config — separate from duration/capacity above */}
          <Separator />
          <p className="text-sm font-medium text-muted-foreground">Scheduling</p>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>{t("reservations:slot_duration_minutes")}</Label>
              <Input type="number" {...register("slotDurationMinutes", { valueAsNumber: true })} placeholder={t("reservations:slot_duration_minutes_placeholder")} />
              <p className="text-xs text-muted-foreground mt-1">{t("reservations:slot_duration_help")}</p>
            </div>
            <div>
              <Label>{t("reservations:lead_time_minutes")}</Label>
              <Input type="number" {...register("leadTimeMinutes", { valueAsNumber: true })} />
            </div>
            <div>
              <Label>{t("reservations:max_advance_days")}</Label>
              <Input type="number" {...register("maxAdvanceDays", { valueAsNumber: true })} />
            </div>
          </div>

          {/* Image upload — only in edit mode (service must exist first) */}
          {service?.id && (
            <ReservationServiceImageUploader
              serviceId={service.id}
              value={service.imageUrl ?? null}
              onChange={() => onImageChange?.()}
            />
          )}

          <div>
            <Label>{t("reservations:worker")}</Label>
            <Select
              value={workerUserId ? String(workerUserId) : "none"}
              onValueChange={(v) => setValue("workerUserId", v === "none" ? null : Number(v))}
            >
              <SelectTrigger>
                <SelectValue placeholder={t("reservations:no_worker")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("reservations:no_worker")}</SelectItem>
                {workers.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.lastName} {w.firstName} ({w.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Hungarian Translation */}
      <Card>
        <CardHeader>
          <CardTitle>{t("reservations:hungarian")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t("reservations:name")} *</Label>
            <Input {...register("nameHu")} />
            {errors.nameHu && <p className="text-sm text-destructive">{errors.nameHu.message}</p>}
          </div>
          <div>
            <Label>{t("reservations:description")}</Label>
            <Textarea {...register("descriptionHu")} rows={3} />
          </div>
        </CardContent>
      </Card>

      {/* English Translation (optional) */}
      <Card>
        <CardHeader>
          <CardTitle>{t("reservations:english_optional")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label>{t("reservations:name")}</Label>
            <Input {...register("nameEn")} placeholder={t("reservations:fallback_hint")} />
          </div>
          <div>
            <Label>{t("reservations:description")}</Label>
            <Textarea {...register("descriptionEn")} rows={3} placeholder={t("reservations:fallback_hint")} />
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t("common:cancel")}
        </Button>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {service ? t("common:save") : t("common:create")}
        </Button>
      </div>
    </form>
  );
};

export default ReservationServiceForm;
