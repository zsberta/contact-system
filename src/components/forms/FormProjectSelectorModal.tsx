// ----------------------------------------------------------------------------
// FormProjectSelectorModal — thin wrapper around the shared
// ModalDatatableSelect that picks a single Project for the form create form.
// Reuses the existing projects API (getAllProjectsPaged). Single-select only
// because forms belong to exactly one project.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";
import { ModalDatatableSelect } from "@/components/ModalDatatableSelect";
import { getAllProjectsPaged, getProjectById } from "@/lib/api";
import { showError } from "@/utils/toast";
import { Page, QueryParams } from "@/types/common";
import type { ProjectDTO } from "@/types/project";

interface FormProjectSelectorModalProps {
  selectedId?: number | null;
  onSelect: (project: ProjectDTO) => void;
}

export function FormProjectSelectorModal({
  selectedId,
  onSelect,
}: FormProjectSelectorModalProps) {
  const { t } = useTranslation(["forms", "common"]);

  // Resolve the name of the currently-selected project for the trigger label.
  const { data: selected } = useQuery<ProjectDTO | null, Error>({
    queryKey: ["projects", selectedId],
    queryFn: async () => {
      if (!selectedId) return null;
      return getProjectById(selectedId);
    },
    enabled: !!selectedId,
  });

  const trigger = (
    <Button type="button" variant="outline" className="w-full justify-start">
      <Building2 className="mr-2 h-4 w-4" />
      {selected
        ? selected.name
        : t("forms:select_project_placeholder")}
    </Button>
  );

  return (
    <ModalDatatableSelect<ProjectDTO>
      trigger={trigger}
      title={t("forms:select_project_modal_title")}
      queryKey="form-project-picker"
      fetcher={async (params: QueryParams) => {
        try {
          return (await getAllProjectsPaged(params)) as Page<ProjectDTO>;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showError(t("common:operation_failed", { error: message }));
          throw err;
        }
      }}
      columns={[
        {
          accessorKey: "name",
          header: t("projects:name"),
          cell: (row) => row.name || "—",
          enableSorting: true,
        },
        {
          accessorKey: "customerName",
          header: t("projects:customer"),
          cell: (row) => row.customerName || "—",
          enableSorting: true,
        },
      ]}
      onSelect={(picked) => {
        // ModalDatatableSelect with returnFullObject=true + multiSelect=false
        // yields a single TData at runtime. The static union type includes
        // unreachable variants; narrow them out.
        if (typeof picked === "number") return;
        if (Array.isArray(picked)) {
          if (picked.length === 0) return;
          const first = picked[0];
          if (typeof first === "number") return;
          onSelect(first);
          return;
        }
        onSelect(picked);
      }}
      returnFullObject
      initialSelection={selectedId ? [selectedId] : []}
    />
  );
}
