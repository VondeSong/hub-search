export type FilterPresentationState = {
  dateFilter: "any" | "7" | "30" | "90";
  folderId: string;
  searchScope: "all" | "title" | "title_heading";
  sourceFilters: {
    craft: boolean;
    task: boolean;
    pdf: boolean;
    media: boolean;
    attachment: boolean;
  };
};

/** Counts changed filter groups, rather than every disabled source button. */
export function activeFilterCount(filters: FilterPresentationState): number {
  const sourceTypesChanged = Object.values(filters.sourceFilters).some((enabled) => !enabled);
  return Number(sourceTypesChanged)
    + Number(filters.searchScope !== "all")
    + Number(Boolean(filters.folderId))
    + Number(filters.dateFilter !== "any");
}
