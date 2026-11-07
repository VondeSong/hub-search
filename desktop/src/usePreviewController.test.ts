import { describe, expect, it } from "vitest";
import type { SearchResult } from "./SearchTypes";
import { mcpToolText, previewDocumentKey } from "./usePreviewController";

const result = {
  id: "result-1", entityKey: "entity-1", documentId: "doc-1", contentType: "page",
  sourceType: "page", provider: "craft", libraryId: "library-1", libraryName: "Main",
  spaceId: "space-1", spaceName: "Main", title: "标题", path: "path", modifiedAt: 42,
  snippet: "", matchTerms: [], matchField: "title", matchCount: 1, subMatches: [],
} satisfies SearchResult;

describe("preview controller policy", () => {
  it("keys cached previews by page entity so parent and child pages cannot share content", () => {
    expect(previewDocumentKey(result)).toBe("space-1\u0000doc-1\u0000entity-1\u000042");
    expect(previewDocumentKey({ ...result, entityKey: "page:space-1:doc-1:child" }))
      .not.toBe(previewDocumentKey(result));
  });

  it("reloads a Dida preview when its completion state changes without a timestamp change", () => {
    const task = { ...result, provider: "dida365" as const, taskStatus: 0 };
    expect(previewDocumentKey({ ...task, taskStatus: 2 })).not.toBe(previewDocumentKey(task));
  });

  it("extracts textual MCP content blocks", () => {
    expect(mcpToolText({ content: [{ type: "text", text: "第一段" }, { type: "image" }, { type: "text", text: "第二段" }] }))
      .toBe("第一段\n第二段");
  });
});
