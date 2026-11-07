import { describe, expect, it } from "vitest";
import { normalizeQuickSearchResults } from "./SearchResultTestData";

describe("normalizeQuickSearchResults", () => {
  it("keeps the identifiers and presentation fields needed by quick search", () => {
    const [result] = normalizeQuickSearchResults([{
      id: "hit-1",
      documentId: "document-1",
      blockId: "block-1",
      spaceId: "space-1",
      libraryId: "library-1",
      libraryName: "Main",
      provider: "craft",
      title: "搜索设计",
      path: "项目 / Hub",
      snippet: "**本地** `搜索` 结果",
      matchTerms: ["搜索"],
      matchField: "body",
    }]);

    expect(result).toMatchObject({
      id: "hit-1",
      documentId: "document-1",
      blockId: "block-1",
      libraryId: "library-1",
      libraryName: "Main",
      title: "搜索设计",
      path: "项目 / Hub",
      matchTerms: ["搜索"],
      matchField: "body",
    });
    expect(result.snippet).toBe("本地 搜索 结果");
  });

  it("drops malformed results that cannot be opened", () => {
    expect(normalizeQuickSearchResults([null, {}, { id: "missing-space" }])).toEqual([]);
  });
});

