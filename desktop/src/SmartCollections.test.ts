import { describe, expect, it } from "vitest";
import {
  createSmartCollection,
  parseSmartCollections,
  smartCollectionMatches,
  smartCollectionSourceLabel,
  type SmartCollectionSnapshot,
} from "./SmartCollections";

const snapshot: SmartCollectionSnapshot = {
  query: " 项目 ",
  libraryIds: ["library-b", "library-a"],
  folderId: "library-a\u0000projects",
  folderLabel: "项目",
  dateFilter: "7",
  sourceFilters: { craft: false, task: false, pdf: true, media: false, attachment: false },
  searchScope: "title_heading",
};

describe("smart collections", () => {
  it("normalizes a saved snapshot", () => {
    const collection = createSmartCollection("collection-1", "  最近项目 PDF  ", snapshot, 123);
    expect(collection.name).toBe("最近项目 PDF");
    expect(collection.query).toBe("项目");
    expect(collection.libraryIds).toEqual(["library-a", "library-b"]);
    expect(collection.createdAt).toBe(123);
  });

  it("parses stored collections defensively", () => {
    const parsed = parseSmartCollections(JSON.stringify([{
      id: "saved",
      name: "保存的搜索",
      query: "roadmap",
      libraryIds: ["b", "a", "a", 3],
      dateFilter: "invalid",
      searchScope: "invalid",
      sourceFilters: { pdf: false },
    }, { id: "", name: "invalid" }]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].libraryIds).toEqual(["a", "b"]);
    expect(parsed[0].dateFilter).toBe("any");
    expect(parsed[0].searchScope).toBe("all");
    expect(parsed[0].sourceFilters.pdf).toBe(false);
  });

  it("matches equivalent current search state regardless of library order", () => {
    const collection = createSmartCollection("collection-1", "项目", snapshot, 123);
    expect(smartCollectionMatches(collection, {
      ...snapshot,
      query: "项目",
      libraryIds: ["library-a", "library-b"],
      folderLabel: "已重命名的文件夹",
    })).toBe(true);
  });

  it("summarizes selected source types", () => {
    expect(smartCollectionSourceLabel(snapshot.sourceFilters)).toBe("PDF");
  });
});
