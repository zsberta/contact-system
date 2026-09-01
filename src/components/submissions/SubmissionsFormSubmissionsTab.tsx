// SubmissionsFormSubmissionsTab — paged DataTable of form submissions across
// all projects the user can access. Opens SubmissionDetailModal on click.
// Enduser view: Name, Phone, Submitted, triple-dot actions.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MoreVertical, Eye } from "lucide-react";
import { getSubmissionForms } from "@/lib/submissions";
import type { SubmissionFormDTO } from "@/types/submissions";
import { useDataTableQuery } from "@/hooks/useDataTableQuery";
import {
  SubmissionDetailModal,
  type SubmissionDetailData,
} from "@/components/submissions/SubmissionDetailModal";

interface Props {
  projectId?: number;
}

function extractFromData(
  data: Record<string, unknown> | null | undefined,
  keys: string[],
): string | null {
  if (!data) return null;
  for (const key of keys) {
    const val = data[key];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

export default function SubmissionsFormSubmissionsTab({ projectId }: Props) {
  const { t } = useTranslation(["submissions", "common"]);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedSubmission, setSelectedSubmission] =
    useState<SubmissionDetailData | null>(null);
  const [modalTitle, setModalTitle] = useState("");

  const { query, handlers } = useDataTableQuery({
    defaultSize: 10,
    defaultSortField: "submittedAt",
    defaultSortOrder: "desc",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["submission-forms", projectId, query],
    queryFn: () => getSubmissionForms({ ...query, projectId }),
  });

  const openDetails = (row: SubmissionFormDTO) => {
    setSelectedSubmission({
      submittedAt: row.submittedAt,
      data: row.data,
    });
    setModalTitle(`${row.formName} \u2014 ${row.projectName}`);
    setModalOpen(true);
  };

  const columns = [
    {
      accessorKey: "name",
      header: t("common:name"),
      cell: (row: SubmissionFormDTO) => {
        const name = extractFromData(row.data, ["name", "fullname", "yourname"]);
        return <span className="font-medium truncate">{name || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "email",
      header: t("common:email"),
      cell: (row: SubmissionFormDTO) => {
        const email = extractFromData(row.data, ["email", "mail", "emailaddress"]);
        return <span className="truncate">{email || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "phone",
      header: t("common:phone_number"),
      cell: (row: SubmissionFormDTO) => {
        const phone = extractFromData(row.data, [
          "phone",
          "tel",
          "telefon",
          "phonenumber",
        ]);
        return <span className="truncate">{phone || "\u2014"}</span>;
      },
      enableSorting: false,
    },
    {
      accessorKey: "submittedAt",
      header: t("submissions:submitted_at"),
      cell: (row: SubmissionFormDTO) =>
        new Date(row.submittedAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: SubmissionFormDTO) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <span className="sr-only">{t("common:actions")}</span>
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openDetails(row)}>
              <Eye className="mr-2 h-4 w-4" />
              {t("common:view")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <>
      <Card>
        <CardContent className="pt-6">
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data as never}
            onPageChange={handlers.onPageChange}
            onPageSizeChange={handlers.onPageSizeChange}
            onSearch={(search) => handlers.onQueriesChange(search ? [search] : [])}
            queries={query.queries}
            filterType={query.filterType}
            onQueriesChange={handlers.onQueriesChange}
            onFilterTypeChange={handlers.onFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handlers.onSortChange}
            currentSortField={query.sortField}
            currentSortOrder={query.sortOrder}
            emptyMessage={t("submissions:no_submissions")}
          />
        </CardContent>
      </Card>

      <SubmissionDetailModal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          setSelectedSubmission(null);
        }}
        title={modalTitle}
        submission={selectedSubmission}
      />
    </>
  );
}
