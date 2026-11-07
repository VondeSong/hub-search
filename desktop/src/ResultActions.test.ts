import { describe, expect, it, vi } from "vitest";
import { fallbackResultLink, resultMarkdownLink, resultSummary, writeResultDragData } from "./ResultActions";
import type { SearchResult } from "./SearchTypes";

const result: SearchResult = {
  id: "item", entityKey: "craft:item", documentId: "doc", blockId: "block", contentType: "craft_page",
  sourceType: "craft_page", provider: "craft", libraryId: "lib", libraryName: "工作", spaceId: "space",
  spaceName: "工作", title: "计划 [新版]", path: "项目", snippet: "…正文   摘要", matchTerms: [], matchField: "title",
  matchCount: 1, subMatches: [],
};

describe("result actions", () => {
  it("creates escaped Markdown links and clean summaries", () => {
    expect(resultMarkdownLink(result, "https://example.com")).toBe("[计划 \\[新版\\]](https://example.com)");
    expect(resultSummary(result)).toBe("正文 摘要");
  });

  it("provides an immediate Craft fallback link for drag start", () => {
    expect(fallbackResultLink(result)).toBe("craftdocs://open?spaceId=space&blockId=block");
  });

  it("writes interoperable drag formats", () => {
    const setData = vi.fn();
    const transfer = { effectAllowed: "none", setData } as unknown as DataTransfer;
    writeResultDragData(transfer, result, "https://example.com");
    expect(transfer.effectAllowed).toBe("copyLink");
    expect(setData).toHaveBeenCalledWith("application/x-hub-agent-source", JSON.stringify({result}));
    expect(setData).toHaveBeenCalledWith("text/markdown", "[计划 \\[新版\\]](https://example.com)");
    expect(setData).toHaveBeenCalledWith("text/uri-list", "https://example.com");
  });
});
