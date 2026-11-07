// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultJournalView, type JournalViewConfig } from "./JournalViews";
import { journalRange, useJournalPage, type JournalPage } from "./useJournalPage";
import type { SearchResult } from "./SearchTypes";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
let host: HTMLDivElement, root: Root, state: ReturnType<typeof useJournalPage>;
type Props = { view?: Partial<JournalViewConfig>; scope?: string[] | null; revision?: string; enabled?: boolean };
const view = (patch: Partial<JournalViewConfig> = {}): JournalViewConfig => ({ ...defaultJournalView(), month: "2026-10", ...patch });
function Harness({ view: config = {}, scope = null, revision = "1", enabled = true }: Props) { state = useJournalPage(view(config), scope, revision, enabled); return null; }
const render = async (props: Props = {}) => { await act(async () => root.render(<Harness {...props} />)); };
const item = (id: string, library = "craft"): SearchResult => ({
  id, entityKey: `${library}:${id}`, documentId: id, spaceId: library, spaceName: library,
  provider: "craft", libraryId: library, libraryName: library, title: "2026-10-07", journalDate: "2026-10-07", path: "", contentType: "document", sourceType: "craft_page", snippet: "正文", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
});
function page(total = 650, offset = 0, revision = "r1", prefix = "record", limit = 200): JournalPage {
  return { items: Array.from({ length: Math.min(limit, Math.max(0, total - offset)) }, (_, i) => item(`${prefix}-${offset + i}`)), total, days: total ? 12 : 0, libraries: total ? 1 : 0, revision };
}
const offsets = () => invokeMock.mock.calls.map(([, args]) => args.options.offset);
beforeEach(() => {
  invokeMock.mockReset(); invokeMock.mockImplementation(async (_command, args) => page(650, args.options.offset));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe("journal page range", () => {
  it("reads month-grid neighbors for navigation/all-scope and honors explicit day filtering", () => {
    expect(journalRange(view({ layout: "calendar" }))).toEqual({ from: "2026-09-27", to: "2026-10-31" });
    expect(journalRange(view({ layout: "calendar", period: "day", day: "2026-10-07" }))).toEqual({ from: "2026-10-07", to: "2026-10-07" });
    expect(journalRange(view({ layout: "calendar", period: "all" }))).toEqual({ from: "2026-09-27", to: "2026-10-31" });
    expect(journalRange(view({ layout: "stream" }))).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(journalRange(view({ layout: "table", period: "day", day: "2024-02-29" }))).toEqual({ from: "2024-02-29", to: "2024-02-29" });
    expect(journalRange(view({ layout: "list", period: "all" }))).toEqual({ from: null, to: null });
  });
});

describe("snapshot-aware journal pagination", () => {
  it.each(["calendar", "stream"] as const)("automatically completes %s beyond 500 records with full statistics", async layout => {
    await render({ view: { layout } });
    expect(offsets()).toEqual([0, 200, 400, 600]); expect(state.items).toHaveLength(650);
    expect(state.items[state.items.length - 1]?.id).toBe("record-649"); expect(state.total).toBe(650); expect(state.days).toBe(12); expect(state.loading).toBe(false); expect(state.error).toBe("");
  });
  it.each(["list", "table"] as const)("loads %s incrementally without rereading completed pages", async layout => {
    await render({ view: { layout, period: "all" } }); expect(state.items).toHaveLength(200); expect(state.total).toBe(650);
    await act(async () => state.loadMore()); expect(state.items).toHaveLength(400);
    await act(async () => { state.loadMore(); state.loadMore(); }); expect(state.items).toHaveLength(650);
    expect(offsets()).toEqual([0, 200, 400, 600]);
    await act(async () => state.loadMore()); expect(offsets()).toEqual([0, 200, 400, 600]);
  });
  it("completes previously loaded list records when switching to the equivalent day stream", async () => {
    await render({ view: { layout: "list" } }); await render({ view: { layout: "stream" } });
    expect(offsets()).toEqual([0, 200, 400, 600]); expect(state.items).toHaveLength(650);
    await render({ view: { layout: "list" } }); expect(state.items).toHaveLength(650); expect(invokeMock).toHaveBeenCalledTimes(4);
  });
  it("keeps equivalent scope memberships and display-only changes stable", async () => {
    const selected = ["b", "a"];
    await render({ view: { layout: "list", libraries: ["a", "b"] }, scope: selected });
    const previous = state, retry = state.retry, loadMore = state.loadMore;
    await render({ view: { layout: "table", libraries: ["b", "a", "a"], summary: false, source: false }, scope: ["a", "b", "a"] });
    expect(invokeMock).toHaveBeenCalledTimes(1); expect(selected).toEqual(["b", "a"]); expect(state).toBe(previous); expect(state.retry).toBe(retry); expect(state.loadMore).toBe(loadMore);
    expect(invokeMock.mock.calls[0][1].spaceIds).toEqual(["a", "b"]);
  });
  it("applies the saved library filter as an intersection including explicit empty scope", async () => {
    invokeMock.mockResolvedValue(page(0));
    await render({ scope: ["c", "b", "a"], view: { libraries: ["b", "d"] } }); expect(invokeMock.mock.calls[0][1].spaceIds).toEqual(["b"]);
    await render({ scope: ["a"], view: { libraries: ["b"] } }); expect(invokeMock.mock.calls[1][1].spaceIds).toEqual([]); expect(state.items).toEqual([]);
  });
  it("does not mix cached manual pages with a new native revision when appending", async () => {
    await render({ view: { layout: "list" } });
    invokeMock.mockImplementation(async (_command, args) => page(450, args.options.offset, "r2", "fresh"));
    await act(async () => state.loadMore());
    expect(offsets()).toEqual([0, 200, 0, 200]); expect(state.items).toHaveLength(400); expect(state.total).toBe(450); expect(state.revision).toBe("r2");
    expect(state.items.every(record => record.id.startsWith("fresh"))).toBe(true);
  });
  it("restarts the whole snapshot when automatic pages change revisions", async () => {
    invokeMock.mockImplementationOnce(async () => page(650, 0, "old", "old"));
    invokeMock.mockImplementation(async (_command, args) => page(450, args.options.offset, "new", "new"));
    await render(); expect(offsets()).toEqual([0, 200, 0, 200, 400]); expect(state.items).toHaveLength(450);
    expect(state.items.every(record => record.id.startsWith("new"))).toBe(true);
  });
  it("stops repeated revision churn without publishing a partial mixed snapshot", async () => {
    let revision = 0; invokeMock.mockImplementation(async (_command, args) => page(650, args.options.offset, `revision-${revision++}`));
    await render(); expect(offsets()).toEqual([0, 200, 0, 200, 0, 200]);
    expect(state.items).toEqual([]); expect(state.loading).toBe(false); expect(state.error).toContain("正在更新");
  });
  it("ignores responses and failures from canceled scopes", async () => {
    let finishOld!: (value: JournalPage) => void, failOlder!: (reason: Error) => void;
    invokeMock.mockImplementation((_command, args) => args.spaceIds[0] === "old" ? new Promise(resolve => { finishOld = resolve; }) : args.spaceIds[0] === "older" ? new Promise((_resolve, reject) => { failOlder = reject; }) : Promise.resolve(page(1, 0, "new", "new")));
    await render({ scope: ["old"] }); await render({ scope: ["older"] }); await render({ scope: ["new"] });
    await act(async () => { finishOld(page(9, 0, "old", "old")); failOlder(new Error("late failure")); });
    expect(state.items[0].id).toBe("new-0"); expect(state.total).toBe(1); expect(state.loading).toBe(false); expect(state.error).toBe("");
  });
  it("clears loading on disable and rejects an outstanding request", async () => {
    let finish!: (value: JournalPage) => void;
    invokeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); expect(state.loading).toBe(true); await render({ enabled: false });
    await act(async () => finish(page(9))); expect(state.items).toEqual([]); expect(state.loading).toBe(false); expect(state.error).toBe("");
    invokeMock.mockResolvedValue(page(1)); await render(); expect(state.items).toHaveLength(1);
  });
  it("keeps the last completed content during a read and restores cached state after canceling that read", async () => {
    invokeMock.mockResolvedValue(page(1)); await render({ view: { layout: "list", query: "A" } });
    const oldItems = state.items;
    let finish!: (value: JournalPage) => void; invokeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render({ view: { layout: "list", query: "B" } }); expect(state.items).toBe(oldItems); expect(state.loading).toBe(true);
    await render({ view: { layout: "list", query: "A" } }); expect(state.items).toBe(oldItems); expect(state.loading).toBe(false);
    await act(async () => finish(page(3))); expect(state.items).toHaveLength(1); expect(state.loading).toBe(false);
  });
  it("shows failed reads, retries explicitly, and restarts the requested number of pages", async () => {
    invokeMock.mockRejectedValueOnce(new Error("读取失败"));
    await render({ view: { layout: "list" } }); expect(state.error).toBe("读取失败"); expect(state.loading).toBe(false);
    await act(async () => state.retry()); expect(state.items).toHaveLength(200); expect(state.error).toBe("");
    await act(async () => state.loadMore()); expect(state.items).toHaveLength(400);
    await act(async () => state.retry()); expect(offsets()).toEqual([0, 0, 200, 0, 200]); expect(state.items).toHaveLength(400);
  });
  it("refreshes on committed revision while equivalent trimmed searches remain stable", async () => {
    invokeMock.mockResolvedValue(page(1));
    await render({ view: { query: "term" } }); await render({ view: { query: " term " } }); expect(invokeMock).toHaveBeenCalledTimes(1);
    await render({ view: { query: "term" }, revision: "2" }); expect(invokeMock).toHaveBeenCalledTimes(2);
  });
  it.each(["empty", "invalid", "duplicate", "statistics"] as const)("reports %s native response instead of silently dropping records", async failure => {
    if (failure === "empty") invokeMock.mockResolvedValue({ ...page(1), items: [] });
    if (failure === "invalid") invokeMock.mockResolvedValue({ ...page(1), items: [{ id: "bad" }] });
    if (failure === "duplicate") invokeMock.mockResolvedValue({ ...page(2), items: [item("same"), item("same")] });
    if (failure === "statistics") invokeMock.mockImplementationOnce(async () => page()).mockResolvedValue({ ...page(650, 200), days: 13 });
    await render(); expect(state.error).not.toBe(""); expect(state.loading).toBe(false); expect(state.items).toEqual([]);
  });
  it("keeps identical source document IDs in different libraries as separate records", async () => {
    invokeMock.mockResolvedValue({ ...page(2), items: [item("same", "a"), item("same", "b")], libraries: 2 });
    await render(); expect(state.items).toHaveLength(2); expect(state.error).toBe(""); expect(state.libraries).toBe(2);
  });
});
