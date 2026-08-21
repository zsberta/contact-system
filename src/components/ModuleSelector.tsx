// ModuleSelector — dropdown to switch between modules in the selected project.
// Hidden when there is only one or zero modules; automatic selection remains active.

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Layers } from "lucide-react";
import type { ProjectModuleDTO } from "@/types/project-module";

interface Props {
  modules: ProjectModuleDTO[];
  selectedModule: ProjectModuleDTO | null;
  onSelect: (moduleId: number) => void;
  isLoading?: boolean;
}

export function ModuleSelector({
  modules,
  selectedModule,
  onSelect,
  isLoading,
}: Props) {
  const { t } = useTranslation(["navigation", "common"]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground px-3 py-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("common:loading")}
      </div>
    );
  }

  // Hide when there is only one or zero modules — automatic selection is active.
  if (modules.length <= 1) {
    return null;
  }

  return (
    <Select
      value={selectedModule ? String(selectedModule.id) : undefined}
      onValueChange={(v) => onSelect(Number(v))}
    >
      <SelectTrigger className="w-full">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder={t("navigation:select_module")} />
        </div>
      </SelectTrigger>
      <SelectContent>
        {modules.map((m) => {
          const key = `navigation:${m.kind === "ai-assistant" ? "ai_assistant" : m.kind}`;
          const translated = t(key);
          return (
            <SelectItem key={m.id} value={String(m.id)}>
              {m.label || (translated !== key ? translated : m.kind.charAt(0).toUpperCase() + m.kind.slice(1))}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
