// UsersPage — admin only.
//
// Two visual columns the rest of the app doesn't have:
//   * Role  — admin / enduser, with a badge.
//   * Invite status — "pending" (mustSetPassword) or "active".
//
// The enduser action set adds "resend invite" alongside the existing
// view / edit / delete actions. The list filter supports ?role=admin or
// ?role=enduser via the existing query string, but we don't expose that
// in the UI yet (out of scope for v1).

import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Badge } from "@/components/ui/badge";
import { PlusCircle } from "lucide-react";
import type { PageUserDTO, UserDTO } from "@/types/user";
import { getAllUsersPaged } from "@/lib/api";
import type { QueryParams } from "@/types/common";
import UserActions from "@/components/users/UserActions";

const UsersPage: React.FC = () => {
  const { t } = useTranslation(["users", "common"]);
  const navigate = useNavigate();

  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "createdAt",
    sortOrder: "desc",
    queries: [],
    filterType: "any",
  });

  const { data, isLoading } = useQuery<PageUserDTO, Error>({
    queryKey: ["users", queryParams],
    queryFn: () => getAllUsersPaged(queryParams),
  });

  const handlePageChange = useCallback(
    (page: number) => setQueryParams((p) => ({ ...p, page })),
    [],
  );
  const handlePageSizeChange = useCallback(
    (size: number) => setQueryParams((p) => ({ ...p, size, page: 0 })),
    [],
  );
  const handleQueriesChange = useCallback(
    (queries: string[]) => setQueryParams((p) => ({ ...p, queries, page: 0 })),
    [],
  );
  const handleFilterTypeChange = useCallback(
    (filterType: "any" | "all") =>
      setQueryParams((p) => ({ ...p, filterType, page: 0 })),
    [],
  );
  const handleSearch = useCallback(
    (query: string) =>
      setQueryParams((p) => ({
        ...p,
        queries: query ? [query] : [],
        page: 0,
      })),
    [],
  );
  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") =>
      setQueryParams((p) => ({ ...p, sortField, sortOrder, page: 0 })),
    [],
  );
  const handleRowDoubleClick = useCallback(
    (row: UserDTO) => navigate(`/users/view/${row.id}`),
    [navigate],
  );

  const columns = [
    {
      accessorKey: "id",
      header: t("common:id"),
      cell: (row: UserDTO) => row.id,
      enableSorting: true,
    },
    {
      accessorKey: "firstName",
      header: t("users:full_name"),
      cell: (row: UserDTO) => `${row.lastName} ${row.firstName}`,
      enableSorting: true,
    },
    {
      accessorKey: "email",
      header: t("common:email"),
      cell: (row: UserDTO) => row.email,
      enableSorting: true,
    },
    {
      accessorKey: "role",
      header: t("users:role"),
      cell: (row: UserDTO) => (
        <Badge variant={row.role === "admin" ? "default" : "secondary"}>
          {t(`users:role_${row.role}`)}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "createdAt",
      header: t("common:created_at"),
      cell: (row: UserDTO) => new Date(row.createdAt).toLocaleString(),
      enableSorting: true,
    },
    {
      accessorKey: "enabled",
      header: t("common:status"),
      cell: (row: UserDTO) => (
        <Badge variant={row.enabled ? "default" : "destructive"}>
          {row.enabled ? t("common:active") : t("common:disabled")}
        </Badge>
      ),
      enableSorting: true,
    },
    {
      accessorKey: "actions",
      header: t("common:actions"),
      cell: (row: UserDTO) => <UserActions user={row} />,
    },
  ];

  return (
    <div className="mx-auto w-full">
      <Card>
        <CardHeader className="flex flex-col space-y-4 pb-2">
          <CardTitle className="text-2xl font-bold break-words">
            {t("users:user_management")}
          </CardTitle>
          <div className="flex justify-start">
            <Link to="/users/create">
              <Button className="w-full sm:w-auto">
                <PlusCircle className="mr-2 h-4 w-4" />
                {t("users:create_user")}
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            data={data?.content || []}
            pageInfo={data}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            queries={queryParams.queries}
            filterType={queryParams.filterType}
            onQueriesChange={handleQueriesChange}
            onFilterTypeChange={handleFilterTypeChange}
            isLoading={isLoading}
            onSortChange={handleSortChange}
            currentSortField={queryParams.sortField || "createdAt"}
            currentSortOrder={queryParams.sortOrder || "desc"}
            onRowDoubleClick={handleRowDoubleClick}
          />
        </CardContent>
      </Card>
    </div>
  );
};

export default UsersPage;
