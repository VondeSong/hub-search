import { describe, expect, it } from "vitest";
import { asPageFavorite, normalizePageFavorites, pageFavoriteKey, togglePageFavorite, toggleSnippetFavorite } from "./PageFavorites";
import type { SearchResult } from "./SearchTypes";

const hit: SearchResult = {
  id: "hit-1", entityKey: "chunk-1", provider: "craft", libraryId: "main", spaceId: "main",
  libraryName: "Main", spaceName: "Main", documentId: "doc", documentTitle: "页面标题",
  blockId: "paragraph", title: "片段标题", path: "项目/页面标题", contentType: "pdf_page",
  sourceType: "pdf_native", sourceItemId: "attachment", sourceTitle: "附件.pdf", pageNumber: 3,
  snippet: "命中的段落", matchTerms: ["命中"], matchField: "body", matchCount: 1, subMatches: [],
};

describe("page favorites", () => {
  it("keeps page and snippet favorites independent through save, reload and removal", () => {
    const page = togglePageFavorite([], hit);
    const both = toggleSnippetFavorite(page, hit);
    expect(both).toHaveLength(2);
    const restored = normalizePageFavorites(JSON.parse(JSON.stringify(both)));
    expect(restored).toEqual(both);
    expect(restored[0].id).toBe(hit.id);
    expect(restored[0].blockId).toBe(hit.blockId);
    expect(restored[0].pageNumber).toBe(3);
    expect(restored[0].snippet).toBe(hit.snippet);
    expect(togglePageFavorite(restored, hit)).toEqual([both[0]]);
    expect(toggleSnippetFavorite(restored, hit)).toEqual(page);
    const another = { ...hit, id: "other", blockId: "other", snippet: "另一片段" };
    expect(toggleSnippetFavorite(restored, another)).toHaveLength(3);
  });
  it("shares a favorite between a homepage page and all its search hits", () => {
    const home = { ...hit, id: "page-row", entityKey: "page", blockId: "doc" };
    const saved = togglePageFavorite([], hit);
    expect(pageFavoriteKey(saved[0])).toBe(pageFavoriteKey(home));
    expect(togglePageFavorite(saved, home)).toEqual([]);
    expect(normalizePageFavorites([hit, home])).toHaveLength(1);
  });
  it("keeps documents in different libraries and providers separate", () => {
    expect(normalizePageFavorites([hit, { ...hit, libraryId: "car" }, { ...hit, provider: "obsidian" }])).toHaveLength(3);
  });
  it("opens the whole document rather than a hit or attachment and survives reload normalization", () => {
    const saved = asPageFavorite(hit);
    expect(saved.title).toBe("页面标题");
    expect(saved.blockId).toBe("doc");
    expect(saved.pageId).toBe("doc");
    expect(saved.id).not.toBe(hit.id);
    expect(saved.sourceItemId).toBeUndefined();
    expect(saved.pageNumber).toBeUndefined();
    expect(saved.matchTerms).toEqual([]);
    expect(normalizePageFavorites(JSON.parse(JSON.stringify([saved])))).toEqual([saved]);
  });
});
