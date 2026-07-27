// ----------------------------------------------------------------------------
// AiLanguageConfig — language configuration sub-form used inside
// AiAssistantConfigForm. Manages supportedLanguages array and the
// translations array with _delete flags for removed rows.
// ----------------------------------------------------------------------------

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Globe } from "lucide-react";
import type { AiAssistantTranslationDTO } from "@/types/ai-assistant";

// Common languages list for the selector
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

interface AiLanguageConfigProps {
  supportedLanguages: string[];
  translations: AiAssistantTranslationDTO[];
  onChange: (
    supportedLanguages: string[],
    translations: AiAssistantTranslationDTO[],
  ) => void;
}

export function AiLanguageConfig({
  supportedLanguages,
  translations,
  onChange,
}: AiLanguageConfigProps) {
  const { t } = useTranslation(["ai-assistant", "common"]);
  const [addLanguageValue, setAddLanguageValue] = useState("");

  const getTranslationForLanguage = (lang: string) =>
    translations.find((tr) => tr.language === lang);

  const handleAddLanguage = (langCode: string) => {
    if (!langCode || supportedLanguages.includes(langCode)) return;
    const newSupported = [...supportedLanguages, langCode];
    // Create an empty translation row for the new language
    const newTranslation: AiAssistantTranslationDTO = {
      id: 0,
      assistantId: 0,
      language: langCode,
      displayName: null,
      greetingMessage: null,
      placeholder: null,
      createdAt: "",
      updatedAt: "",
    };
    const newTranslations = [...translations, newTranslation];
    onChange(newSupported, newTranslations);
    setAddLanguageValue("");
  };

  const handleRemoveLanguage = (langCode: string) => {
    const newSupported = supportedLanguages.filter((l) => l !== langCode);
    const newTranslations = translations
      .map((tr) => {
        if (tr.language === langCode && tr.id > 0) {
          // Mark existing translation for deletion
          return { ...tr, _delete: true } as AiAssistantTranslationDTO & {
            _delete?: boolean;
          };
        }
        return tr;
      })
      .filter((tr) => {
        // Filter out new (unsaved) translations for the removed language
        if (tr.language === langCode && tr.id === 0) return false;
        return true;
      });
    onChange(newSupported, newTranslations as AiAssistantTranslationDTO[]);
  };

  const handleTranslationFieldChange = (
    langCode: string,
    field: "displayName" | "greetingMessage" | "placeholder",
    value: string,
  ) => {
    let newTranslations = translations.map((tr) => {
      if (tr.language === langCode) {
        return { ...tr, [field]: value || null };
      }
      return tr;
    });
    // If no translation row exists yet, create one
    if (!translations.find((tr) => tr.language === langCode)) {
      const newTranslation: AiAssistantTranslationDTO = {
        id: 0,
        assistantId: 0,
        language: langCode,
        displayName: null,
        greetingMessage: null,
        placeholder: null,
        createdAt: "",
        updatedAt: "",
        [field]: value || null,
      };
      newTranslations = [...newTranslations, newTranslation];
    }
    onChange(supportedLanguages, newTranslations);
  };

  // Available languages for the add selector
  const availableLanguages = COMMON_LANGUAGES.filter(
    (l) => !supportedLanguages.includes(l.code),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Globe className="h-4 w-4 text-muted-foreground" />
        <div>
          <p className="text-sm font-medium">
            {t("ai-assistant:supported_languages")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("ai-assistant:supported_languages_help")}
          </p>
        </div>
      </div>

      {/* Add language selector */}
      <div className="flex items-center gap-2">
        <Select value={addLanguageValue} onValueChange={handleAddLanguage}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder={t("ai-assistant:add_translation")} />
          </SelectTrigger>
          <SelectContent>
            {availableLanguages.map((l) => (
              <SelectItem key={l.code} value={l.code}>
                {l.label} ({l.code})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Translation cards for each supported language */}
      {supportedLanguages.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("ai-assistant:translations_help")}
        </p>
      )}

      {supportedLanguages.map((langCode) => {
        const langLabel =
          COMMON_LANGUAGES.find((l) => l.code === langCode)?.label || langCode;
        const tr = getTranslationForLanguage(langCode);
        return (
          <Card key={langCode}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">
                  {langLabel} ({langCode})
                </CardTitle>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => handleRemoveLanguage(langCode)}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {t("ai-assistant:translation_delete")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <label className="text-sm font-medium">
                  {t("ai-assistant:translation_display_name")}
                </label>
                <Input
                  value={tr?.displayName ?? ""}
                  onChange={(e) =>
                    handleTranslationFieldChange(
                      langCode,
                      "displayName",
                      e.target.value,
                    )
                  }
                  placeholder={t("ai-assistant:display_name_placeholder")}
                />
              </div>
              <div>
                <label className="text-sm font-medium">
                  {t("ai-assistant:translation_greeting")}
                </label>
                <Textarea
                  value={tr?.greetingMessage ?? ""}
                  onChange={(e) =>
                    handleTranslationFieldChange(
                      langCode,
                      "greetingMessage",
                      e.target.value,
                    )
                  }
                  placeholder={t("ai-assistant:greeting_message_placeholder")}
                />
              </div>
              <div>
                <label className="text-sm font-medium">
                  {t("ai-assistant:translation_placeholder")}
                </label>
                <Input
                  value={tr?.placeholder ?? ""}
                  onChange={(e) =>
                    handleTranslationFieldChange(
                      langCode,
                      "placeholder",
                      e.target.value,
                    )
                  }
                  placeholder={"Type a message..."}
                />
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
