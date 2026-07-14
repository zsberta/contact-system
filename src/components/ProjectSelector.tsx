// ProjectSelector — dropdown to switch between the enduser's assigned
// projects. Rendered at the top of the portal layout.

import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, FolderOpen } from "lucide-react";
import type { ProjectDTO } from "@/types/project";

interface Props {
  projects: ProjectDTO[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  isLoading?: boolean;
}

export function ProjectSelector({
  projects,
  selectedId,
  onSelect,
  isLoading,
}: Props) {
  const { t } = useTranslation(["enduser", "common"]);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("common:loading")}
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("enduser:no_projects")}
      </p>
    );
  }

  return (
    <Select
      value={selectedId ? String(selectedId) : undefined}
      onValueChange={(v) => onSelect(Number(v))}
    >
      <SelectTrigger className="w-[260px]">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <SelectValue placeholder={t("enduser:select_project")} />
        </div>
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={String(p.id)}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
