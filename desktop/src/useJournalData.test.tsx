// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SearchResult } from "./SearchTypes";
import { journalDataVersion, useJournalData } from "./useJournalData";
import type { IndexStatus } from "./IndexStatusTypes";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const normalize = (value: unknown) => value as SearchResult[];
let host: HTMLDivElement;
let root: Root;
let state: ReturnType<typeof useJournalData>;
type JournalStatus = Pick<IndexStatus, "journalVersions"> & Partial<Omit<IndexStatus, "journalVersions">>;
function Harness({ enabled = true, active = false, selectedDate = "", spaceIds = null, status }: {
  enabled?: boolean; active?: boolean; selectedDate?: string; spaceIds?: string[] | null; status?: JournalStatus;
}) {
  state = useJournalData({ enabled, active, selectedDate, spaceIds, dataVersion: journalDataVersion(status, spaceIds), normalize });
  return null;
}
const summary = (count = 1, date = "2026-10-11") => ({ count, dates: [{ date, sources: 1 }] });
const view = (id = "current", count = 1, date = "2026-10-11") => ({ summary: summary(count, date), items: [{ id, title: date }] });
const status = (craftRevision: string, obsidianRevision: string): JournalStatus => ({
  documentCount: 1003, lastSync: "2026-10-11T12:00:00",
  journalVersions: [
    { libraryId: "craft", revision: craftRevision, name: "Craft", provider: "craft" },
    { libraryId: "obsidian", revision: obsidianRevision, name: "Obsidian", provider: "obsidian" },
  ],
});
const calls = (command: string) => invokeMock.mock.calls.filter(([name]) => name === command).length;
const render = async (props: Parameters<typeof Harness>[0] = {}) => { await act(async () => root.render(<Harness {...props} />)); };
const advance = async (milliseconds: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); }); };
beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async command => command === "journal_summary" ? summary() : view());
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.useRealTimers();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("reads navigation metadata once and only loads a page when journals become active", async () => {
  await render(); await render({ selectedDate: "2024-03-02" });
  expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["journal_summary"]);
  await render({ active: true, selectedDate: "2024-03-02" });
  expect(invokeMock).toHaveBeenLastCalledWith("journal_view", { spaceIds: null, limit: 500, dateKey: "2024-03-02" });
  expect(state.summary.count).toBe(1); expect(state.results[0].id).toBe("current");
  await render(); expect(calls("journal_summary")).toBe(2); expect(calls("journal_view")).toBe(1);
});
it("publishes summary and page together from one native view response", async () => {
  let resolve!: (value: unknown) => void;
  invokeMock.mockImplementation(() => new Promise(done => { resolve = done; }));
  await render({ active: true });
  expect(state.summary.count).toBe(0); expect(state.results).toEqual([]); expect(state.loading).toBe(true);
  await act(async () => resolve(view("same-generation", 9, "2026-10-12")));
  expect(state.summary).toEqual(summary(9, "2026-10-12"));
  expect(state.results).toEqual(view("same-generation", 9, "2026-10-12").items);
  expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["journal_view"]);
});
it("rejects an old library response after switching the current journal scope", async () => {
  const pending = new Map<string, (value: unknown) => void>();
  invokeMock.mockImplementation((_command, args) => new Promise(resolve => pending.set(args.spaceIds[0], resolve)));
  await render({ active: true, spaceIds: ["first"] }); await render({ active: true, spaceIds: ["second"] });
  await act(async () => pending.get("second")!(view("new", 2)));
  await act(async () => pending.get("first")!(view("old", 9)));
  expect(state.results[0].id).toBe("new"); expect(state.summary.count).toBe(2); expect(state.loading).toBe(false);
});
it("refreshes same-count same-second journal edits through committed data revisions", async () => {
  await render({ active: true, status: status("10", "20") });
  const reordered = status("10", "20"); reordered.journalVersions.reverse();
  await render({ active: true, status: reordered }); expect(invokeMock).toHaveBeenCalledTimes(1);
  invokeMock.mockResolvedValue(view("new-date", 1, "2026-10-12"));
  await render({ active: true, status: status("11", "20") });
  expect(state.summary.dates[0].date).toBe("2026-10-12"); expect(state.results[0].id).toBe("new-date");
  await render({ active: true, status: status("11", "21") }); expect(invokeMock).toHaveBeenCalledTimes(3);
});
it("refreshes inactive journal metadata after a data revision without reading bodies", async () => {
  await render({ status: status("10", "20") }); await render({ status: status("10", "21") });
  expect(invokeMock.mock.calls.map(call => call[0])).toEqual(["journal_summary", "journal_summary"]); expect(state.results).toEqual([]);
});

// Retain the original scope/watcher regression identities. Completed-sync
// clocks now accompany authoritative committed revisions; clock-only changes
// are no longer journal invalidation. Same-second revision tests above also
// cover completed edits whose timestamp does not change.
it("refreshes inactive journal metadata after a watcher sync without reading bodies", async () => {
  const initial = status("10", "20");
  initial.obsidianWatchers = [{ libraryId: "obsidian", watching: true, pendingPaths: 1, lastSuccessAt: 100 }];
  await render({ status: initial });
  const pending = status("10", "20");
  pending.obsidianWatchers = [{ libraryId: "obsidian", watching: true, pendingPaths: 0, lastSuccessAt: 101 }];
  await render({ status: pending });
  expect(calls("journal_summary")).toBe(1);
  invokeMock.mockResolvedValue(summary(1, "2026-10-12"));
  const completed = status("10", "21");
  completed.obsidianWatchers = pending.obsidianWatchers;
  await render({ status: completed });
  expect(calls("journal_summary")).toBe(2);
  expect(calls("journal_view")).toBe(0);
  expect(state.summary).toEqual(summary(1, "2026-10-12"));
  expect(state.results).toEqual([]);
});

it("ignores completed sync changes outside the selected journal scope", async () => {
  await render({ active: true, spaceIds: ["obsidian"], status: status("10", "20") });
  const outside = status("11", "20"); outside.lastSync = "2026-10-11T12:00:01";
  await render({ active: true, spaceIds: ["obsidian"], status: outside });
  expect(calls("journal_view")).toBe(1);
  invokeMock.mockResolvedValue(view("selected-new", 1, "2026-10-12"));
  const selected = status("11", "21"); selected.lastSync = outside.lastSync;
  selected.obsidianWatchers = [{ libraryId: "obsidian", watching: true, pendingPaths: 0, lastSuccessAt: 101 }];
  await render({ active: true, spaceIds: ["obsidian"], status: selected });
  expect(calls("journal_view")).toBe(2);
  expect(state.results[0].id).toBe("selected-new");
  expect(calls("journal_summary")).toBe(0);
});

it("refreshes same-count journal metadata and the active page only when completed sync timestamps change", async () => {
  await render({ active: true, status: status("10", "20") });
  const polling = status("10", "20"); polling.pendingJobs = 2;
  await render({ active: true, status: polling });
  expect(calls("journal_view")).toBe(1);
  invokeMock.mockResolvedValue(view("completed-edit", 1, "2026-10-12"));
  const committed = status("11", "20"); committed.lastSync = "2026-10-11T12:00:01";
  await render({ active: true, status: committed });
  expect(calls("journal_view")).toBe(2);
  expect(state.summary).toEqual(summary(1, "2026-10-12"));
  expect(state.results[0].id).toBe("completed-edit");
  const clockOnly = status("11", "20"); clockOnly.lastSync = "2026-10-11T12:00:02";
  await render({ active: true, status: clockOnly });
  expect(calls("journal_view")).toBe(2);
  expect(calls("journal_summary")).toBe(0);
});
it("ignores data revisions outside the selected journal scope", async () => {
  await render({ active: true, spaceIds: ["obsidian"], status: status("10", "20") });
  await render({ active: true, spaceIds: ["obsidian"], status: status("11", "20") }); expect(invokeMock).toHaveBeenCalledTimes(1);
  await render({ active: true, spaceIds: ["obsidian"], status: status("11", "21") }); expect(invokeMock).toHaveBeenCalledTimes(2);
});
it("keeps equivalent reordered scope arrays stable without mutating the caller's selection", async () => {
  const selected = ["obsidian", "craft"];
  await render({ active: true, spaceIds: selected, status: status("10", "20") });
  await render({ active: true, spaceIds: ["craft", "obsidian", "craft"], status: status("10", "20") });
  expect(selected).toEqual(["obsidian", "craft"]); expect(invokeMock).toHaveBeenCalledTimes(1);
});
it("clears stale scope data when disabled and rejects an old completed read", async () => {
  await render({ active: true, status: status("10", "20") });
  let finish!: (value: unknown) => void;
  invokeMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render({ active: true, status: status("11", "21") }); await render({ enabled: false, active: true, status: status("11", "21") });
  await act(async () => finish(view("obsolete", 9)));
  expect(state.summary).toEqual({ count: 0, dates: [] }); expect(state.results).toEqual([]); expect(state.loading).toBe(false);
});
it("ignores count, sync clocks and polling status changes when journal inputs are unchanged", async () => {
  await render({ active: true, status: status("10", "20") });
  const next = status("10", "20"); next.documentCount = 1500; next.lastSync = "2026-10-11T12:00:01"; next.pendingJobs = 2;
  next.obsidianWatchers = [{ libraryId: "obsidian", watching: true, pendingPaths: 4, lastSuccessAt: 999 }];
  await render({ active: true, status: next }); expect(invokeMock).toHaveBeenCalledTimes(1);
});
it("refreshes metadata and the active page when visible library membership changes", async () => {
  const first = status("10", "20"); first.journalVersions = first.journalVersions.slice(0, 1);
  await render({ active: true, status: first }); await render({ active: true, status: status("10", "20") });
  const removed = status("10", "20"); removed.journalVersions = removed.journalVersions.slice(1);
  await render({ active: true, status: removed }); expect(invokeMock).toHaveBeenCalledTimes(3);
});
it.each(["name", "provider"] as const)("refreshes a selected library's %s projection without relying on a new revision", async field => {
  await render({ active: true, spaceIds: ["craft"], status: status("10", "20") });
  const outside = status("10", "20"); outside.journalVersions[1][field] = field === "provider" ? "craft" : "outside";
  await render({ active: true, spaceIds: ["craft"], status: outside }); expect(invokeMock).toHaveBeenCalledTimes(1);
  const selected = status("10", "20"); selected.journalVersions[0][field] = field === "provider" ? "obsidian" : "renamed";
  await render({ active: true, spaceIds: ["craft"], status: selected }); expect(invokeMock).toHaveBeenCalledTimes(2);
});
it("ignores libraries outside journal providers and invalidates a supported provider transition", async () => {
  await render({ active: true, status: status("10", "20") });
  const outside = status("10", "20"); outside.journalVersions.push({ libraryId: "tasks", revision: "30", name: "Tasks", provider: "dida365" });
  await render({ active: true, status: outside }); expect(invokeMock).toHaveBeenCalledTimes(1);
  outside.journalVersions[0].provider = "dida365";
  await render({ active: true, status: outside }); expect(invokeMock).toHaveBeenCalledTimes(2);
});
it("retries failed initial reads at 1, 3 and 10 seconds and then stops", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValue(new Error("busy")); await render({ active: true });
  for (const [index, delay] of [1_000, 3_000, 10_000].entries()) {
    await advance(delay - 1); expect(calls("journal_view")).toBe(index + 1);
    await advance(1); expect(calls("journal_view")).toBe(index + 2);
  }
  await advance(60_000); expect(invokeMock).toHaveBeenCalledTimes(4); expect(state.loading).toBe(false);
  expect(state.summary).toEqual({ count: 0, dates: [] }); expect(state.results).toEqual([]);
});
it("recovers a transient view failure without publishing mismatched metadata and stops its timer", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValueOnce(new Error("busy")).mockResolvedValue(view("recovered", 2));
  await render({ active: true }); expect(state.summary.count).toBe(0); expect(state.loading).toBe(true);
  await advance(1_000); expect(state.summary.count).toBe(2); expect(state.results[0].id).toBe("recovered");
  await advance(60_000); expect(calls("journal_view")).toBe(2); expect(calls("journal_summary")).toBe(0); expect(state.loading).toBe(false);
});
it("recovers inactive navigation metadata without reading journal bodies", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValueOnce(new Error("busy")).mockResolvedValue(summary(3));
  await render(); await advance(1_000); await advance(60_000);
  expect(state.summary.count).toBe(3); expect(calls("journal_summary")).toBe(2); expect(calls("journal_view")).toBe(0);
});
it("cancels all scheduled retries on disable and starts a fresh read when enabled again", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValue(new Error("busy")); await render({ active: true });
  await render({ enabled: false, active: true }); await advance(60_000); expect(invokeMock).toHaveBeenCalledTimes(1);
  invokeMock.mockResolvedValue(view("fresh")); await render({ active: true });
  expect(invokeMock).toHaveBeenCalledTimes(2); expect(state.results[0].id).toBe("fresh");
});
it("cancels an active view retry when journals become inactive and returns to metadata reads", async () => {
  vi.useFakeTimers(); invokeMock.mockImplementation(async command => { if (command === "journal_summary") return summary(); throw new Error("busy"); });
  await render({ active: true }); await render(); await advance(60_000);
  expect(calls("journal_summary")).toBe(1); expect(calls("journal_view")).toBe(1); expect(state.loading).toBe(false); expect(state.results).toEqual([]);
});
it("cancels an old date retry before reading the newly selected journal page", async () => {
  vi.useFakeTimers(); invokeMock.mockImplementation(async (_command, args) => { if (args.dateKey === "2026-10-10") throw new Error("busy"); return view(args.dateKey); });
  await render({ active: true, selectedDate: "2026-10-10" }); await render({ active: true, selectedDate: "2026-10-11" }); await advance(60_000);
  expect(calls("journal_view")).toBe(2); expect(calls("journal_summary")).toBe(0); expect(state.results[0].id).toBe("2026-10-11");
});
it("cancels an obsolete version's retry when a newer version succeeds", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValue(new Error("busy")); await render({ active: true, status: status("10", "20") });
  invokeMock.mockResolvedValue(view("current", 2)); await render({ active: true, status: status("11", "20") }); await advance(60_000);
  expect(invokeMock).toHaveBeenCalledTimes(2); expect(state.summary.count).toBe(2); expect(state.results[0].id).toBe("current");
});
it("does not schedule retries for late failures from an obsolete scope", async () => {
  vi.useFakeTimers(); let rejectOld!: (reason: Error) => void;
  invokeMock.mockImplementation((_command, args) => args.spaceIds[0] === "old" ? new Promise((_resolve, reject) => { rejectOld = reject; }) : Promise.resolve(view()));
  await render({ active: true, spaceIds: ["old"] }); await render({ active: true, spaceIds: ["new"] });
  await act(async () => rejectOld(new Error("late failure"))); await advance(60_000);
  expect(invokeMock).toHaveBeenCalledTimes(2); expect(state.results[0].id).toBe("current"); expect(state.summary.count).toBe(1);
});
it("cancels pending retries when the journal owner unmounts", async () => {
  vi.useFakeTimers(); invokeMock.mockRejectedValue(new Error("busy")); await render({ active: true });
  await act(async () => root.render(null)); await advance(60_000); expect(invokeMock).toHaveBeenCalledTimes(1);
});
