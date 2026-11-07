import { describe, expect, it } from "vitest";
import { buildSearchSuggestions, searchFilterSummary, searchSyntaxHints } from "./SearchSuggestions";
import type { SearchResult } from "./SearchTypes";

const result = {
  id: "result-1",
  entityKey: "document:1",
  documentId: "1",
  contentType: "document",
  sourceType: "craft_page",
  provider: "craft",
  libraryId: "library-1",
  libraryName: "工作",
  spaceId: "library-1",
  spaceName: "工作",
  title: "项目路线图",
  path: "Projects / 2026",
  snippet: "",
  matchTerms: [],
  matchField: "title",
  matchCount: 1,
  subMatches: [],
} satisfies SearchResult;

describe("search suggestions", () => {
  it("mixes matching history, titles, tags and folders", () => {
    const suggestions = buildSearchSuggestions({
      query: "项目",
      history: ["项目复盘", "电影"],
      results: [result],
      tags: [{ name: "项目管理", normalizedName: "项目管理", count: 8 }],
      folders: [{ id: "projects", name: "项目", path: "Projects", spaceId: "library-1", libraryName: "工作" }],
    });
    expect(suggestions.map((item) => item.kind)).toEqual(["history", "title", "tag", "folder"]);
    expect(suggestions[suggestions.length - 1]?.folderId).toBe("library-1\u0000projects");
  });

  it("offers phrase, pinyin and fuzzy guidance", () => {
    const hints = searchSyntaxHints("sousuo");
    expect(hints.map((hint) => hint.id)).toEqual(["phrase", "pinyin", "fuzzy"]);
    expect(hints[0].suggestion?.query).toBe('"sousuo"');
  });

  it("describes the active filter scope", () => {
    expect(searchFilterSummary({
      currentSpaceName: "全部资料库",
      dateFilter: "7",
      sourceFilters: { craft: false, task: false, pdf: true, media: false, attachment: false },
      searchScope: "title_heading",
    })).toBe("全部资料库 · PDF · 近 7 天 · 页面名称与章节");
  });
});
