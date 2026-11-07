import { describe, expect, it } from "vitest";
import { buildLocalSearchRequest, buildRecentDocumentsRequest, usesFilteredEmptySearch } from "./useLocalSearch";

const base = {
  query: "卡扣",
  spaceIds: ["craft-main"],
  folderId: "folder-1",
  updatedAfter: 123,
  sourceFilters: { craft: true, task: false, pdf: true, media: true, attachment: false },
  searchScope: "title_heading" as const,
  recentPageLimit: 30,
  recentTaskLimit: 10,
};

describe("local search request policy", () => {
  it("reads already indexed content according to source filters", () => {
    expect(buildLocalSearchRequest(base)).toMatchObject({
      includeCraftPages: true,
      includeDidaTasks: false,
      includeImageOcr: true,
      includePdf: true,
      includePdfOcr: true,
      includeAttachments: false,
      searchScope: "title_heading",
    });
  });

  it("does not leak PDF OCR results when the PDF source is disabled", () => {
    expect(buildLocalSearchRequest({
      ...base,
      sourceFilters: { ...base.sourceFilters, pdf: false },
    })).toMatchObject({ includePdf: false, includePdfOcr: false });
  });
  it("does not hide per-library or historical text when global processing is disabled", () => {
    const disabledProcessing = { ...base, imageOcrEnabled: false, pdfEnabled: false, pdfOcrEnabled: false };
    expect(buildLocalSearchRequest(disabledProcessing)).toMatchObject({ includeImageOcr: true, includePdf: true, includePdfOcr: true });
  });

  it("normalizes an empty folder to the backend null contract", () => {
    expect(buildRecentDocumentsRequest({ ...base, folderId: "" })).toEqual({
      pageLimit: 30,
      taskLimit: 10,
      spaceIds: ["craft-main"],
      folderId: null,
      updatedAfter: 123,
    });
  });

  it("uses the full index for empty searches that filter content types", () => {
    expect(usesFilteredEmptySearch(base)).toBe(true);
    expect(usesFilteredEmptySearch({
      sourceFilters: { craft: true, task: true, pdf: true, media: true, attachment: true },
      searchScope: "all",
    })).toBe(false);
  });
});
