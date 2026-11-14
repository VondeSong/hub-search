import { normalizeSourceFilters, type SourceFilters } from "./SearchSourceFilters";
export type FilterPresentationState = {
  dateFilter: "any" | "7" | "30" | "90";
  folderId: string;
  searchScope: "all" | "title" | "title_heading";
  sourceFilters: SourceFilters;
};

/** Counts changed filter groups, rather than every disabled source button. */
export function activeFilterCount(filters: FilterPresentationState): number {
  const sourceTypesChanged = Object.values(normalizeSourceFilters(filters.sourceFilters)).some((enabled) => !enabled);
  return Number(sourceTypesChanged)
    + Number(filters.searchScope !== "all")
    + Number(Boolean(filters.folderId))
    + Number(filters.dateFilter !== "any");
}
