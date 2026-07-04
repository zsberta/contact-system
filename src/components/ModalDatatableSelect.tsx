// ----------------------------------------------------------------------------
// Ported verbatim from inventobee-it-fe (Users-bertazsolt-Documents-sajat-dev-inventobee-it-fe)
// src/components/ModalDatatableSelect.tsx. The implementation is the canonical
// shared "modal that wraps a DataTable for picking rows" component, used by
// selector modals across modules. The behaviour (multi-select with select-all,
// initial-selection merge, full object vs id-only return) matches the source
// file at the time of porting.
//
// Source-of-truth: [[Projects/inventobee/02-modules/asset-assignments/components]]
// (see also the ModalDatatableSelect usage examples in that doc).
//
// Only differences from the upstream file:
//   - Path aliases (`@/...`) align with the contact-system tsconfig — no edits.
//   - All required UI primitives (Dialog, Checkbox, Tooltip, DataTable, Button)
//     already exist in contact-system's `src/components/ui/` (see
//     [[Projects/contact-system/04-frontend/components]]).
// ----------------------------------------------------------------------------

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/DataTable";
import { Checkbox } from "@/components/ui/checkbox";
import { Page, QueryParams } from "@/types/common";
import { useQuery } from "@tanstack/react-query";
import { showError } from "@/utils/toast";

interface ModalDatatableSelectProps<TData> {
  trigger: React.ReactNode;
  title: string;
  fetcher: (params: QueryParams) => Promise<Page<TData>>;
  columns: ColumnDef<TData>[];
  onSelect: (selected: TData | TData[] | number | number[]) => void;
  multiSelect?: boolean;
  returnFullObject?: boolean;
  initialSelection?: TData[] | number[];
  queryKey: string;
}

interface ColumnDef<TData> {
  accessorKey: keyof TData | string;
  header: string;
  cell: (row: TData) => React.ReactNode;
  enableSorting?: boolean;
}

const EMPTY_ARRAY: unknown[] = [];

export function ModalDatatableSelect<TData extends { id: number }>({
  trigger,
  title,
  fetcher,
  columns,
  onSelect,
  multiSelect = false,
  returnFullObject = false,
  initialSelection = EMPTY_ARRAY as TData[] | number[],
  queryKey,
  isRowDisabled,
  getDisabledReason,
}: ModalDatatableSelectProps<TData> & {
  isRowDisabled?: (row: TData) => boolean;
  getDisabledReason?: (row: TData) => string;
}) {
  const { t } = useTranslation(["common"]);
  const [open, setOpen] = useState(false);

  interface SelectionState {
    selectedItems: Map<number, TData>;
    explicitlyDeselected: Set<number>;
    isSelectAll: boolean;
  }

  const [selectionState, setSelectionState] = useState<SelectionState>({
    selectedItems: new Map(),
    explicitlyDeselected: new Set(),
    isSelectAll: false,
  });
  const initializedRef = useRef(false);
  const [isFetchingAll, setIsFetchingAll] = useState(false);

  // Query state
  const [queryParams, setQueryParams] = useState<QueryParams>({
    page: 0,
    size: 10,
    sortField: "id",
    sortOrder: "asc",
    queries: [],
  });

  // Create a Set of initial selection IDs for efficient lookup
  const initialSelectionIds = React.useMemo(() => {
    if (!initialSelection || initialSelection.length === 0)
      return new Set<number>();

    const ids = new Set<number>();
    initialSelection.forEach((item: TData | number) => {
      if (typeof item === "number") {
        ids.add(item);
      } else if (item && "id" in item && typeof item.id === "number") {
        ids.add(item.id);
      }
    });
    return ids;
  }, [initialSelection]);

  // Initialize selection from props and reset explicitly deselected items
  useEffect(() => {
    if (initialSelection && initialSelection.length > 0) {
      const newMap = new Map<number, TData | null>();
      initialSelection.forEach((item: TData | number) => {
        if (typeof item === "number") {
          // Store just the ID for now, will be populated when data loads
          newMap.set(item, null);
        } else if (item && "id" in item && typeof item.id === "number") {
          newMap.set(item.id, item);
        }
      });
      setSelectionState((prev) => ({
        ...prev,
        selectedItems: newMap as Map<number, TData>,
        explicitlyDeselected: new Set(),
        isSelectAll: false,
      }));
    } else {
      setSelectionState({
        selectedItems: new Map(),
        explicitlyDeselected: new Set(),
        isSelectAll: false,
      });
    }
    // Reset initialization flag when modal opens
    if (open) {
      initializedRef.current = false;
    }
  }, [initialSelection, open]);

  const {
    data: pageData,
    isLoading,
    error,
  } = useQuery<Page<TData>, Error>({
    queryKey: [queryKey, queryParams],
    queryFn: () => fetcher(queryParams),
    enabled: open,
  });

  useEffect(() => {
    if (error) {
      showError(t("common:operation_failed", { error: error.message }));
    }
  }, [error, t]);

  // Auto-select items when data loads if they match initialSelectionIds and not explicitly deselected
  useEffect(() => {
    if (
      pageData?.content &&
      initialSelectionIds.size > 0 &&
      !initializedRef.current
    ) {
      const newSelected = new Map(selectionState.selectedItems);

      pageData.content.forEach((item: TData) => {
        if (
          initialSelectionIds.has(item.id) &&
          !selectionState.explicitlyDeselected.has(item.id)
        ) {
          // Only update if we don't already have the full object
          if (!newSelected.get(item.id)) {
            newSelected.set(item.id, item);
          }
        }
      });

      setSelectionState((prev) => ({ ...prev, selectedItems: newSelected }));
      initializedRef.current = true;
    }
  }, [
    pageData,
    initialSelectionIds,
    selectionState.explicitlyDeselected,
    selectionState.selectedItems,
  ]);

  const handlePageChange = useCallback((page: number) => {
    setQueryParams((prev) => ({ ...prev, page }));
  }, []);

  const handlePageSizeChange = useCallback((size: number) => {
    setQueryParams((prev) => ({ ...prev, size, page: 0 }));
  }, []);

  const handleSearch = useCallback((query: string) => {
    setQueryParams((prev) => ({
      ...prev,
      queries: query ? [query] : [],
      page: 0,
    }));
  }, []);

  const handleSortChange = useCallback(
    (sortField: string, sortOrder: "asc" | "desc") => {
      setQueryParams((prev) => ({
        ...prev,
        sortField,
        sortOrder,
        page: 0,
      }));
    },
    [],
  );

  const toggleSelection = (row: TData) => {
    if (isRowDisabled && isRowDisabled(row)) return;

    const newSelected = new Map(selectionState.selectedItems);
    const newExplicitlyDeselected = new Set(
      selectionState.explicitlyDeselected,
    );

    if (newSelected.has(row.id)) {
      // Item is being deselected
      newSelected.delete(row.id);
      // Add to explicitly deselected if it was in initial selection
      if (initialSelectionIds.has(row.id)) {
        newExplicitlyDeselected.add(row.id);
      }
      // If we were in "select all" mode and user deselects an item, turn off select all
      if (selectionState.isSelectAll) {
        setSelectionState((prev) => ({ ...prev, isSelectAll: false }));
      }
    } else {
      // Item is being selected
      if (!multiSelect) {
        newSelected.clear();
      }
      newSelected.set(row.id, row);
      // Remove from explicitly deselected if it was there
      if (newExplicitlyDeselected.has(row.id)) {
        newExplicitlyDeselected.delete(row.id);
      }
    }

    setSelectionState((prev) => ({
      ...prev,
      selectedItems: newSelected,
      explicitlyDeselected: newExplicitlyDeselected,
    }));
  };

  // Handle select all across all pages
  const handleSelectAll = async () => {
    if (!pageData || isFetchingAll) return;

    setIsFetchingAll(true);
    try {
      const allItems: TData[] = [];
      const totalPages = pageData.totalPages;

      // Fetch all pages
      for (let i = 0; i < totalPages; i++) {
        const params = { ...queryParams, page: i };
        const result = await fetcher(params);
        allItems.push(...result.content);
      }

      // Select all items (excluding disabled rows)
      const newSelected = new Map<number, TData>();
      allItems.forEach((item) => {
        if (!isRowDisabled || !isRowDisabled(item)) {
          newSelected.set(item.id, item);
        }
      });

      setSelectionState((prev) => ({
        ...prev,
        selectedItems: newSelected,
        isSelectAll: true,
      }));
    } catch (error) {
      showError(
        t("common:operation_failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setIsFetchingAll(false);
    }
  };

  // Handle clear all selections
  const handleClearAll = () => {
    setSelectionState({
      selectedItems: new Map(),
      explicitlyDeselected: new Set(),
      isSelectAll: false,
    });
  };

  // Toggle select all
  const toggleSelectAll = () => {
    if (selectionState.isSelectAll) {
      handleClearAll();
    } else {
      handleSelectAll();
    }
  };

  // Compute select all checkbox state
  const selectAllState = React.useMemo(() => {
    if (!pageData || !multiSelect) {
      return { checked: false, indeterminate: false };
    }

    const totalItems = pageData.totalElements;
    const selectedCount = selectionState.selectedItems.size;

    if (selectedCount === 0) {
      return { checked: false, indeterminate: false };
    }

    if (selectedCount === totalItems) {
      return { checked: true, indeterminate: false };
    }

    return { checked: false, indeterminate: true };
  }, [pageData, selectionState.selectedItems, multiSelect]);

  // Reset select all state when modal closes or initial selection changes
  useEffect(() => {
    if (!open) {
      setSelectionState((prev) => ({ ...prev, isSelectAll: false }));
    }
  }, [open]);

  // Update isSelectAll state when all items are manually selected
  useEffect(() => {
    if (pageData && multiSelect && !isFetchingAll) {
      const totalItems = pageData.totalElements;
      const selectedCount = selectionState.selectedItems.size;

      // If all items are selected (not in select all mode), update the state
      if (
        selectedCount === totalItems &&
        totalItems > 0 &&
        !selectionState.isSelectAll
      ) {
        setSelectionState((prev) => ({ ...prev, isSelectAll: true }));
      }
      // If not all items are selected and we were in select all mode, update the state
      else if (selectedCount !== totalItems && selectionState.isSelectAll) {
        setSelectionState((prev) => ({ ...prev, isSelectAll: false }));
      }
    }
  }, [
    selectionState.selectedItems,
    pageData,
    multiSelect,
    isFetchingAll,
    selectionState.isSelectAll,
  ]);

  const handleConfirm = () => {
    const values = Array.from(selectionState.selectedItems.values()).filter(
      (v) => v != null,
    );
    if (multiSelect) {
      onSelect(returnFullObject ? values : values.map((v) => v.id));
    } else if (values.length > 0) {
      const value = values[0];
      onSelect(returnFullObject ? value : value.id);
    }
    setOpen(false);
  };

  // Inject checkbox column
  const tableColumns = [
    {
      accessorKey: "select",
      header: "",
      cell: (row: TData) => {
        const isSelected = selectionState.selectedItems.has(row.id);
        const disabled = isRowDisabled ? isRowDisabled(row) : false;

        return (
          <Checkbox
            checked={isSelected}
            disabled={disabled}
            onCheckedChange={() => toggleSelection(row)}
            onClick={(e) => e.stopPropagation()} // Prevent double toggle when row is clicked
          />
        );
      },
      enableSorting: false,
    },
    ...columns,
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-7xl w-full h-[90vh] flex flex-col p-0">
        <DialogHeader className="flex-shrink-0 px-6 pt-6 pb-2">
          <div className="flex items-center justify-between">
            <DialogTitle>{title}</DialogTitle>
            {multiSelect && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id="select-all"
                  checked={selectAllState.checked}
                  onCheckedChange={toggleSelectAll}
                  disabled={isFetchingAll || isLoading}
                />
                <label
                  htmlFor="select-all"
                  className="text-sm font-medium cursor-pointer select-none"
                >
                  {isFetchingAll
                    ? t("common:loading")
                    : selectAllState.checked
                      ? t("common:deselect_all")
                      : t("common:select_all")}
                </label>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0 px-6 pb-2">
          <DataTable
            columns={tableColumns}
            data={pageData?.content || []}
            pageInfo={pageData}
            onPageChange={handlePageChange}
            onPageSizeChange={handlePageSizeChange}
            onSearch={handleSearch}
            isLoading={isLoading}
            onSortChange={handleSortChange}
            currentSortField={queryParams.sortField || "id"}
            currentSortOrder={queryParams.sortOrder || "asc"}
            onRowClick={toggleSelection}
            freezeLastColumn={false}
            isRowDisabled={isRowDisabled}
            getRowDisabledReason={getDisabledReason}
            constrainedHeight={true}
          />
        </div>

        <DialogFooter className="flex-shrink-0 px-6 pb-6">
          <Button
            variant="outline"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }}
            type="button"
          >
            {t("common:cancel")}
          </Button>
          <Button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleConfirm();
            }}
            type="button"
          >
            {t("common:select")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
