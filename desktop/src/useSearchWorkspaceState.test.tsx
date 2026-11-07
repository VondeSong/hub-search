// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FolderSummary, LibrarySummary } from "./SearchTypes";
import { useSearchWorkspaceState } from "./useSearchWorkspaceState";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const libraries: LibrarySummary[] = ["a", "b"].map(id => ({ id, name: id, provider: "craft", connected: true, documentCount: 3, excludedPaths: [] }));
const folders: FolderSummary[] = libraries.map(library => ({ id: "same", name: library.id, path: `/${library.id}`, spaceId: library.id, libraryName: library.name }));
const status = vi.fn();
let root: Root, host: HTMLDivElement, state: ReturnType<typeof useSearchWorkspaceState>;
function Harness({ spaces = libraries, ready = true }: { spaces?: LibrarySummary[]; ready?: boolean }) { state = useSearchWorkspaceState({ spaces, ready, showOperationStatus: status }); return null; }
const render = async (props: Parameters<typeof Harness>[0] = {}) => act(async () => root.render(<Harness {...props} />));
beforeEach(() => { localStorage.clear(); invokeMock.mockReset(); status.mockClear(); invokeMock.mockResolvedValue(folders); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); localStorage.clear(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("restores legacy library and media filters then persists their current complete form", async () => {
  localStorage.setItem("craft-search-filters-v1", JSON.stringify({ libraryId: "b", folderId: "same", dateFilter: "30", searchScope: "title", sourceFilters: { image: false, task: false } })); await render();
  expect(state.selectedLibraryIds).toEqual(["b"]); expect(state.dateFilter).toBe("30"); expect(state.searchScope).toBe("title"); expect(state.sourceFilters).toEqual({ craft: true, task: false, media: false, pdf: true, attachment: true });
  expect(state.folderId).toBe("a\u0000same"); expect(state.effectiveSpaceIds).toEqual(["a"]); expect(state.effectiveFolderId).toBe("same");
  const stored = JSON.parse(localStorage.getItem("craft-search-filters-v1")!); expect(stored.libraryIds).toEqual(["b"]); expect(stored).not.toHaveProperty("libraryId"); expect(stored.folderId).toBe("a\u0000same");
});
it("distinguishes all and empty selections and reconciles removal only after registry readiness", async () => {
  localStorage.setItem("craft-search-filters-v1", '{"libraryIds":["a","missing"]}'); await render({ spaces: [], ready: false }); expect(state.selectedLibraryIds).toEqual(["a", "missing"]);
  await render(); expect(state.selectedLibraryIds).toEqual(["a"]); expect(state.currentSpaceIds).toEqual(["a"]);
  await act(async () => state.toggleLibrarySelection("b")); expect(state.selectedLibraryIds).toBeNull(); expect(state.currentSpaceIds).toBeNull();
  await act(async () => state.toggleAllLibraries()); expect(state.currentSpaceIds).toEqual([]); expect(state.currentSpaceName).toBe("未选择资料库");
  await act(async () => state.selectOnlyLibrary("b")); await render({ spaces: [libraries[0]] }); expect(state.selectedLibraryIds).toEqual([]);
  await act(async () => state.selectAllLibraries()); expect(state.activeSpaces.map(item => item.id)).toEqual(["a"]);
});
it("rejects a stale folder response after library scope changes", async () => {
  const pending = new Map<string, (value: FolderSummary[]) => void>(); invokeMock.mockImplementation((_command, args) => new Promise(resolve => pending.set(args.spaceIds?.[0] ?? "all", resolve)));
  await render(); await act(async () => state.selectOnlyLibrary("a")); await act(async () => state.selectOnlyLibrary("b"));
  await act(async () => pending.get("b")!([folders[1]])); await act(async () => pending.get("a")!([folders[0]]));
  expect(state.folders).toEqual([folders[1]]); await act(async () => state.setFolderId("b\u0000same")); expect(state.effectiveSpaceIds).toEqual(["b"]);
});
it("owns complete smart collection snapshots, duplicate names, applying unavailable libraries and saved updates", async () => {
  await render(); await act(async () => { state.setQuery("topic"); state.selectLibraries(["a", "missing"]); state.setDateFilter("7"); state.setSearchScope("title_heading"); state.setSourceFilters({ craft: false, task: true, media: false, pdf: true, attachment: false }); });
  await act(async () => { expect(state.addSmartCollection("  Reading  ")).toBe(true); }); const saved = state.smartCollections[0]; expect(saved).toMatchObject({ name: "Reading", query: "topic", libraryIds: ["a", "missing"], dateFilter: "7", searchScope: "title_heading" });
  await act(async () => { expect(state.addSmartCollection("reading")).toBe(false); }); expect(state.smartCollections).toHaveLength(1);
  await act(async () => { state.setQuery("different"); state.selectAllLibraries(); state.applySmartCollectionFilters(saved); }); expect(state.query).toBe("topic"); expect(state.selectedLibraryIds).toEqual(["a"]); expect(state.sourceFilters).toEqual(saved.sourceFilters);
  await act(async () => { expect(state.renameSmartCollection(saved.id, " Renamed ")).toBe(true); }); expect(JSON.parse(localStorage.getItem("hub-desktop-smart-collections-v1")!)[0].name).toBe("Renamed");
  await act(async () => state.deleteSmartCollection(saved.id)); expect(state.smartCollections).toEqual([]); expect(localStorage.getItem("hub-desktop-smart-collections-v1")).toBe("[]");
});
it("restores malformed saved filters safely and owns sidebar preference writes", async () => {
  localStorage.setItem("craft-search-filters-v1", "invalid"); await render(); expect(state.dateFilter).toBe("any"); expect(state.selectedLibraryIds).toBeNull(); expect(state.activeFilterCount).toBe(0);
  await act(async () => state.changeDesktopSidebarSetting(true)); expect(state.desktopSidebarEnabled).toBe(true); expect(localStorage.getItem("hub-desktop-sidebar-enabled-v1")).toBe("true");
});
