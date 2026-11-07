// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { useLibraryManagement } from "./LibraryManagement";
import { useWorkspaceIndexing } from "./useWorkspaceIndexing";
import { useJournalCreation } from "./useJournalCreation";
import { useSearchResultData } from "./useSearchResultData";
import { useMarkdownLinkOpening } from "./useMarkdownLinkOpening";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const libraries: LibrarySummary[] = ["a", "b", "offline"].map(id => ({ id, name: id, provider: "craft", connected: id !== "offline", documentCount: 3, excludedPaths: [] }));
const notifier = vi.fn(), error = vi.fn(), reload = vi.fn(), status = vi.fn(), submit = vi.fn(), openResult = vi.fn(), openExternal = vi.fn();
const sourceFilters = { craft: true, task: true, media: true, pdf: true, attachment: true };
const normalize = (value: unknown) => value as SearchResult[];
let root: Root, host: HTMLDivElement, indexing: ReturnType<typeof useWorkspaceIndexing>, journal: ReturnType<typeof useJournalCreation>, search: ReturnType<typeof useSearchResultData>, openLink: ReturnType<typeof useMarkdownLinkOpening>;
function IndexHarness({ empty = false, selected = null, paused = false }: { empty?: boolean; selected?: string[] | null; paused?: boolean }) { indexing = useWorkspaceIndexing({ ready: true, spaces: libraries, activeSpaces: selected === null ? libraries : libraries.filter(library => selected.includes(library.id)), selectedLibraryIds: selected, documentCount: empty ? 0 : 3, libraryManagement: { act: submit, libraries: paused ? { a: { state: "paused" } } : {} } as unknown as ReturnType<typeof useLibraryManagement>, reloadSpaces: reload, refreshStatus: status, setError: error, showOperationStatus: notifier }); return null; }
function JournalHarness() { journal = useJournalCreation({ reloadSpaces: reload, refreshStatus: status, setError: error }); return null; }
function SearchHarness({ query = "query", syncing = false }: { query?: string; syncing?: boolean }) { search = useSearchResultData({ query, spaceIds: null, folderId: "", updatedAfter: null, sourceFilters, searchScope: "all", recentPageLimit: 0, recentTaskLimit: 0, ready: true, hasSpaces: true, syncing, isComposing: false, normalizeResults: normalize, setError: error }); return null; }
function LinkHarness({ provider = "obsidian" }: { provider?: "obsidian" | "craft" | "dida365" }) { openLink = useMarkdownLinkOpening({ previewSelected: { provider, libraryId: "lib", path: "/note", spaceId: "space", documentId: "doc" } as SearchResult, openResult, openExternalLink: openExternal, showOperationStatus: notifier }); return null; }
beforeEach(() => { [invokeMock, notifier, error, reload, status, submit, openResult, openExternal].forEach(mock => mock.mockReset()); reload.mockResolvedValue(libraries); status.mockResolvedValue(undefined); submit.mockResolvedValue(undefined); openExternal.mockResolvedValue(undefined); (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("submits only selected connected eligible libraries through the provided shared manager", async () => {
  await act(async () => root.render(<IndexHarness selected={["a", "b", "offline"]} paused />));
  await act(async () => indexing.refreshIndex()); expect(submit.mock.calls).toEqual([["b", "sync"]]); expect(reload).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce(); expect(notifier.mock.calls[0][0]).toContain("1 个资料库");
});
it("coalesces repeated sync submissions and bootstraps an empty connected index once", async () => {
  let resolve!: () => void; submit.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  await act(async () => root.render(<IndexHarness selected={["a"]} empty />)); expect(indexing.syncing).toBe(true); expect(submit).toHaveBeenCalledOnce();
  await act(async () => indexing.refreshIndex()); expect(submit).toHaveBeenCalledOnce();
  await act(async () => resolve()); expect(indexing.syncing).toBe(false);
  await act(async () => root.render(<IndexHarness selected={["a"]} empty />)); expect(submit).toHaveBeenCalledOnce();
});
it("does not publish completion or reload data after the indexing owner unmounts", async () => {
  let resolve!: () => void; submit.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  await act(async () => root.render(<IndexHarness selected={["a"]} />)); let pending!: Promise<void>; await act(async () => { pending = indexing.refreshIndex(); });
  await act(async () => root.render(null)); await act(async () => { resolve(); await pending; }); expect(reload).not.toHaveBeenCalled(); expect(notifier).not.toHaveBeenCalled();
});
it("creates journals then synchronizes each returned library before refreshing the registry and status", async () => {
  invokeMock.mockImplementation(async command => command === "create_journals" ? [{ libraryId: "a" }, { libraryId: "b" }] : undefined);
  await act(async () => root.render(<JournalHarness />)); await act(async () => journal.setCreateJournalDate("2026-10-11")); await act(async () => journal.createSelectedJournals(["a", "b"]));
  expect(invokeMock.mock.calls).toEqual([["create_journals", { date: "2026-10-11", libraryIds: ["a", "b"] }], ["sync_library", { libraryId: "a" }], ["sync_library", { libraryId: "b" }]]); expect(journal.createJournalDate).toBe(""); expect(journal.creatingJournal).toBe(false); expect(reload).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce();
});
it("retains the journal dialog date and reports native creation errors without a sync follow-up", async () => {
  invokeMock.mockRejectedValue(new Error("unavailable")); await act(async () => root.render(<JournalHarness />)); await act(async () => journal.setCreateJournalDate("2026-10-11")); await act(async () => journal.createSelectedJournals(["a"]));
  expect(journal.createJournalDate).toBe("2026-10-11"); expect(journal.creatingJournal).toBe(false); expect(error).toHaveBeenLastCalledWith("Error: unavailable"); expect(reload).not.toHaveBeenCalled(); expect(invokeMock).toHaveBeenCalledOnce();
});
it("owns search bodies and rejects results from a superseded request", async () => {
  vi.useFakeTimers(); const pending = new Map<string, (value: unknown) => void>(); invokeMock.mockImplementation((_command, args) => new Promise(resolve => pending.set(args.query, resolve)));
  await act(async () => root.render(<SearchHarness query="first" />)); await act(async () => vi.advanceTimersByTimeAsync(280));
  await act(async () => root.render(<SearchHarness query="second" />)); await act(async () => vi.advanceTimersByTimeAsync(280));
  await act(async () => pending.get("second")!([{ id: "new" }])); await act(async () => pending.get("first")!([{ id: "old" }])); expect(search.results[0].id).toBe("new"); expect(search.resultsCurrent).toBe(true); expect(search.searching).toBe(false);
});
it("refreshes the original search after sync completes without a second unfiltered body read", async () => {
  vi.useFakeTimers(); invokeMock.mockResolvedValue([{ id: "searched" }]); await act(async () => root.render(<SearchHarness query="kept" syncing />)); await act(async () => vi.advanceTimersByTimeAsync(500)); expect(invokeMock).not.toHaveBeenCalled();
  await act(async () => root.render(<SearchHarness query="kept" />)); await act(async () => vi.advanceTimersByTimeAsync(280)); expect(search.results[0].id).toBe("searched"); expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["local_search"]);
});
it("routes Obsidian wiki links and Craft subpages through their existing native and shared opening paths", async () => {
  invokeMock.mockResolvedValue(undefined); await act(async () => root.render(<LinkHarness />)); await act(async () => openLink("#obsidian-wikilink=Some%20Note")); expect(invokeMock).toHaveBeenCalledWith("open_obsidian_wikilink", { libraryId: "lib", sourcePath: "/note", file: "Some Note" });
  await act(async () => root.render(<LinkHarness provider="craft" />)); await act(async () => openLink("#craft-subpage=block")); expect(openResult).toHaveBeenCalledWith(expect.objectContaining({ id: "", blockId: "block", pageId: "block" }), "preview");
});
it("routes task attachments separately from web links without changing their source context", async () => {
  invokeMock.mockResolvedValue(undefined); await act(async () => root.render(<LinkHarness provider="dida365" />)); await act(async () => openLink("attachment.png")); expect(invokeMock).toHaveBeenCalledWith("open_dida_attachment", { spaceId: "space", documentId: "doc", source: "attachment.png" });
  await act(async () => openLink("https://example.invalid/source")); expect(openExternal).toHaveBeenCalledWith("https://example.invalid/source"); expect(invokeMock).toHaveBeenCalledOnce();
});
