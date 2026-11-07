import { describe, expect, it } from "vitest";
import { activeFilterCount, type FilterPresentationState } from "./FilterPresentation";

const defaults: FilterPresentationState = {
  dateFilter: "any",
  folderId: "",
  searchScope: "all",
  sourceFilters: { craft: true, task: true, pdf: true, media: true, attachment: true },
};

describe("activeFilterCount", () => {
  it("returns zero for the default filter state", () => {
    expect(activeFilterCount(defaults)).toBe(0);
  });

  it("counts source types as one changed filter group", () => {
    expect(activeFilterCount({
      ...defaults,
      sourceFilters: { ...defaults.sourceFilters, media: false, attachment: false },
    })).toBe(1);
  });

  it("counts each changed filter group", () => {
    expect(activeFilterCount({
      ...defaults,
      dateFilter: "30",
      folderId: "space\u0000folder",
      searchScope: "title",
      sourceFilters: { ...defaults.sourceFilters, task: false },
    })).toBe(4);
  });
});
