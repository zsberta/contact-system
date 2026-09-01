// ----------------------------------------------------------------------------
// useDataTableQuery — shared query state for every paged DataTable page.
// Owns page/size/search-text/query-chips/filter-type/sort state and the
// handlers DataTable expects. Every mutation except page changes resets the
// page to 0, matching the convention all list pages follow.
// ----------------------------------------------------------------------------

import { useCallback, useState } from "react";

export interface DataTableQueryState {
  page: number;
  size: number;
  searchText: string;
  queries: string[];
  filterType: "any" | "all";
  sortField: string;
  sortOrder: "asc" | "desc";
}

interface UseDataTableQueryOptions {
  defaultSize?: number;
  defaultSortField?: string;
  defaultSortOrder?: "asc" | "desc";
}

export function useDataTableQuery({
  defaultSize = 10,
  defaultSortField = "",
  defaultSortOrder = "asc",
}: UseDataTableQueryOptions = {}) {
  const [query, setQuery] = useState<DataTableQueryState>({
    page: 0,
    size: defaultSize,
    searchText: "",
    queries: [],
    filterType: "any",
    sortField: defaultSortField,
    sortOrder: defaultSortOrder,
  });

  const update = useCallback(
    (patch: Partial<DataTableQueryState>, resetPage = false) => {
      setQuery((s) => ({ ...s, ...patch, ...(resetPage ? { page: 0 } : {}) }));
    },
    [],
  );

  const handlers = {
    onPageChange: useCallback(
      (page: number) => update({ page }),
      [update],
    ),
    onPageSizeChange: useCallback(
      (size: number) => update({ size }, true),
      [update],
    ),
    onSearchTextChange: useCallback(
      (searchText: string) => update({ searchText }, true),
      [update],
    ),
    onQueriesChange: useCallback(
      (queries: string[]) => update({ queries }, true),
      [update],
    ),
    onFilterTypeChange: useCallback(
      (filterType: "any" | "all") => update({ filterType }, true),
      [update],
    ),
    onSortChange: useCallback(
      (sortField: string, sortOrder: "asc" | "desc") =>
        update({ sortField, sortOrder }, true),
      [update],
    ),
  } as const;

  return { query, handlers } as const;
}
