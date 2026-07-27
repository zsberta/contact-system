// AiAssistantPortalDetailsForm — enduser-editable form for AI assistant
// branding, messaging, and language settings. Hides admin-only fields
// (AI model, base URL, base prompt, rate limits, security).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Palette, Globe, Loader2, Save } from "lucide-react";
import { showError, showSuccess } from "@/utils/toast";
import { AiLanguageConfig } from "@/components/ai-assistant/AiLanguageConfig";
import type {
  AiAssistantConfigDTO,
  AiAssistantUpdateDTO,
  AiAssistantTranslationDTO,
} from "@/types/ai-assistant";

// Subset of fields that endusers can edit
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

interface AiAssistantPortalDetailsFormProps {
  initialData: AiAssistantConfigDTO;
  onSubmit: (data: AiAssistantUpdateDTO) => void;
  isPending: boolean;
}

export default function AiAssistantPortalDetailsForm({
  initialData,
  onSubmit,
  isPending,
}: AiAssistantPortalDetailsFormProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);

  const [supportedLanguages, setSupportedLanguages] = useState<string[]>(
    initialData.supportedLanguages || [initialData.defaultLanguage || "en"],
  );
  const [translations, setTranslations] = useState<
    (AiAssistantTranslationDTO & { _delete?: boolean })[]
  >(initialData.translations || []);

  const formSchema = z.object({
    displayName: z.string().max(100).optional(),
    primaryColor: z.string().optional(),
    secondaryColor: z.string().optional(),
    greetingMessage: z.string().max(2000).optional(),
    legalMessage: z.string().max(5000).optional(),
    popupMessage: z.string().max(5000).optional(),
    basePrompt: z.string().max(10000).optional(),
    avatarUrl: z.string().nullable().optional(),
    position: z.enum(["bottom-right", "bottom-left"]).optional(),
    defaultLanguage: z.string().optional(),
  });

  type FormData = z.infer<typeof formSchema>;

  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      displayName: initialData.displayName ?? "",
      primaryColor: initialData.primaryColor ?? "#3b82f6",
      secondaryColor: initialData.secondaryColor ?? "#1e40af",
      greetingMessage: initialData.greetingMessage ?? "",
      legalMessage: initialData.legalMessage ?? "",
      popupMessage: initialData.popupMessage ?? "",
      basePrompt: initialData.basePrompt ?? "",
      avatarUrl: initialData.avatarUrl ?? null,
      position: initialData.position ?? "bottom-right",
      defaultLanguage: initialData.defaultLanguage ?? "en",
    },
  });

  const handleSubmit = (values: FormData) => {
    const translationUpdates = translations.map((tr) => ({
      id: tr.id > 0 ? tr.id : undefined,
      language: tr.language,
      displayName: tr.displayName,
      greetingMessage: tr.greetingMessage,
      placeholder: tr.placeholder,
      _delete: tr._delete,
    }));

    const payload: AiAssistantUpdateDTO = {
      displayName: values.displayName,
      primaryColor: values.primaryColor,
      secondaryColor: values.secondaryColor,
      greetingMessage: values.greetingMessage,
      legalMessage: values.legalMessage,
      popupMessage: values.popupMessage,
      basePrompt: values.basePrompt,
      avatarUrl: values.avatarUrl || null,
      position: values.position,
      defaultLanguage: values.defaultLanguage,
      supportedLanguages,
      translations: translationUpdates,
    };
    onSubmit(payload);
  };

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(handleSubmit)}
        className="max-w-2xl mx-auto space-y-6 w-full"
      >
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
              name="legalMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:legal_message")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("ai-assistant:legal_message_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:legal_message_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="popupMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:popup_message")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("ai-assistant:popup_message_placeholder")}
                      {...field}
                    />
                  </FormControl>
                  <FormDescription>
                    {t("ai-assistant:popup_message_help")}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="greetingMessage"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("ai-assistant:greeting_message")}</FormLabel>
                  <FormControl>
                    <Textarea
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

        {/* Submit */}
        <div className="flex justify-end">
          <Button type="submit" disabled={isPending}>
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            {t("common:save")}
          </Button>
        </div>
      </form>
    </Form>
  );
}
