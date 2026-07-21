// ----------------------------------------------------------------------------
// ServiceProjectSelectorModal — thin wrapper around the shared
// ModalDatatableSelect that picks a single Project for the Service
// create form. Mirrors FaqProjectSelectorModal exactly — only the
// translations namespace differs (service vs faq).
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

interface ServiceProjectSelectorModalProps {
  selectedId?: number | null;
  onSelect: (project: ProjectDTO) => void;
}

export function ServiceProjectSelectorModal({
  selectedId,
  onSelect,
}: ServiceProjectSelectorModalProps) {
  const { t } = useTranslation(["service", "common"]);

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
        : t("service:project_placeholder")}
    </Button>
  );

  return (
    <ModalDatatableSelect<ProjectDTO>
      trigger={trigger}
      title={t("service:select_project_modal_title")}
      queryKey="service-project-picker"
      fetcher={async (params: QueryParams) => {
        try {
          return (await getAllProjectsPaged(params)) as Page<ProjectDTO>;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          showError(t("common:operation_failed", { error: message }));
          throw err;
        }
      }}
      columns={[{
        accessorKey: "name",
        header: t("projects:name", { ns: "projects" }),
        cell: (row) => row.name || "\u2014",
        enableSorting: true,
      },
      {
        accessorKey: "customerName",
        header: t("projects:customer", { ns: "projects" }),
        cell: (row) => row.customerName || "\u2014",
        enableSorting: true,
      },
      {
        accessorKey: "domainAddress",
        header: t("projects:domain", { ns: "projects" }),
        cell: (row) => row.domainAddress || "\u2014",
      }]}
      onSelect={(picked) => {
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
