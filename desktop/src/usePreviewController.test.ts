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

  it("invalidates extracted file text even when the parent document timestamp is unchanged", () => {
    const file = { ...result, contentType: "file_attachment", sourceItemId: "source-1", id: "source-1:file:version-1:0" };
    expect(previewDocumentKey({ ...file, id: "source-1:file:version-2:0" })).not.toBe(previewDocumentKey(file));
  });
  it("reloads a local-file root when its content or extraction version changes at the same timestamp", () => {
    const file={...result,provider:"files" as const,contentType:"file_document",id:"file-root:doc:hash:pending"};
    expect(previewDocumentKey({...file,id:"file-root:doc:hash:completed:v1"})).not.toBe(previewDocumentKey(file));
    expect(previewDocumentKey({...file,id:"file-root:doc:new-hash:completed:v2"})).not.toBe(previewDocumentKey(file));
  });
});
