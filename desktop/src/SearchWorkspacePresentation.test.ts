import { describe, expect, it } from "vitest";
import { deriveSearchWorkspaceResults, journalDateKey } from "./SearchWorkspacePresentation";
import type { SearchResult } from "./SearchTypes";

function result(id: string, title: string, libraryId = "main", modifiedAt?: number): SearchResult {
  return {
    id,
    entityKey: id,
    documentId: id,
    contentType: "craft_page",
    sourceType: "craft_page",
    provider: "craft",
    libraryId,
    libraryName: libraryId,
    spaceId: libraryId,
    spaceName: libraryId,
    title,
    path: title,
    modifiedAt,
    snippet: "",
    matchTerms: [],
    matchField: "",
    matchCount: 0,
    subMatches: [],
  };
}

function derive(overrides: Partial<Parameters<typeof deriveSearchWorkspaceResults>[0]> = {}) {
  return deriveSearchWorkspaceResults({
    desktopSidebarEnabled: true,
    isMobileLayout: false,
    query: "",
    view: "journals",
    results: [],
    journalResults: [],
    favoriteResults: [],
    historyResults: [],
    tagResults: [],
    selectedLibraryIdSet: null,
    selectedJournalDate: "",
    dateFilter: "any",
    groupRecentByDateWhenUnlimited: false,
    ...overrides,
  });
}

describe("SearchWorkspacePresentation", () => {
  it("filters journals by selected libraries and month while grouping each day once", () => {
    const presentation = derive({
      journalResults: [
        result("a", "2026-08-29", "main"),
        result("b", "2026.08.29", "main"),
        result("c", "2026-08-28", "main"),
        result("d", "2026-08-27", "other"),
      ],
      selectedLibraryIdSet: new Set(["main"]),
      selectedJournalDate: "2026-08",
    });

    expect(presentation.visibleResults.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(presentation.groups.map((group) => [group.key, group.entries.map((entry) => entry.index)])).toEqual([
      ["journal:2026-08-29", [0, 1]],
      ["journal:2026-08-28", [2]],
    ]);
    expect(presentation.journalDayCount).toBe(2);
  });

  it("preserves live search results instead of replacing them with a sidebar collection", () => {
    const liveResults = [result("search", "搜索结果")];
    const presentation = derive({
      query: "关键词",
      results: liveResults,
      journalResults: [result("journal", "2026-08-29")],
    });

    expect(presentation.visibleResults).toMatchObject(liveResults);
    expect(presentation.groups).toMatchObject([{ key: "recent", label: "", entries: [{ result: liveResults[0], index: 0 }] }]);
  });

  it("shows mobile collections without requiring the desktop sidebar", () => {
    const favorite = result("favorite", "收藏页面");
    const home = result("home", "搜索首页");
    const presentation = derive({
      desktopSidebarEnabled: false,
      isMobileLayout: true,
      view: "favorites",
      results: [home],
      favoriteResults: [favorite],
    });

    expect(presentation.visibleResults.map((item) => item.id)).toEqual(["favorite"]);
    expect(presentation.groups[0].key).toBe("favorites");
  });

  it("recognizes journal titles with dots but rejects partial dates", () => {
    expect(journalDateKey(result("valid", "2026.08.29"))).toBe("2026-08-29");
    expect(journalDateKey(result("invalid", "2026-08"))).toBe("");
  });
});


it("uses grouped hit order for main-window navigation", () => {
  const first = result("a1", "Page A");
  first.documentId = "a";
  first.snippet = "match first";
  first.matchField = "body";
  first.subMatches = [{ id: "a2", blockId: "block-a2", contentType: "craft_page", sourceType: "craft_page", title: "Second hit", snippet: "match", matchTerms: [], matchField: "body" }];
  const third = { ...result("a3", "Page A"), documentId: "a", snippet: "match third", matchField: "body" };
  const presentation = derive({ query: "match", results: [first, result("b", "Page B"), third] });
  expect(presentation.visibleResults.map(r => r.id)).toEqual(["a1", "a2", "a3", "b"]);
  expect(presentation.visibleResults[1].blockId).toBe("block-a2");
});

