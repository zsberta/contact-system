// ----------------------------------------------------------------------------
// ProjectForms — a card on the project view page that lists all forms
// belonging to a given project. Click → /forms/:id. Empty state offers
// a "Create form" button that deep-links to /forms/create?projectId=:id.
// ----------------------------------------------------------------------------

import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, PlusCircle } from "lucide-react";
import { getAllFormsPaged } from "@/lib/forms";
import type { FormStatus } from "@/types/form";

interface ProjectFormsProps {
  projectId: number;
}

const statusBadgeVariant = (status: FormStatus) => {
  return status === "disabled" ? ("destructive" as const) : ("default" as const);
};

export function ProjectForms({ projectId }: ProjectFormsProps) {
  const { t } = useTranslation(["forms", "common"]);
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ["forms", "project", projectId],
    queryFn: () =>
      getAllFormsPaged({
        projectId,
        page: 0,
        size: 100,
        sortField: "createdAt",
        sortOrder: "desc",
      }),
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="flex items-center gap-2 text-xl">
          <FileText className="h-5 w-5" />
          {t("forms:project_section_forms_title")}
        </CardTitle>
        <Button
          size="sm"
          onClick={() => navigate(`/forms/create?projectId=${projectId}`)}
        >
          <PlusCircle className="mr-2 h-4 w-4" />
          {t("forms:project_section_create_form")}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : !data || data.content.length === 0 ? (
          <p className="text-sm text-muted-foreground py-6 text-center">
            {t("forms:project_section_forms_empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {data.content.map((form) => (
              <li
                key={form.id}
                className="flex items-center justify-between p-3 border rounded-md cursor-pointer hover:bg-muted/50"
                onClick={() => navigate(`/forms/view/${form.id}`)}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{form.name}</p>
                    <p className="text-xs font-mono text-muted-foreground truncate">
                      {form.slug}
                    </p>
                  </div>
                </div>
                <Badge
                  variant={statusBadgeVariant(form.status)}
                  className="flex-shrink-0"
                >
                  {t(`forms:status_${form.status}`)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default ProjectForms;
