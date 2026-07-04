// ----------------------------------------------------------------------------
// FormSubmissionsList — paged DataTable of received form submissions.
// Submissions are opaque JSON bags (no per-field rendering — forms
// have no field schema). Opens FormSubmissionDetailsSheet on the
// "View details" action.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Eye } from "lucide-react";
import { getFormSubmissions } from "@/lib/forms";
import type { FormSubmissionDTO } from "@/types/form";
import { FormSubmissionDetailsSheet } from "@/components/forms/FormSubmissionDetailsSheet";

interface Props {
  formId: number;
}

interface QueryState {
  page: number;
  size: number;
  sortField: "submittedAt" | "ipAddress" | "locale" | "createdAt";
  sortOrder: "asc" | "desc";
  queries: string[];
  filterType: "any" | "all";
}

const maskIpv4 = (ip: string | null): string => {
  if (!ip) return "—";
  // IPv4 like "1.2.3.4" → "1.2.3.xxx"; IPv6 stays as-is.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
  }
  return ip;
};

export function FormSubmissionsList({ formId }: Props) {
  const { t } = useTranslation(["forms", "common"]);
  const [selectedSubmissionId, setSelectedSubmissionId] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const [queryState, setQueryState] = useState<QueryState>({
    page: 0,
    size: 10,
    sortField: "submittedAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const { data, isLoading } = useQuery({
    queryKey: ["form-submissions", formId, queryState],
    queryFn: () => getFormSubmissions(formId, queryState),
  });

  const handlePageChange = useCallback(
    (page: number) => setQueryState((s) => ({ ...s, page })),
    [],
  );
  const handlePageSizeChange = useCallback(
    (size: number) => setQueryState((s) => ({ ...s, size, page: 0 })),
    [],
  );
  const handleSearch = useCallback(
    (query: string) =>
      setQueryState((s) => ({
        ...s,
        queries: query ? [query] : [],
        page: 0,
      })),
    [],
  );
  const handleQueriesChange = useCallback(
    (queries: string[]) => setQueryState((s) => ({ ...s, queries, page: 0 })),
    [],
  );
  const handleFilterTypeChange = useCallback(
    (filterType: "any" | "all") =>
      setQueryState((s) => ({ ...s, filterType, page: 0 })),
    [],
  );
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryState((s) => ({
        ...s,
        sortField: sortField as QueryState["sortField"],
        sortOrder,
        page: 0,
      })),
    [],
  );

  const openDetails = (id: number) => {
    setSelectedSubmissionId(id);
    setSheetOpen(true);
  };

  const handleRowDoubleClick = (row: FormSubmissionDTO) =>
    openDetails(row.id);

  const columns = [
    {
      accessorKey: "submittedAt",
      header: t("forms:submission_submitted_at"),
      cell: (row: FormSubmissionDTO) =>
        new Date(row.submittedAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "ipAddress",
      header: t("forms:submission_ip"),
      cell: (row: FormSubmissionDTO) => maskIpv4(row.ipAddress),
      enableSorting: true,
    },
    {
      accessorKey: "locale",
      header: t("forms:submission_locale"),
      cell: (row: FormSubmissionDTO) => row.locale ?? "—",
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: FormSubmissionDTO) => (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => openDetails(row.id)}
          aria-label={t("forms:submission_view_json")}
          title={t("forms:submission_view_json")}
        >
          <Eye className="mr-1 h-4 w-4" />
          {t("forms:submission_view_json")}
        </Button>
      ),
    },
  ];

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("forms:submissions_section")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data as never}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            queries={queryState.queries}
            filterType={queryState.filterType}
            onQueriesChange={handleQueriesChange}
            onFilterTypeChange={handleFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handleSortChange}
            currentSortField={queryState.sortField}
            currentSortOrder={queryState.sortOrder}
            onRowDoubleClick={handleRowDoubleClick}
          />
        </CardContent>
      </Card>

      <FormSubmissionDetailsSheet
        formId={formId}
        submissionId={selectedSubmissionId}
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
          setSelectedSubmissionId(null);
        }}
      />
    </>
  );
}
