import { describe, expect, it } from "vitest";
import {
  compactResultPath,
  compactRecentPath,
  didaResultStatusLabel,
  resultDisplayTitle,
  resultOnlyMatchesTitle,
  resultShouldShowSnippet,
  resultSectionTitle,
  searchResultRowPresentation,
  resultSnippetMatchCount,
  resultSnippetUsesTwoLines,
} from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";

function result(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "result-1",
    entityKey: "craft:page:block",
    documentId: "page",
    blockId: "block",
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: "命中章节",
    documentTitle: "页面名称",
    path: "Car/规范/线束/页面名称",
    snippet: "正文命中内容",
    matchTerms: ["命中"],
    matchField: "heading,body",
    matchCount: 2,
    subMatches: [],
    ...overrides,
  };
}

describe("search result presentation", () => {
  it("shows completed task state without treating unrelated results as tasks", () => {
    expect(didaResultStatusLabel(result({ provider: "dida365", taskStatus: 2 }))).toBe("已完成");
    expect(didaResultStatusLabel(result({ provider: "dida365", taskStatus: 0 }))).toBeUndefined();
    expect(didaResultStatusLabel(result({ provider: "craft", taskStatus: 2 }))).toBeUndefined();
  });
  it("hides Craft title decoration while preserving text and literal comparisons", () => {
    expect(resultDisplayTitle(result({ documentTitle: '<highlight color="gray">A523：男孩的情感教育！</highlight>' }))).toBe("A523：男孩的情感教育！");
    expect(resultDisplayTitle(result({ documentTitle: "A < B > C" }))).toBe("A < B > C");
    expect(resultSectionTitle(result({ documentTitle: '<highlight color="gray">标题</highlight>', title: "标题" }))).toBeUndefined();
  });
  it("shows linked task titles as text without stripping ordinary brackets", () => {
    expect(resultDisplayTitle(result({ provider: "dida365", documentTitle: "[道家思想的精髓是什么？](https://mp.weixin.qq.com/s/abc)" }))).toBe("道家思想的精髓是什么？");
    expect(resultDisplayTitle(result({ provider: "dida365", documentTitle: "[[TBOX]文章](https://example.com/a(b))" }))).toBe("[TBOX]文章");
    expect(resultDisplayTitle(result({ provider: "dida365", documentTitle: "[TBOX]普通标题" }))).toBe("[TBOX]普通标题");
  });
  it("uses the page name as the primary title and keeps a distinct matched section", () => {
    const value = result();
    expect(resultDisplayTitle(value)).toBe("页面名称");
    expect(resultSectionTitle(value)).toBe("命中章节");
  });

  it("does not invent a section when only the page name matched", () => {
    const value = result({ title: "页面名称", matchField: "title", snippet: "" });
    expect(resultOnlyMatchesTitle(value)).toBe(true);
    expect(resultSectionTitle(value)).toBeUndefined();
  });

  it("removes the duplicated page name and shortens the middle of recent paths", () => {
    expect(compactRecentPath(result())).toBe("Car / … / 线束");
  });

  it("keeps a short snippet on one line even when the term occurs twice", () => {
    const value = result({ snippet: "命中内容，然后再次命中。" });
    expect(resultSnippetMatchCount(value, "命中")).toBe(2);
    expect(resultSnippetUsesTwoLines(value, "命中")).toBe(false);
  });

  it("uses two lines only for a long snippet with multiple matches", () => {
    const snippet = `命中 ${"一段足够长的上下文".repeat(12)} 命中`;
    expect(resultSnippetUsesTwoLines(result({ snippet }), "命中")).toBe(true);
  });

  it("uses an attachment filename as the primary object name", () => {
    const value = result({
      sourceType: "file_attachment",
      contentType: "file_attachment",
      sourceTitle: "quotation.xlsx",
    });
    expect(resultDisplayTitle(value)).toBe("quotation.xlsx");
  });

  it("keeps library and leaf context while shortening a deep path", () => {
    const value = result({ path: "Car/Projects/T29/Design/Page name", documentTitle: "Page name" });
    expect(compactResultPath(value)).toBe("Car / … / Design");
  });

  it("shows snippets only for actual content matches", () => {
    expect(resultShouldShowSnippet(result({ matchField: "title,path" }), "命中")).toBe(false);
    expect(resultShouldShowSnippet(result({ matchField: "title,body" }), "命中")).toBe(true);
  });

  it("derives a result row from one shared set of fallback terms", () => {
    const value = result({ matchTerms: [], modifiedAt: 1_700_000_000 });
    const presentation = searchResultRowPresentation(value, ["正文", "命中"]);

    expect(presentation.terms).toEqual(["正文", "命中"]);
    expect(presentation.displayTitle).toBe("页面名称");
    expect(presentation.contextPath).toBe("Car / … / 线束");
    expect(presentation.showSnippet).toBe(true);
    expect(presentation.dateLabel).not.toBe("");
  });

  it("does not scan or display a snippet for a title-only result", () => {
    const presentation = searchResultRowPresentation(
      result({ matchField: "title", snippet: "命中" }),
      ["命中"],
    );

    expect(presentation.titleOnly).toBe(true);
    expect(presentation.showSnippet).toBe(false);
    expect(presentation.snippetUsesTwoLines).toBe(false);
  });
});
