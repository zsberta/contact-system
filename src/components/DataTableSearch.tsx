import React, { useState, KeyboardEvent, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search, X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DataTableSearchProps {
  queries: string[];
  filterType: "any" | "all";
  onQueriesChange: (queries: string[]) => void;
  onFilterTypeChange: (filterType: "any" | "all") => void;
  disabled?: boolean;
  placeholder?: string;
  constrainedHeight?: boolean;
}

export function DataTableSearch({
  queries,
  filterType,
  onQueriesChange,
  onFilterTypeChange,
  disabled = false,
  placeholder,
  constrainedHeight = false,
}: DataTableSearchProps) {
  const { t } = useTranslation(["common"]);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleAddQuery = () => {
    const trimmedValue = inputValue.trim();
    if (!trimmedValue) {
      setInputValue("");
      return;
    }

    const separators = /[;,| ]/u;
    const newQueries = trimmedValue
      .split(separators)
      .map((q) => q.trim())
      .filter((q) => q && !queries.includes(q));

    if (newQueries.length > 0) {
      onQueriesChange([...queries, ...newQueries]);
    }
    setInputValue("");
  };

  const handleRemoveQuery = (queryToRemove: string) => {
    onQueriesChange(queries.filter((q) => q !== queryToRemove));
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleAddQuery();
    } else if (
      e.key === "Backspace" &&
      inputValue === "" &&
      queries.length > 0
    ) {
      onQueriesChange(queries.slice(0, -1));
    }
  };

  return (
    <div className={cn("w-full", constrainedHeight && "flex-shrink-0 mb-4")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleAddQuery();
        }}
        className="flex items-stretch gap-0 w-full max-w-lg"
      >
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            ref={inputRef}
            placeholder={placeholder || t("common:search")}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="pl-10 pr-12 rounded-r-none border-r-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus-visible:z-10 h-10"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="rounded-l-none flex-shrink-0 border-l-0 shadow-none hover:bg-accent hover:border-accent hover:shadow-none h-10"
          disabled={disabled}
        >
          <Plus className="h-4 w-4 mr-1" />
          <span className="sr-only">{t("common:search")}</span>
        </Button>
        <Select
          value={filterType}
          onValueChange={(value: "any" | "all") => onFilterTypeChange(value)}
        >
          <SelectTrigger className="w-[120px] h-10 ml-2">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("common:any")}</SelectItem>
            <SelectItem value="all">{t("common:all")}</SelectItem>
          </SelectContent>
        </Select>
      </form>

      {queries.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 max-w-lg">
          {queries.map((query) => (
            <div
              key={query}
              className="inline-flex items-center gap-1 px-2 py-1 bg-secondary text-secondary-foreground rounded-md text-sm"
            >
              <span>{query}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-4 w-4 p-0 hover:bg-destructive hover:text-destructive-foreground"
                onClick={() => handleRemoveQuery(query)}
                disabled={disabled}
              >
                <X className="h-3 w-3" />
                <span className="sr-only">{t("common:delete")}</span>
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
