// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SearchResult } from "./SearchTypes";
import { useSavedResults } from "./useSavedResults";

let root: Root, host: HTMLDivElement, state: ReturnType<typeof useSavedResults>;
function Harness({ enabled = true }: { enabled?: boolean }) { state = useSavedResults({ searchHistoryEnabled: enabled }); return null; }
const render = async (enabled = true) => act(async () => root.render(<Harness enabled={enabled} />));
const result = (id: string, documentId = id): SearchResult => ({ id, entityKey: id, documentId, contentType: "block", sourceType: "craft_block", provider: "craft", libraryId: "lib", libraryName: "Library", spaceId: "space", spaceName: "Space", title: id, documentTitle: "Document", path: "", snippet: `excerpt-${id}`, matchTerms: [], matchField: "", matchCount: 1, subMatches: [] });
beforeEach(() => { localStorage.clear(); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("restores valid history and legacy page favorites without duplicating block hits", async () => {
  localStorage.setItem("craft-search-history-v1", JSON.stringify([null, "", "stored", 1]));
  localStorage.setItem("hub-desktop-favorites-v1", JSON.stringify([result("a", "document"), result("b", "document"), null]));
  await render();
  expect(state.searchHistory).toEqual(["stored"]);
  expect(state.favoriteResults).toHaveLength(1);
  expect(state.favoriteResults[0]).toMatchObject({ favoriteKind: "page", title: "Document", documentId: "document", snippet: "" });
});
it("maintains twelve unique trimmed queries and persists removal and clearing", async () => {
  await render();
  for (let index = 0; index < 14; index++) await act(async () => state.rememberQuery(` query-${index} `));
  await act(async () => state.rememberQuery("query-5"));
  expect(state.searchHistory).toHaveLength(12); expect(state.searchHistory[0]).toBe("query-5");
  expect(state.searchHistory).not.toContain("query-0");
  await act(async () => state.removeSearchHistoryItem("query-5"));
  expect(JSON.parse(localStorage.getItem("craft-search-history-v1")!)).toEqual(state.searchHistory);
  await act(async () => state.clearSearchHistory()); expect(state.searchHistory).toEqual([]); expect(localStorage.getItem("craft-search-history-v1")).toBeNull();
});
it("clears restored and current query history when the preference is disabled", async () => {
  localStorage.setItem("craft-search-history-v1", '["private"]'); await render(false);
  expect(state.searchHistory).toEqual([]); expect(localStorage.getItem("craft-search-history-v1")).toBeNull();
  await act(async () => state.rememberQuery("ignored")); expect(state.searchHistory).toEqual([]);
  await render(); await act(async () => state.rememberQuery("enabled")); await render(false);
  expect(state.searchHistory).toEqual([]); expect(localStorage.getItem("craft-search-history-v1")).toBeNull();
});
it("keeps page and snippet favorites independent through saved filters and restoration", async () => {
  await render(); const hit = result("block", "document");
  await act(async () => state.toggleFavorite(hit));
  await act(async () => state.toggleFavorite({ ...hit, favoriteKind: "snippet" }));
  expect(state.favoriteIds.size).toBe(1); expect(state.snippetFavoriteIds.size).toBe(1);
  await act(async () => state.setFavoriteFilter("snippet")); expect(state.filteredFavorites).toHaveLength(1); expect(state.filteredFavorites[0].snippet).toBe("excerpt-block");
  await act(async () => state.toggleFavorite(hit)); expect(state.favoriteIds.size).toBe(0); expect(state.snippetFavoriteIds.size).toBe(1);
  expect(JSON.parse(localStorage.getItem("hub-desktop-favorites-v2")!)).toEqual(state.favoriteResults);
});
it("moves revisited results to the front and limits persisted browsing history to one hundred", async () => {
  await render();
  for (let index = 0; index < 101; index++) await act(async () => state.rememberViewedResult(result(String(index))));
  await act(async () => state.rememberViewedResult({ ...result("5"), title: "Updated" }));
  expect(state.viewHistory).toHaveLength(100); expect(state.viewHistory[0]).toMatchObject({ id: "5", title: "Updated" }); expect(state.viewHistory.filter(item => item.id === "5")).toHaveLength(1); expect(state.viewHistory.some(item => item.id === "0")).toBe(false);
  expect(JSON.parse(localStorage.getItem("hub-desktop-view-history-v1")!)).toEqual(state.viewHistory);
});
