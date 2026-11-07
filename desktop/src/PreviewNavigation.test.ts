import { describe, expect, it } from "vitest";
import { EMPTY_PREVIEW_NAVIGATION, movePreviewNavigation, pushPreviewNavigation } from "./PreviewNavigation";
import type { SearchResult } from "./SearchTypes";

function result(id: string): SearchResult {
  return {
    id, entityKey: `craft:${id}`, documentId: id, contentType: "craft_page", sourceType: "craft_page",
    provider: "craft", libraryId: "lib", libraryName: "资料库", spaceId: "space", spaceName: "资料库",
    title: id, path: "路径", snippet: "", matchTerms: [], matchField: "title", matchCount: 1, subMatches: [],
  };
}

describe("preview navigation", () => {
  it("moves backward and truncates the forward branch after a new visit", () => {
    let state = pushPreviewNavigation(EMPTY_PREVIEW_NAVIGATION, result("a"));
    state = pushPreviewNavigation(state, result("b"));
    state = pushPreviewNavigation(state, result("c"));
    state = movePreviewNavigation(state, -1);
    state = pushPreviewNavigation(state, result("d"));
    expect(state.entries.map((entry) => entry.id)).toEqual(["a", "b", "d"]);
    expect(state.index).toBe(2);
  });

  it("deduplicates consecutive visits and applies the history limit", () => {
    let state = pushPreviewNavigation(EMPTY_PREVIEW_NAVIGATION, result("a"), 2);
    const same = pushPreviewNavigation(state, result("a"), 2);
    expect(same).toBe(state);
    state = pushPreviewNavigation(state, result("b"), 2);
    state = pushPreviewNavigation(state, result("c"), 2);
    expect(state.entries.map((entry) => entry.id)).toEqual(["b", "c"]);
  });
});
