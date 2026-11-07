import { describe, expect, it } from "vitest";
import {
  beginOpenAttempt,
  canOpenResultSource,
  buildOpenResultRequest,
  finishOpenAttempt,
  resultOpenMode,
  usesCraftBridge,
} from "./ResultOpening";
import type { SearchResult } from "./SearchTypes";

const settings = {
  craftResultOpenMode: "client" as const,
  craftPreviewOpenMode: "bridge" as const,
};

const searchResult: SearchResult = {
  id: "result-1",
  entityKey: "craft:page:block",
  documentId: "page-id",
  blockId: "block-id",
  contentType: "craft_subpage",
  sourceType: "craft_page",
  provider: "craft",
  libraryId: "library-id",
  libraryName: "Car",
  spaceId: "space-id",
  spaceName: "Car",
  title: "子页面",
  path: "父页面/子页面",
  snippet: "命中正文",
  matchTerms: ["命中"],
  matchField: "body",
  matchCount: 1,
  subMatches: [],
};

describe("result opening policy", () => {
  it("keeps result and preview opening modes independent", () => {
    expect(resultOpenMode(settings, "result")).toBe("client");
    expect(resultOpenMode(settings, "preview")).toBe("bridge");
  });

  it("sends the precise block and result identity to the backend", () => {
    expect(buildOpenResultRequest(searchResult, "preview", settings)).toEqual({
      libraryId: "library-id",
      documentId: "page-id",
      blockId: "block-id",
      resultId: "result-1",
      matchField: "body",
      matchTerms: ["命中"],
      openMode: "bridge",
    });
  });

  it("falls back to the document id only when no block id exists", () => {
    const request = buildOpenResultRequest({ ...searchResult, blockId: undefined }, "result", settings);
    expect(request.blockId).toBe("page-id");
  });

  it("recognizes CraftBridge opening without affecting other providers", () => {
    expect(usesCraftBridge(searchResult, "preview", settings)).toBe(true);
    expect(usesCraftBridge({ ...searchResult, provider: "obsidian" }, "preview", settings)).toBe(false);
  });

  it("blocks repeated opens until the trailing cooldown has elapsed", () => {
    const gate = { pending: false, cooldownUntil: 0 };
    expect(beginOpenAttempt(gate, 1000)).toBe(true);
    expect(beginOpenAttempt(gate, 1001)).toBe(false);
    finishOpenAttempt(gate, 2000);
    expect(beginOpenAttempt(gate, 3199)).toBe(false);
    expect(beginOpenAttempt(gate, 3500)).toBe(true);
  });
});

it("opens cached Craft pages independently of sync, while retaining local-library gating", () => {
  expect(canOpenResultSource(searchResult, [], "windows")).toBe(true);
  expect(canOpenResultSource({ ...searchResult, documentId: "" }, [], "windows")).toBe(false);
  expect(canOpenResultSource(undefined, [], "windows")).toBe(false);
  expect(canOpenResultSource({ ...searchResult, provider: "obsidian" }, [], "windows")).toBe(false);
  expect(canOpenResultSource({ ...searchResult, provider: "dida365" }, [], "android")).toBe(true);
  const disconnected = { id: searchResult.libraryId, provider: "craft" as const, name: "Car", connected: false, documentCount: 1, excludedPaths: [] };
  expect(canOpenResultSource(searchResult, [disconnected], "windows")).toBe(true);
  expect(canOpenResultSource({ ...searchResult, provider: "obsidian" }, [{ ...disconnected, provider: "obsidian", connected: true }], "windows")).toBe(true);
});
