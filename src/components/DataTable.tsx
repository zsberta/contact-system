import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Page, QueryParams } from "@/types/common";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { DataTableSearch } from "@/components/DataTableSearch";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";

const EMPTY_QUERIES: string[] = [];

interface ColumnDef<TData> {
  accessorKey?: keyof TData | string;
  header: string | React.ReactNode | (() => React.ReactNode);
  cell: (row: TData) => React.ReactNode;
  enableSorting?: boolean;
  id?: string;
}

interface DataTableProps<TData, TValue> {
  columns: {
    accessorKey?: keyof TData | string;
    header: string | React.ReactNode | (() => React.ReactNode);
    cell: (row: TData) => React.ReactNode;
    enableSorting?: boolean;
    id?: string;
  }[];
  data: TData[];
  pageInfo: Page<TData> | undefined;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onSearch: (query: string) => void;
  isLoading: boolean;
  defaultPageSize?: number;

  queries?: string[];
  filterType?: "any" | "all";
  onQueriesChange?: (queries: string[]) => void;
  onFilterTypeChange?: (filterType: "any" | "all") => void;

  onSortChange: (sortField: string, sortOrder: "asc" | "desc") => void;
  currentSortField: string;
  currentSortOrder: "asc" | "desc";

  onRowDoubleClick?: (row: TData) => void;
  onRowClick?: (row: TData) => void;

  freezeLastColumn?: boolean;

  isRowDisabled?: (row: TData) => boolean;
  getRowDisabledReason?: (row: TData) => string;
  getRowClassName?: (row: TData) => string | undefined;
  getRowTooltip?: (row: TData) => string | undefined;

  constrainedHeight?: boolean;

  showPagination?: boolean;

  getRowId?: (row: TData, index: number) => string | number;

  selectedRows?: Set<string | number>;
  onSelectionChange?: (selectedRows: Set<string | number>) => void;
  selectableRows?: boolean;
}

const DataTableCell = React.memo(function DataTableCell<TData>({
  row,
  column,
}: {
  row: TData;
  column: ColumnDef<TData>;
}) {
  if (column.cell) {
    return <>{column.cell(row)}</>;
  }
  const key = column.accessorKey as keyof TData;
  return <>{String(row[key] ?? "")}</>;
}) as <TData>(props: {
  row: TData;
  column: ColumnDef<TData>;
}) => React.ReactElement;

export function DataTable<TData, TValue>({
  columns,
  data,
  pageInfo,
  onPageChange,
  onPageSizeChange,
  onSearch,
  isLoading,
  defaultPageSize = 10,
  queries = EMPTY_QUERIES,
  filterType = "any",
  onQueriesChange,
  onFilterTypeChange,
  onSortChange,
  currentSortField,
  currentSortOrder,
  onRowDoubleClick,
  onRowClick,
  freezeLastColumn = true,
  isRowDisabled,
  getRowDisabledReason,
  getRowClassName,
  getRowTooltip,
  constrainedHeight = false,
  showPagination = true,
  getRowId,
  selectedRows = new Set(),
  onSelectionChange,
  selectableRows = false,
}: DataTableProps<TData, TValue>) {
  const { t } = useTranslation(["common"]);
  const isMobile = useIsMobile();
  const [searchQuery, setSearchQuery] = useState("");
  const currentPage = pageInfo?.number ?? 0;
  const pageSize = pageInfo?.size ?? defaultPageSize;

  const getRowKey = (row: TData, index: number): string | number => {
    if (getRowId) return getRowId(row, index);
    if (row && typeof row === "object" && "id" in row) {
      const rowWithId = row as { id?: string | number };
      if (rowWithId.id !== undefined) return rowWithId.id;
    }
    // Index fallback is safe when: rows are never reordered, filtered, or dynamically deleted
    return index;
  };

  const totalPages = pageInfo?.totalPages ?? 1;
  const totalElements = pageInfo?.totalElements ?? 0;

  const checkboxColumn: ColumnDef<TData> = {
    id: "select",
    header: () => (
      <Checkbox
        checked={selectedRows.size === data.length && data.length > 0}
        ref={(el) => {
          if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < data.length;
        }}
        onCheckedChange={(checked) => {
          if (checked) {
            const allIds = new Set(data.map((_, i) => getRowId ? getRowId(data[i], i) : (data[i] as { id: string | number }).id));
            onSelectionChange?.(allIds);
          } else {
            onSelectionChange?.(new Set());
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    ),
    cell: (row: TData, index: number) => {
      const rowId = getRowId ? getRowId(row, index) : (row as { id: string | number }).id;
      return (
        <Checkbox
          checked={selectedRows.has(rowId)}
          onCheckedChange={(checked) => {
            const newSet = new Set(selectedRows);
            if (checked) {
              newSet.add(rowId);
            } else {
              newSet.delete(rowId);
            }
            onSelectionChange?.(newSet);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      );
    },
    enableSorting: false,
  };

  const columnsToRender = selectableRows && onSelectionChange
    ? [checkboxColumn, ...columns]
    : columns;

  const lastColumnIndex = columnsToRender.length - 1;

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onSearch(searchQuery);
  };

  const handlePageChange = (newPage: number) => {
    if (newPage >= 0 && newPage < totalPages) {
      onPageChange(newPage);
    }
  };

  const handlePageSizeChange = (value: string) => {
    const newSize = Number.parseInt(value);
    onPageSizeChange(newSize);
    onPageChange(0);
  };

  const handleSort = (accessorKey: string) => {
    const newSortOrder =
      currentSortField === accessorKey && currentSortOrder === "asc"
        ? "desc"
        : "asc";
    onSortChange(accessorKey, newSortOrder);
  };

  return (
    <div className={constrainedHeight ? "h-full flex flex-col" : "space-y-4"}>
      <DataTableSearch
        queries={queries}
        filterType={filterType}
        onQueriesChange={onQueriesChange || (() => {})}
        onFilterTypeChange={onFilterTypeChange || (() => {})}
        disabled={isLoading}
        placeholder={t("common:search")}
        constrainedHeight={constrainedHeight}
      />

      {/* Table Container with Horizontal Scroll - Responsive */}
      <div className={constrainedHeight ? "flex-1 min-h-0 mt-4" : "grid"}>
        <div
          className={cn(
            "rounded-md border",
            constrainedHeight ? "overflow-auto" : "overflow-x-auto",
            isMobile && "min-w-[320px]",
            constrainedHeight && "h-full",
          )}
        >
          <Table className="w-full" noWrapper={true}>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                {columnsToRender.map((column, index) => {
                  const accessorKey = column.accessorKey
                    ? String(column.accessorKey)
                    : column.id || String(index);
                  const isSortable =
                    column.enableSorting && !!column.accessorKey;
                  const isCurrentSort = currentSortField === accessorKey;
                  const isLastColumn = index === lastColumnIndex;

                  const SortIcon = isCurrentSort
                    ? currentSortOrder === "asc"
                      ? ArrowUp
                      : ArrowDown
                    : ArrowUpDown;

                  return (
                    <TableHead
                      key={accessorKey}
                      className={cn(
                        isSortable &&
                          "cursor-pointer hover:bg-muted/50 transition-colors",
                        "whitespace-nowrap",
                        isLastColumn &&
                          freezeLastColumn &&
                          "sticky right-0 bg-background shadow-lg z-20", // Freeze last column header
                        isMobile && "px-2 py-3 text-xs", // Smaller padding and text on mobile
                      )}
                      onClick={() => isSortable && handleSort(accessorKey)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          if (isSortable) handleSort(accessorKey);
                        }
                      }}
                      tabIndex={0}
                    >
                      <div className="flex items-center gap-1">
                        {typeof column.header === "function"
                          ? column.header()
                          : column.header}
                        {isSortable && (
                          <SortIcon
                            className={cn(
                              "h-4 w-4",
                              isCurrentSort ? "opacity-100" : "opacity-50",
                              isMobile && "h-3 w-3", // Smaller icon on mobile
                            )}
                          />
                        )}
                      </div>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: pageSize }).map((_, rowIndex) => (
                  <TableRow key={`skeleton-${rowIndex}`}>
                    {columnsToRender.map((column, colIndex) => (
                      <TableCell
                        key={`skeleton-${rowIndex}-${colIndex}`}
                        className={cn(
                          "p-4 align-middle [&:has([role=checkbox])]:pr-0",
                          "whitespace-nowrap",
                          colIndex === lastColumnIndex &&
                            freezeLastColumn &&
                            "sticky right-0 bg-card shadow-lg z-10",
                          isMobile && "px-2",
                        )}
                      >
                        <div className="h-[21px]">
                          <Skeleton
                            className={cn(
                              "h-full w-full",
                              colIndex === 0 && "w-3/4",
                              colIndex === columnsToRender.length - 1 && "w-1/2",
                            )}
                          />
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : data && data.length > 0 ? (
                data.map((row, index) => {
                  const disabled = isRowDisabled ? isRowDisabled(row) : false;
                  const disabledReason =
                    disabled && getRowDisabledReason
                      ? getRowDisabledReason(row)
                      : null;
                  const rowKey = getRowKey(row, index);
                  const customRowClassName = getRowClassName
                    ? getRowClassName(row)
                    : undefined;
                  const customTooltip = getRowTooltip
                    ? getRowTooltip(row)
                    : undefined;

                  const tableRow = (
                    <TableRow
                      key={rowKey}
                      role="row"
                      tabIndex={0}
                      onClick={() => !disabled && onRowClick && onRowClick(row)}
                      onDoubleClick={() =>
                        !disabled && onRowDoubleClick && onRowDoubleClick(row)
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          if (!disabled && onRowClick) onRowClick(row);
                        }
                      }}
                      className={cn(
                        !disabled &&
                          (onRowClick || onRowDoubleClick) &&
                          "cursor-pointer hover:bg-muted/50",
                        disabled && "opacity-50 cursor-not-allowed",
                        isMobile && "border-b",
                        customRowClassName,
                      )}
                    >
                      {columnsToRender.map((column, colIndex) => {
                        const isLastColumn = colIndex === lastColumnIndex;
                        const cellKey =
                          column.id ||
                          (column.accessorKey
                            ? String(column.accessorKey)
                            : String(colIndex));
                        return (
                          <TableCell
                            key={cellKey}
                            className={cn(
                              "whitespace-nowrap",
                              isLastColumn &&
                                freezeLastColumn &&
                                "sticky right-0 bg-card shadow-lg z-10",
                              isMobile && "px-2 py-3 text-sm",
                            )}
                          >
                            <DataTableCell row={row} column={column} />
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  );

                  if (disabled && disabledReason) {
                    return (
                      <TooltipProvider key={rowKey}>
                        <Tooltip>
                          <TooltipTrigger asChild>{tableRow}</TooltipTrigger>
                          <TooltipContent>
                            <p>{disabledReason}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    );
                  }

                  if (customTooltip) {
                    return (
                      <TooltipProvider key={rowKey}>
                        <Tooltip>
                          <TooltipTrigger asChild>{tableRow}</TooltipTrigger>
                          <TooltipContent>
                            <p>{customTooltip}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    );
                  }

                  return tableRow;
                })
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={columnsToRender.length}
                    className={cn(
                      "h-24 text-center whitespace-nowrap",
                      isMobile && "px-2 py-4 text-sm", // Smaller padding on mobile
                    )}
                  >
                    {t("common:no_results")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Pagination - Responsive */}
      {showPagination && (
        <div
          className={cn(
            "flex flex-col sm:flex-row items-center justify-between gap-4 px-2",
            constrainedHeight ? "flex-shrink-0 mt-4" : "",
          )}
        >
          <div className="flex items-center space-x-2 text-sm font-medium w-full sm:w-auto">
            <span className="text-muted-foreground">
              {t("common:rows_per_page")}:
            </span>
            <Select
              value={String(pageSize)}
              onValueChange={handlePageSizeChange}
            >
              <SelectTrigger
                className={cn(
                  "h-8 w-[70px]",
                  isMobile && "h-10", // Larger touch target on mobile
                )}
              >
                <SelectValue placeholder={pageSize} />
              </SelectTrigger>
              <SelectContent className="z-[110]">
                {[5, 10, 20, 50].map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 lg:gap-8 w-full sm:w-auto">
            <div className="flex items-center space-x-1">
              {/* First Page (Page 1) */}
              {totalPages > 1 && (
                <Button
                  variant={currentPage === 0 ? "default" : "outline"}
                  className={cn(
                    "p-0 px-2",
                    isMobile ? "h-10 min-w-[40px]" : "h-8 min-w-[32px]",
                  )}
                  onClick={() => handlePageChange(0)}
                  disabled={isLoading}
                >
                  1
                </Button>
              )}

              {/* Previous Page */}
              <Button
                variant="outline"
                className={cn("p-0", isMobile ? "h-10 w-10" : "h-8 w-8")}
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 0 || isLoading}
              >
                <span className="sr-only">
                  {t("common:go_to_previous_page")}
                </span>
                <ChevronLeft className={cn("h-4 w-4", isMobile && "h-5 w-5")} />
              </Button>

              {/* Page Numbers (excluding first and last) */}
              {(() => {
                const pageNumbers = [];
                const maxVisiblePages = 3;

                // Calculate range around current page, excluding first (0) and last (totalPages-1)
                const startPage = Math.max(
                  1,
                  currentPage - Math.floor(maxVisiblePages / 2),
                );
                const endPage = Math.min(
                  totalPages - 2,
                  startPage + maxVisiblePages - 1,
                );

                // Adjust if we don't have enough pages
                if (endPage < startPage) {
                  return null;
                }

                for (let i = startPage; i <= endPage; i++) {
                  pageNumbers.push(
                    <Button
                      key={`page-button-${i + 1}`}
                      variant={currentPage === i ? "default" : "outline"}
                      className={cn(
                        "p-0 px-2",
                        isMobile ? "h-10 min-w-[40px]" : "h-8 min-w-[32px]",
                      )}
                      onClick={() => handlePageChange(i)}
                      disabled={isLoading}
                    >
                      {i + 1}
                    </Button>,
                  );
                }
                return pageNumbers;
              })()}

              {/* Next Page */}
              <Button
                variant="outline"
                className={cn("p-0", isMobile ? "h-10 w-10" : "h-8 w-8")}
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages - 1 || isLoading}
              >
                <span className="sr-only">{t("common:go_to_next_page")}</span>
                <ChevronRight
                  className={cn("h-4 w-4", isMobile && "h-5 w-5")}
                />
              </Button>

              {/* Last Page */}
              {totalPages > 1 && (
                <Button
                  variant={
                    currentPage === totalPages - 1 ? "default" : "outline"
                  }
                  className={cn(
                    "p-0 px-2",
                    isMobile ? "h-10 min-w-[40px]" : "h-8 min-w-[32px]",
                  )}
                  onClick={() => handlePageChange(totalPages - 1)}
                  disabled={isLoading}
                >
                  {totalPages}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
