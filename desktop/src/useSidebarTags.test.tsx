// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSidebarTags } from "./useSidebarTags";
import type { SidebarTagSummary } from "./DesktopSidebarPresentation";
import type { SearchResult } from "./SearchTypes";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const tags: SidebarTagSummary[] = [{ name: "Topic/Alpha", normalizedName: "topic/alpha", count: 3 }, { name: "Beta", normalizedName: "beta", count: 0 }];
const scope = ["lib"];
const normalize = (value: unknown) => value as SearchResult[];
const setError = vi.fn();
let root: Root, host: HTMLDivElement, state: ReturnType<typeof useSidebarTags>;
function Harness({ activeView = "home", query = "", dynamicFacetCountsEnabled = false, currentSpaceIds = scope }: { activeView?: "home" | "tags"; query?: string; dynamicFacetCountsEnabled?: boolean; currentSpaceIds?: string[] }) { state = useSidebarTags({ ready: true, libraryCount: 1, currentSpaceIds, effectiveSpaceIds: currentSpaceIds, effectiveFolderId: "folder", query, dateFilter: "any", sourceFilters: { craft: true, task: false, media: true, pdf: true, attachment: true }, searchScope: "title", documentCount: 10, dynamicFacetCountsEnabled, activeView, normalizeResults: normalize, setError }); return null; }
const render = async (props: Parameters<typeof Harness>[0] = {}) => act(async () => root.render(<Harness {...props} />));
beforeEach(() => { localStorage.clear(); invokeMock.mockReset(); setError.mockClear(); invokeMock.mockImplementation(async command => command === "list_tags" ? tags : command === "list_related_tags" ? [tags[1]] : command === "get_tag_taxonomy" ? { summary: { canonicalName: "Topic/Alpha" } } : command === "dynamic_search_facets" ? { total: 9, truncated: false, sources: {}, libraries: {}, folders: {}, tags: { "topic/alpha": 9 } } : []); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); localStorage.clear(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("loads navigation tags without hidden tag bodies and requests the complete active tag contract", async () => {
  await render(); expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["list_tags"]);
  await act(async () => state.setSelectedSidebarTag("topic/alpha")); await render({ activeView: "tags" });
  expect(invokeMock).toHaveBeenCalledWith("local_search", { query: "Topic/Alpha", limit: 200, spaceIds: scope, folderId: "folder", updatedAfter: null, includeCraftPages: true, includeDidaTasks: false, includeImageOcr: false, includePdf: false, includePdfOcr: false, includeAttachments: false, searchScope: "tag" });
  expect(invokeMock).toHaveBeenCalledWith("list_related_tags", { normalizedName: "topic/alpha", spaceIds: scope, limit: 3 });
  expect(state.tagResultsFor).toBe(state.tagResultContext); expect(state.selectedSidebarTagGroup).toBe("Topic");
});
it("coalesces rapid facet queries and clears their counts when the preference is disabled", async () => {
  vi.useFakeTimers(); await render({ dynamicFacetCountsEnabled: true, query: "old" }); await render({ dynamicFacetCountsEnabled: true, query: "new" });
  expect(invokeMock.mock.calls.some(call => call[0] === "dynamic_search_facets")).toBe(false);
  await act(async () => { await vi.advanceTimersByTimeAsync(360); });
  expect(invokeMock.mock.calls.filter(call => call[0] === "dynamic_search_facets")).toHaveLength(1); expect(invokeMock).toHaveBeenCalledWith("dynamic_search_facets", { query: "new", updatedAfter: null, searchScope: "title" }); expect(state.displayedSidebarTags[0].count).toBe(9);
  await render(); expect(state.dynamicFacets.total).toBe(0); expect(state.displayedSidebarTags[0].count).toBe(3);
});
it("ignores old scope tags after a newer library response arrives", async () => {
  const pending = new Map<string, (value: SidebarTagSummary[]) => void>(); invokeMock.mockImplementation((_command, args) => new Promise(resolve => pending.set(args.spaceIds[0], resolve)));
  const first = ["first"], second = ["second"]; await render({ currentSpaceIds: first }); await render({ currentSpaceIds: second });
  await act(async () => pending.get("second")!([tags[1]])); await act(async () => pending.get("first")!([tags[0]])); expect(state.sidebarTags).toEqual([tags[1]]); expect(state.tagsLoading).toBe(false);
});
it("owns favorite recent group and color persistence without changing indexed tag facts", async () => {
  localStorage.setItem("hub-desktop-tag-groups-v1", JSON.stringify([{ id: "old", name: " Old ", tagIds: ["beta", "beta", 1] }])); await render(); expect(state.sidebarTagGroups[0].tagIds).toEqual(["beta"]);
  await act(async () => { state.toggleFavoriteSidebarTag("topic/alpha"); state.rememberSidebarTag("beta"); state.createSidebarTagGroup("New"); });
  const newGroup = state.sidebarTagGroups.find(group => group.name === "New")!;
  await act(async () => { state.assignSidebarTagToGroup("beta", newGroup.id); state.updateSidebarTagProperty("beta", { color: "#abcdef", description: "  Useful  " }); });
  expect(state.sidebarTagGroups[0].tagIds).toEqual([]); expect(new Set(state.sidebarTagGroups[1].tagIds)).toEqual(new Set(["beta"])); expect(state.tagProperties.beta).toEqual({ color: "#ABCDEF", description: "Useful" });
  expect(JSON.parse(localStorage.getItem("hub-desktop-favorite-tags-v1")!)).toEqual(["topic/alpha"]); expect(JSON.parse(localStorage.getItem("hub-desktop-recent-tags-v1")!)).toEqual(["beta"]); expect(JSON.parse(localStorage.getItem("hub-desktop-tag-groups-v1")!)).toEqual(state.sidebarTagGroups); expect(state.sidebarTags).toEqual(tags);
  await act(async () => state.deleteSidebarTagGroup(newGroup.id)); expect(state.sidebarTagGroups).toHaveLength(1);
});
it("refreshes taxonomy and navigation together after a committed tag change", async () => {
  await render({ activeView: "tags" }); await act(async () => state.setSelectedSidebarTag("topic/alpha")); const before = invokeMock.mock.calls.length;
  await act(async () => state.refreshSidebarTags());
  const changed = invokeMock.mock.calls.slice(before).map(call => call[0]); expect(changed).toContain("list_tags"); expect(changed).toContain("local_search"); expect(changed).toContain("get_tag_taxonomy"); expect(changed).toContain("list_related_tags"); expect(state.tagTaxonomyRevision).toBe(1);
});
