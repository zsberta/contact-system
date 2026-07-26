// ----------------------------------------------------------------------------
// AiAssistantConfigForm — shared create/edit form for AI assistant configs.
// Mirrors AnalyticsConfigForm structurally but much larger due to the
// AI, branding, language, and security sections.
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
import { Textarea } from "@/components/ui/textarea";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Copy,
  Lock,
  Trash2,
  Plus,
  Bot,
  Palette,
  Globe,
  Shield,
  Bookmark,
} from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type {
  AiAssistantConfigDTO,
  AiAssistantUpdateDTO,
  AiAssistantTranslationDTO,
} from "@/types/ai-assistant";
import {
  getAllAiConfigPresetsPaged,
  createAiConfigPreset,
} from "@/lib/ai-config-presets";
import { showError, showSuccess } from "@/utils/toast";
import { AiLanguageConfig } from "./AiLanguageConfig";
import { uploadAvatar, deleteAvatar } from "@/lib/ai-assistant";
import { Upload, X, Loader2, ImageIcon } from "lucide-react";
import { useRef } from "react";

interface AiAssistantConfigFormProps {
  initialData: AiAssistantConfigDTO | null;
  isSubmitting: boolean;
  onSubmit: (data: AiAssistantUpdateDTO) => void;
}

const COMMON_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hu", label: "Magyar" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
  { code: "nl", label: "Nederlands" },
  { code: "pl", label: "Polski" },
  { code: "cs", label: "Čeština" },
  { code: "ro", label: "Română" },
  { code: "sk", label: "Slovenčina" },
  { code: "hr", label: "Hrvatski" },
  { code: "sl", label: "Slovenščina" },
  { code: "sr", label: "Српски" },
  { code: "uk", label: "Українська" },
  { code: "ru", label: "Русский" },
  { code: "tr", label: "Türkçe" },
  { code: "zh", label: "中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "ar", label: "العربية" },
];

const formSchema = z.object({
  name: z.string().min(1, { message: "Required" }).max(200),
  model: z.string().optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  basePrompt: z.string().optional(),
  displayName: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),
  greetingMessage: z.string().optional(),
  avatarUrl: z.string().optional(),
  position: z.enum(["bottom-right", "bottom-left"]).optional(),
  defaultLanguage: z.string().optional(),
  rateLimitBurst: z.coerce.number().int().min(0).optional(),
  rateLimitSustained: z.coerce.number().int().min(0).optional(),
  maxUploadSizeMb: z.coerce.number().int().min(1).optional(),
});

type FormValues = z.infer<typeof formSchema>;

const AiAssistantConfigForm = ({
  initialData,
  isSubmitting,
  onSubmit,
}: AiAssistantConfigFormProps) => {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialData?.name ?? "",
      model: initialData?.model ?? "",
      baseUrl: initialData?.baseUrl ?? "",
      apiKey: "",
      basePrompt: initialData?.basePrompt ?? "",
      displayName: initialData?.displayName ?? "",
      primaryColor: initialData?.primaryColor ?? "#3b82f6",
      secondaryColor: initialData?.secondaryColor ?? "#1e40af",
      greetingMessage: initialData?.greetingMessage ?? "",
      avatarUrl: initialData?.avatarUrl ?? "",
      position: initialData?.position ?? "bottom-right",
      defaultLanguage: initialData?.defaultLanguage ?? "en",
      rateLimitBurst: initialData?.rateLimitBurst ?? 30,
      rateLimitSustained: initialData?.rateLimitSustained ?? 500,
      maxUploadSizeMb: initialData?.maxUploadSizeMb ?? 10,
    },
  });

  // Lifted state for dynamic lists
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>(() => {
    if (initialData && Array.isArray(initialData.allowedOrigins)) {
      return initialData.allowedOrigins.filter((d) => typeof d === "string");
    }
    return [];
  });

  const [supportedLanguages, setSupportedLanguages] = useState<string[]>(
    () => initialData?.supportedLanguages ?? [],
  );

  const [translations, setTranslations] = useState<AiAssistantTranslationDTO[]>(
    () => initialData?.translations ?? [],
  );

  // Preset state
  const [isPresetDialogOpen, setIsPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const { data: presetsData } = useQuery({
    queryKey: ["ai-config-presets"],
    queryFn: () =>
      getAllAiConfigPresetsPaged({
        page: 0,
        size: 100,
        sortField: "name",
        sortOrder: "asc",
      }),
  });

  const presets = presetsData?.content ?? [];

  const savePresetMutation = useMutation({
    mutationFn: (name: string) =>
      createAiConfigPreset({
        name,
        model: form.getValues("model") ?? "",
        baseUrl: form.getValues("baseUrl") ?? "",
        basePrompt: form.getValues("basePrompt") ?? "",
      }),
    onSuccess: () => {
      showSuccess(t("ai-assistant:preset_saved"));
      setIsPresetDialogOpen(false);
      setPresetName("");
    },
    onError: (err: Error) => {
      showError(t("common:operation_failed", { error: err.message }));
    },
  });

  const handleLoadPreset = (presetId: string) => {
    const preset = presets.find((p) => p.id === Number(presetId));
    if (!preset) return;
    form.setValue("model", preset.model);
    form.setValue("baseUrl", preset.baseUrl);
    form.setValue("basePrompt", preset.basePrompt);
    showSuccess(t("ai-assistant:preset_loaded"));
  };

  const handleSubmit = (values: FormValues) => {
    const cleanedOrigins = allowedOrigins
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    // Build translations array with _delete flags
    const translationUpdates = translations.map((tr) => ({
      id: tr.id > 0 ? tr.id : undefined,
      language: tr.language,
      displayName: tr.displayName,
      greetingMessage: tr.greetingMessage,
      placeholder: tr.placeholder,
      _delete: (tr as AiAssistantTranslationDTO & { _delete?: boolean })
        ._delete,
    }));

    const payload: AiAssistantUpdateDTO = {
      name: values.name.trim(),
      model: values.model,
      baseUrl: values.baseUrl,
      ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      basePrompt: values.basePrompt,
      displayName: values.displayName,
      primaryColor: values.primaryColor,
      secondaryColor: values.secondaryColor,
      greetingMessage: values.greetingMessage,
      avatarUrl: values.avatarUrl || null,
      position: values.position,
      allowedOrigins: cleanedOrigins,
      defaultLanguage: values.defaultLanguage,
      supportedLanguages,
      translations: translationUpdates,
      rateLimitBurst: values.rateLimitBurst,
      rateLimitSustained: values.rateLimitSustained,
      maxUploadSizeMb: values.maxUploadSizeMb,
    };
    onSubmit(payload);
  };

  const copySecretToken = async () => {
    if (!initialData?.secretToken) return;
    const token = initialData.secretToken;
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
        showSuccess(t("ai-assistant:secret_token_copied"));
      } else {
        const ta = document.createElement("textarea");
        ta.value = token;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        showSuccess(t("ai-assistant:secret_token_copied"));
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
              {initialData
                ? t("ai-assistant:edit_ai_assistant")
                : t("ai-assistant:create_ai_assistant")}
            </CardTitle>
            {initialData && (
              <CardDescription>{initialData.name}</CardDescription>
            )}
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Project (read-only) */}
            {initialData && (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  {t("ai-assistant:project")}
                </FormLabel>
                <FormControl>
                  <Input
                    readOnly
                    value={initialData.projectName ?? ""}
                    title={t("ai-assistant:project_immutable_tooltip")}
                    aria-readonly
                    className="bg-muted"
                  />
                </FormControl>
              </FormItem>
            )}

            {/* Name */}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("ai-assistant:name")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("ai-assistant:name_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:name_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Secret Token (read-only) */}
            {initialData?.secretToken && (
              <FormItem>
                <FormLabel className="flex items-center gap-2">
                  <Lock className="h-4 w-4" />
                  {t("ai-assistant:secret_token")}
                </FormLabel>
                <div className="flex items-center gap-2">
                  <FormControl>
                    <Input
                      readOnly
                      value={initialData.secretToken}
                      className="font-mono text-xs bg-muted"
                    />
                  </FormControl>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={copySecretToken}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <FormDescription>
                  {t("ai-assistant:secret_token_help")}
                </FormDescription>
              </FormItem>
            )}
          </CardContent>
        </Card>

        {/* AI Configuration */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-5 w-5" />
              {t("ai-assistant:ai_config_section")}
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            <FormField
              control={form.control}
              name="model"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:model")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("ai-assistant:model_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="baseUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:base_url")}</FormLabel>
                  <FormControl>
                    <Input placeholder="https://api.openai.com/v1" {...field} />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:base_url_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="apiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:api_key")}</FormLabel>
                  <FormControl>
                    <Input
                      type="password"
                      placeholder={
                        initialData
                          ? t("common:leave_blank_to_keep_current")
                          : t("ai-assistant:api_key_placeholder")
                      }
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:api_key_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="basePrompt"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:base_prompt")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("ai-assistant:base_prompt_placeholder")}
                      rows={6}
                      className="resize-y"
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:base_prompt_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Presets */}
            <div className="space-y-3">
              <Separator />
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bookmark className="h-4 w-4 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {t("ai-assistant:preset_section")}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsPresetDialogOpen(true)}
                >
                  <Bookmark className="mr-2 h-3 w-3" />
                  {t("ai-assistant:preset_save")}
                </Button>
              </div>
              {presets.length > 0 && (
                <div className="flex items-center gap-2">
                  <Select onValueChange={handleLoadPreset}>
                    <SelectTrigger className="w-full">
                      <SelectValue
                        placeholder={t("ai-assistant:preset_load")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((preset) => (
                        <SelectItem
                          key={preset.id}
                          value={String(preset.id)}
                        >
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Widget Branding */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Palette className="h-5 w-5" />
              {t("ai-assistant:branding_section")}
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:display_name")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("ai-assistant:display_name_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:display_name_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="primaryColor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("ai-assistant:primary_color")}</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={field.value || "#3b82f6"}
                          onChange={field.onChange}
                          className="h-8 w-8 cursor-pointer rounded border"
                        />
                        <Input
                          value={field.value || ""}
                          onChange={field.onChange}
                          className="flex-1"
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="secondaryColor"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("ai-assistant:secondary_color")}</FormLabel>
                    <FormControl>
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          value={field.value || "#1e40af"}
                          onChange={field.onChange}
                          className="h-8 w-8 cursor-pointer rounded border"
                        />
                        <Input
                          value={field.value || ""}
                          onChange={field.onChange}
                          className="flex-1"
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="greetingMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:greeting_message")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t(
                        "ai-assistant:greeting_message_placeholder",
                      )}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:greeting_message_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="avatarUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:avatar_url")}</FormLabel>
                  <FormControl>
                    <AvatarUploader
                      value={field.value || ""}
                      onChange={field.onChange}
                      assistantId={initialData?.id}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:avatar_url_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="position"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:position")}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="bottom-right">
                        {t("ai-assistant:position_bottom_right")}
                      </SelectItem>
                      <SelectItem value="bottom-left">
                        {t("ai-assistant:position_bottom_left")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Language & Localization */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              {t("ai-assistant:language_section")}
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            <FormField
              control={form.control}
              name="defaultLanguage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:default_language")}</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COMMON_LANGUAGES.map((l) => (
                        <SelectItem key={l.code} value={l.code}>
                          {l.label} ({l.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    {t("ai-assistant:default_language_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Separator />

            <AiLanguageConfig
              supportedLanguages={supportedLanguages}
              translations={translations}
              onChange={(langs, trs) => {
                setSupportedLanguages(langs);
                setTranslations(trs);
              }}
            />
          </CardContent>
        </Card>

        {/* Security */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              {t("ai-assistant:security_section")}
            </CardTitle>
          </CardHeader>
          <Separator />
          <CardContent className="pt-6 space-y-6">
            {/* Allowed Origins */}
            <div className="space-y-3">
              <FormLabel>{t("ai-assistant:allowed_origins_label")}</FormLabel>
              <FormDescription>
                {t("ai-assistant:allowed_origins_help")}
              </FormDescription>
              {allowedOrigins.map((origin, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={origin}
                    placeholder={t("ai-assistant:allowed_origins_placeholder")}
                    onChange={(e) => {
                      const updated = [...allowedOrigins];
                      updated[idx] = e.target.value;
                      setAllowedOrigins(updated);
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() =>
                      setAllowedOrigins(
                        allowedOrigins.filter((_, i) => i !== idx),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAllowedOrigins([...allowedOrigins, ""])}
              >
                <Plus className="mr-2 h-3 w-3" />
                {t("ai-assistant:allowed_origins_add")}
              </Button>
              {allowedOrigins.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("ai-assistant:allowed_origins_empty_warning")}
                </p>
              )}
            </div>

            <Separator />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="rateLimitBurst"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("ai-assistant:rate_limit_burst")}</FormLabel>
                    <FormControl>
                      <Input type="number" min={0} {...field} />
                    </FormControl>
                    <FormDescription>
                      {t("ai-assistant:rate_limit_burst_help")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="rateLimitSustained"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("ai-assistant:rate_limit_sustained")}
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} {...field} />
                    </FormControl>
                    <FormDescription>
                      {t("ai-assistant:rate_limit_sustained_help")}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="maxUploadSizeMb"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:max_upload_size")}</FormLabel>
                  <FormControl>
                    <Input type="number" min={1} {...field} />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:max_upload_size_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>

        {/* Submit */}
        <div className="flex justify-end gap-2">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? t("common:saving") : t("common:save")}
          </Button>
        </div>
      </form>

      {/* Save as Preset Dialog */}
      <Dialog open={isPresetDialogOpen} onOpenChange={setIsPresetDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ai-assistant:preset_save")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              placeholder={t("ai-assistant:preset_name_placeholder")}
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsPresetDialogOpen(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button
              onClick={() => {
                if (presetName.trim()) {
                  savePresetMutation.mutate(presetName.trim());
                }
              }}
              disabled={!presetName.trim() || savePresetMutation.isPending}
            >
              {savePresetMutation.isPending
                ? t("common:saving")
                : t("ai-assistant:preset_create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Form>
  );
};

export default AiAssistantConfigForm;

// ---------------------------------------------------------------------------
// AvatarUploader — inline image upload for the assistant's widget avatar.
// Uploads to POST /api/ai-assistant/:id/avatar, shows preview, supports delete.
// ---------------------------------------------------------------------------
function AvatarUploader({
  value,
  onChange,
  assistantId,
}: {
  value: string;
  onChange: (url: string | null) => void;
  assistantId?: number;
}) {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !assistantId) return;

    setUploading(true);
    try {
      const result = await uploadAvatar(assistantId, file);
      onChange(result.avatarUrl);
      showSuccess(t("ai-assistant:avatar_url") + " uploaded");
    } catch (err: any) {
      showError(err.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (!assistantId) {
      onChange(null);
      return;
    }
    try {
      await deleteAvatar(assistantId);
      onChange(null);
    } catch (err: any) {
      showError(err.message || "Delete failed");
    }
  };

  return (
    <div className="flex items-center gap-4">
      {/* Preview */}
      <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border bg-muted flex items-center justify-center">
        {value ? (
          <>
            <img src={value} alt="Avatar" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={handleDelete}
              className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-white shadow-sm hover:bg-destructive/90"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground" />
        )}
      </div>

      {/* Upload button */}
      <div className="flex-1">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/webp,image/png,image/jpeg,image/avif"
          className="hidden"
          onChange={handleUpload}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={uploading || !assistantId}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Upload className="mr-2 h-4 w-4" />
          )}
          {value ? "Change" : "Upload"}
        </Button>
        <p className="mt-1 text-xs text-muted-foreground">
          PNG, JPG, WebP. Max 2 MB.
        </p>
      </div>
    </div>
  );
}
