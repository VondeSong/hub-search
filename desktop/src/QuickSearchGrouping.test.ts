import { expect, it } from "vitest";
import { normalizeQuickSearchResults } from "./SearchResultTestData";
import { groupQuickSearchResults, prepareQuickSearchResults, resultPassage, searchResultSummary } from "./QuickSearchGrouping";

it("collects interleaved and nested matches without losing block targets or combining libraries", () => {
  const raw = normalizeQuickSearchResults([
    { id: "a1", documentId: "a", spaceId: "s", title: "Same", snippet: "match one", matchField: "body", subMatches: [
      { id: "a2", blockId: "block-a2", snippet: "match two", matchField: "body" }, null, {},
    ] },
    { id: "b", documentId: "b", spaceId: "s", title: "Same", snippet: "match other", matchField: "body" },
    { id: "a2", documentId: "a", spaceId: "s", title: "Same", snippet: "match two", matchField: "body" },
    { id: "c", documentId: "a", spaceId: "other", title: "Same", snippet: "match library", matchField: "body" },
  ]);
  const results = prepareQuickSearchResults(raw, "match");
  expect(results.map(result => result.id)).toEqual(["a1", "a2", "b", "c"]);
  expect(results[1].blockId).toBe("block-a2");
  expect(groupQuickSearchResults(results)).toHaveLength(3);
  expect(searchResultSummary(results, "match")).toBe("3 项内容 · 4 段正文匹配");
});

it("removes inherited page metadata from body results but retains the page evidence", () => {
  const raw = normalizeQuickSearchResults([{
    id: "page", documentId: "page", spaceId: "s", title: "使用AI", snippet: "date: unrelated", matchTerms: ["使用AI"], matchField: "title,path",
    subMatches: [
      { id: "body", blockId: "body-block", snippet: "开始使用AI调整图标", matchTerms: ["使用AI"], matchField: "body,title,path" },
      { id: "unrelated", snippet: "没有命中的正文", matchTerms: ["使用AI"], matchField: "title,path" },
    ],
  }]);
  const results = prepareQuickSearchResults(raw, "使用AI");
  expect(results.map(result => result.id)).toEqual(["body"]);
  expect(results[0].pageMatchFields).toEqual(expect.arrayContaining(["title", "path", "body"]));
  expect(results[0].blockId).toBe("body-block");
});

it("merges overlapping contexts only at a known shared anchor and keeps PDF pages separate", () => {
  const overlap = "历史" + "共同上下文".repeat(8);
  const raw = normalizeQuickSearchResults([
    { id: "a", blockId: "same", documentId: "doc", spaceId: "s", title: "Page", snippet: "前文" + overlap, matchField: "body" },
    { id: "b", blockId: "same", documentId: "doc", spaceId: "s", title: "Page", snippet: overlap + "后文", matchField: "body" },
    { id: "p1", sourceItemId: "pdf", sourceType: "pdf_native", pageNumber: 1, documentId: "doc", spaceId: "s", title: "Page", snippet: overlap, matchField: "body" },
    { id: "p2", sourceItemId: "pdf", sourceType: "pdf_native", pageNumber: 2, documentId: "doc", spaceId: "s", title: "Page", snippet: overlap, matchField: "body" },
  ]);
  const results = prepareQuickSearchResults(raw, "历史");
  expect(results.map(result => result.id)).toEqual(["a", "p1", "p2"]);
  expect(results[0].snippet).toBe("前文" + overlap + "后文");
  expect(results[0].blockId).toBe("same");
  expect(searchResultSummary(results, "历史")).toBe("1 项内容 · 3 段正文匹配");
});

it("does not turn title-only evidence into body evidence or count a heading as a paragraph", () => {
  const [title, heading] = normalizeQuickSearchResults([
    { id: "title", spaceId: "s", title: "历史", snippet: "历史恰巧也在摘要中", matchField: "title", matchTerms: ["历史"] },
    { id: "heading", spaceId: "s", title: "历史章节", documentTitle: "Page", snippet: "无关", matchField: "heading", matchTerms: ["历史"] },
  ]);
  expect(resultPassage(title, "历史")).toBeUndefined();
  expect(resultPassage(heading, "历史")).toEqual({ text: "历史章节", body: false });
});

it("normalization preserves URL and code-only match evidence", () => {
  const results = normalizeQuickSearchResults([
    { id: "url", spaceId: "s", title: "Page", snippet: "[使用说明](https://example.org/AI)", matchTerms: ["使用", "AI"], matchField: "body" },
    { id: "code", spaceId: "s", title: "Page", snippet: "```js\nconst needle = 1;\n```", matchTerms: ["needle"], matchField: "body" },
  ]);
  expect(results[0].snippet).toContain("example.org/AI");
  expect(results[1].snippet).toContain("needle");
});
