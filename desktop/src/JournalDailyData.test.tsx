// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { groupJournalDailyTasks, journalLocalDateKey, journalTaskTimestampDate, useJournalDailyData, validJournalDailyRange, type JournalDailyOptions } from "./JournalDailyData";

const shared = vi.hoisted(() => ({ hook: vi.fn(), refresh: vi.fn(), setTaskCompleted: vi.fn(), invoke: vi.fn() }));
vi.mock("./UnifiedTaskData", () => ({ useUnifiedTasks: shared.hook, canSetUnifiedTaskStatus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: shared.invoke }));
const task = (id = "craft:one:block", patch: Partial<UnifiedTask> = {}): UnifiedTask => ({
  id, provider: "craft", libraryId: "one", libraryName: "工作", sourceId: "block", parentTaskId: "", parentPageId: "", documentId: "document", documentTitle: "工程", title: "任务", completed: false, status: "open", isAllDay: true, dueAt: "2026-10-13", path: "", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked", ...patch,
});
const base: JournalDailyOptions = { from: "2026-10-13", to: "2026-10-16", scope: null, query: "", enabled: true };
const localInstant = (day = 13, hour = 12) => new Date(2026, 9, day, hour).toISOString();
let host: HTMLDivElement, root: Root, state: ReturnType<typeof useJournalDailyData>;
let snapshot: { dashboard: { tasks: UnifiedTask[] }; loading: boolean; error: string; taskBusyIds: Set<string>; refresh: typeof shared.refresh; setTaskCompleted: typeof shared.setTaskCompleted };
function Harness(props: Partial<JournalDailyOptions>) { state = useJournalDailyData({ ...base, ...props }); return null; }
const render = async (props: Partial<JournalDailyOptions> = {}) => { await act(async () => root.render(<Harness {...props} />)); };
beforeEach(() => {
  shared.hook.mockReset(); shared.refresh.mockReset(); shared.setTaskCompleted.mockReset(); shared.invoke.mockReset();
  snapshot = { dashboard: { tasks: [task()] }, loading: false, error: "", taskBusyIds: new Set(), refresh: shared.refresh, setTaskCompleted: shared.setTaskCompleted };
  shared.hook.mockImplementation(() => snapshot);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("validates civil ranges without inventing missing dates", () => {
  expect(validJournalDailyRange(base.from, base.to)).toBe(true);
  expect(validJournalDailyRange("2026-02-30", base.to)).toBe(false);
  expect(validJournalDailyRange(base.from, base.from)).toBe(false);
  expect(validJournalDailyRange("2028-02-29", "2028-03-01")).toBe(true);
  expect(validJournalDailyRange("0000-01-01", "0001-01-01")).toBe(false);
  expect(journalTaskTimestampDate("2026-02-30T12:00:00Z")).toBe("");
  expect(journalTaskTimestampDate("invalid")).toBe("");
});
it("preserves all-day schedules while placing actual times on the local day", () => {
  const instant = "2026-10-14T01:00:00+1400";
  expect(journalTaskTimestampDate(instant, true)).toBe("2026-10-14");
  expect(journalTaskTimestampDate(instant)).toBe(journalLocalDateKey(new Date(instant)));
  expect(journalTaskTimestampDate("2026-10-13")).toBe("2026-10-13");
});
it("decodes all-day UTC timestamps in the provider timezone without shifting civil dates", () => {
  const utcMidnight = "2026-10-12T16:00:00Z";
  expect(journalTaskTimestampDate(utcMidnight, true, "Asia/Shanghai")).toBe("2026-10-13");
  expect(journalTaskTimestampDate("2026-10-13T00:00:00+0800", true, "Asia/Shanghai")).toBe("2026-10-13");
  expect(journalTaskTimestampDate("2026-10-13", true, "America/Los_Angeles")).toBe("2026-10-13");
  expect(journalTaskTimestampDate(utcMidnight, true, "invalid/timezone")).toBe("2026-10-12");
  expect(journalTaskTimestampDate(utcMidnight, false, "Asia/Shanghai")).toBe(journalLocalDateKey(new Date(utcMidnight)));
  const groups = groupJournalDailyTasks([task("dida-midnight", { provider: "dida365", timeZone: "Asia/Shanghai", dueAt: utcMidnight })], base);
  expect(groups.get(base.from)?.scheduled.map(entry => entry.task.id)).toEqual(["dida-midnight"]);
});
it("includes every day of an open start–end interval with inclusive boundaries", () => {
  const groups = groupJournalDailyTasks([task("spanning", { startAt: "2026-10-12", dueAt: "2026-10-15", reminderAt: [localInstant(13)], createdAt: localInstant(13) })], base);
  expect([...groups.keys()].sort()).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
  expect(groups.get(base.from)?.scheduled[0].reasons).toEqual(["进行中", "提醒", "新建"]);
  expect(groups.get("2026-10-14")?.scheduled[0].reasons).toEqual(["进行中"]);
  expect(groups.get("2026-10-15")?.scheduled[0].reasons).toEqual(["截止"]);
  expect(groups.get(base.from)?.created).toEqual([]);
  const endpoints = groupJournalDailyTasks([task("endpoints", { startAt: base.from, dueAt: "2026-10-15" })], base);
  expect(endpoints.get(base.from)?.scheduled[0].reasons).toEqual(["开始"]);
  expect(endpoints.get("2026-10-15")?.scheduled).toHaveLength(1);
});
it("uses a real scheduled start and clips long or timed intervals to the visible range", () => {
  const groups = groupJournalDailyTasks([
    task("long", { scheduledAt: "2020-01-01", dueAt: "2030-01-01" }),
    task("timed-range", { isAllDay: false, startAt: localInstant(12, 23), dueAt: localInstant(14, 1) }),
  ], base);
  expect([...groups.keys()].sort()).toEqual(["2026-10-13", "2026-10-14", "2026-10-15"]);
  expect(groups.get(base.from)?.scheduled.map(entry => entry.task.id).sort()).toEqual(["long", "timed-range"]);
  expect(groups.get("2026-10-15")?.scheduled.map(entry => entry.task.id)).toEqual(["long"]);
  expect(groups.get(base.from)?.scheduled.find(entry => entry.task.id === "timed-range")?.reasons).toEqual(["进行中"]);
});
it("does not invent intervals for undated, reversed, expired, abandoned or already completed tasks", () => {
  const groups = groupJournalDailyTasks([
    task("only-start", { startAt: "2026-10-12", dueAt: undefined }),
    task("only-deadline", { dueAt: "2026-10-15" }),
    task("reversed", { startAt: "2026-10-17", dueAt: "2026-10-12" }),
    task("expired", { startAt: "2026-10-10", dueAt: "2026-10-12" }),
    task("done-earlier", { startAt: "2026-10-12", dueAt: "2026-10-17", completed: true, status: "completed", completedAt: localInstant(12) }),
    task("abandoned", { startAt: "2026-10-12", dueAt: "2026-10-17", status: "abandoned" }),
  ], base);
  expect([...groups.keys()]).toEqual(["2026-10-15"]);
  expect(groups.get("2026-10-15")?.scheduled.map(entry => entry.task.id)).toEqual(["only-deadline"]);
});
it("keeps interval dates civil across a month and includes the task timezone at both boundaries", () => {
  const octoberEnd = { ...base, from: "2026-10-31", to: "2026-11-03" };
  const groups = groupJournalDailyTasks([task("month-range", { provider: "dida365", timeZone: "Asia/Shanghai", startAt: "2026-10-30T16:00:00Z", dueAt: "2026-11-01T16:00:00Z" })], octoberEnd);
  expect([...groups.keys()].sort()).toEqual(["2026-10-31", "2026-11-01", "2026-11-02"]);
  expect(groups.get("2026-10-31")?.scheduled[0].reasons).toEqual(["开始"]);
  expect(groups.get("2026-11-01")?.scheduled[0].reasons).toEqual(["进行中"]);
  expect(groups.get("2026-11-02")?.scheduled[0].reasons).toEqual(["截止"]);
});
it("retains a linked task in either source library without duplicating it on a day", () => {
  const linked = task("linked", { libraryId: "one", linkedLibraryIds: ["one", "dida"], linkedProviders: ["craft", "dida365"], syncState: "linked", collectionName: "生活清单" });
  const fromDida = groupJournalDailyTasks([linked, linked], { ...base, scope: ["dida"], query: "生活清单" });
  expect(fromDida.get(base.from)?.scheduled.map(entry => entry.task.id)).toEqual(["linked"]);
  expect(groupJournalDailyTasks([linked], { ...base, scope: ["one", "dida"] }).get(base.from)?.scheduled).toHaveLength(1);
  expect(groupJournalDailyTasks([linked], { ...base, scope: ["other"] }).size).toBe(0);
});
it("includes the union of plan, start, deadline and reminder days", () => {
  const groups = groupJournalDailyTasks([task("union", { scheduledAt: "2026-10-13", startAt: "2026-10-13", dueAt: "2026-10-14", reminderAt: [localInstant(13), localInstant(13, 16), localInstant(15)] })], base);
  expect(groups.get("2026-10-13")?.scheduled[0].reasons).toEqual(["计划", "提醒"]);
  expect(groups.get("2026-10-14")?.scheduled[0].reasons).toEqual(["截止"]);
  expect(groups.get("2026-10-15")?.scheduled[0].reasons).toEqual(["提醒"]);
  expect(groups.get("2026-10-13")?.scheduled).toHaveLength(1);
});
it("uses reminder instants even when the task is all-day", () => {
  const reminder = "2026-10-14T01:00:00+1400", date = journalLocalDateKey(new Date(reminder));
  const groups = groupJournalDailyTasks([task("reminder", { dueAt: undefined, isAllDay: true, reminderAt: [reminder] })], base);
  expect(groups.get(date)?.scheduled[0].reasons).toEqual(["提醒"]);
});
it("suppresses the duplicate compatibility start day but retains a distinct start day", () => {
  const groups = groupJournalDailyTasks([
    task("same", { scheduledAt: "2026-10-13", startAt: "2026-10-13", dueAt: "2026-10-13" }),
    task("different", { scheduledAt: "2026-10-13", startAt: "2026-10-14", dueAt: undefined }),
    task("timed", { isAllDay: false, scheduledAt: localInstant(13, 9), startAt: localInstant(13, 10), dueAt: undefined }),
  ], base);
  expect(groups.get(base.from)?.scheduled.find(entry => entry.task.id === "same")?.reasons).toEqual(["计划", "截止"]);
  expect(groups.get("2026-10-14")?.scheduled[0].reasons).toEqual(["开始"]);
  expect(groups.get(base.from)?.scheduled.find(entry => entry.task.id === "timed")?.reasons).toEqual(["计划", "开始"]);
});
it("keeps a newly created task for next week out of today's scheduled tasks", () => {
  const groups = groupJournalDailyTasks([task("next-week", { createdAt: localInstant(13), dueAt: "2026-10-20" })], base);
  expect(groups.get(base.from)?.scheduled).toEqual([]);
  expect(groups.get(base.from)?.created.map(entry => entry.task.id)).toEqual(["next-week"]);
  expect(groups.get(base.from)?.created[0].reasons).toEqual(["新建"]);
});
it("places completion on the actual completion date regardless of the deadline", () => {
  const groups = groupJournalDailyTasks([task("done-today", { status: "completed", completed: true, completedAt: localInstant(13), completedTimeSource: "source", dueAt: "2026-10-14" })], base);
  expect(groups.get(base.from)?.completed[0]).toEqual(expect.objectContaining({ completedAt: localInstant(13), completedSource: "source", reopened: false }));
  expect(groups.has("2026-10-14")).toBe(false);
});
it("deduplicates within a day with completion then schedule then creation precedence", () => {
  const groups = groupJournalDailyTasks([
    task("complete", { status: "completed", completed: true, completedAt: localInstant(13), createdAt: localInstant(13) }),
    task("schedule", { createdAt: localInstant(13) }),
    task("new", { dueAt: undefined, createdAt: localInstant(13) }),
  ], base).get(base.from)!;
  expect(groups.completed.map(entry => entry.task.id)).toEqual(["complete"]);
  expect(groups.scheduled.map(entry => entry.task.id)).toEqual(["schedule"]);
  expect(groups.created.map(entry => entry.task.id)).toEqual(["new"]);
  expect(groups.completed[0].reasons).toEqual(["截止", "新建"]);
  expect(groups.scheduled[0].reasons).toEqual(["截止", "新建"]);
});
it("removes reopened tasks from completed while retaining their history and schedule", () => {
  const reopened = task("reopened", { completionHistory: [{ at: localInstant(13, 9), source: "hub", reopened: true }], dueAt: "2026-10-14" });
  const groups = groupJournalDailyTasks([reopened], base);
  expect(groups.has(base.from)).toBe(false);
  expect(groups.get("2026-10-14")?.scheduled[0].task.status).toBe("open");
  expect(groups.get("2026-10-14")?.scheduled[0].task.completionHistory).toEqual(reopened.completionHistory);
  const sameDay = groupJournalDailyTasks([{ ...reopened, dueAt: base.from, completedAt: localInstant(13, 9) }], base).get(base.from)!;
  expect(sameDay.completed).toEqual([]);
  expect(sameDay.scheduled.map(entry => entry.task.id)).toEqual([reopened.id]);
});
it("chooses the latest real completion cycle on a day and retains other completion days", () => {
  const groups = groupJournalDailyTasks([task("cycles", { status: "completed", completed: true, completedAt: localInstant(14, 17), completedTimeSource: "source", completionHistory: [
    { at: localInstant(13, 8), source: "hub", reopened: true },
    { at: localInstant(14, 8), source: "hub", reopened: true },
    { at: localInstant(14, 17), source: "hub", reopened: false },
  ] })], base);
  expect(groups.get(base.from)?.completed).toHaveLength(1);
  expect(groups.get("2026-10-14")?.completed).toHaveLength(1);
  expect(groups.get("2026-10-14")?.completed[0]).toEqual(expect.objectContaining({ completedAt: localInstant(14, 17), completedSource: "source", reopened: false }));
});
it("prefers a precise completion over a source day without time and favors source on exact ties", () => {
  const precise = localInstant(13, 1);
  const groups = groupJournalDailyTasks([
    task("precise", { status: "completed", completed: true, completedAt: base.from, completedTimeSource: "source", completionHistory: [{ at: precise, source: "hub", reopened: false }] }),
    task("tie", { status: "completed", completed: true, completionHistory: [{ at: precise, source: "source", reopened: false }, { at: precise, source: "hub", reopened: false }] }),
  ], base).get(base.from)!;
  expect(groups.completed.find(entry => entry.task.id === "precise")).toEqual(expect.objectContaining({ completedAt: precise, completedSource: "hub" }));
  expect(groups.completed.find(entry => entry.task.id === "tie")?.completedSource).toBe("source");
});
it("preserves completion history after abandonment without adding schedule or creation rows", () => {
  const groups = groupJournalDailyTasks([task("abandoned-later", { status: "abandoned", completed: false, dueAt: "2026-10-14", createdAt: localInstant(15), completionHistory: [{ at: localInstant(13), source: "hub", reopened: false }] })], base);
  expect(groups.get(base.from)?.completed.map(entry => entry.task.id)).toEqual(["abandoned-later"]);
  expect(groups.has("2026-10-14")).toBe(false); expect(groups.has("2026-10-15")).toBe(false);
});
it("does not infer creation or completion from modified dates or completed status", () => {
  const groups = groupJournalDailyTasks([
    task("done-unknown", { status: "completed", completed: true, modifiedAt: new Date(2026, 9, 13).getTime() / 1000 }),
    task("modified-only", { dueAt: undefined, modifiedAt: new Date(2026, 9, 13).getTime() / 1000 }),
  ], base);
  expect(groups.size).toBe(0);
});
it("filters real source libraries, query and range and excludes duplicate/project/abandoned rows", () => {
  const tasks = [task(), task(), task("other", { libraryId: "two" }), task("project", { isProject: true }), task("abandoned", { status: "abandoned" }), task("end", { dueAt: base.to, createdAt: localInstant(16), completedAt: localInstant(16) })];
  expect(groupJournalDailyTasks(tasks, { ...base, scope: ["one"] }).get(base.from)?.scheduled.map(entry => entry.task.id)).toEqual([task().id]);
  expect(groupJournalDailyTasks(tasks, { ...base, scope: [] }).size).toBe(0);
  expect(groupJournalDailyTasks(tasks, { ...base, query: "工程" }).get(base.from)?.scheduled).toHaveLength(2);
  expect(groupJournalDailyTasks(tasks, { ...base, query: "无匹配" }).size).toBe(0);
});
it("reads the shared snapshot and never invokes separate task or reading queries", async () => {
  await render();
  expect(state.tasksByDate.get(base.from)?.scheduled).toHaveLength(1);
  await render({ from: "2026-10-14", to: "2026-10-20", scope: ["one"], query: "工程" });
  expect(state.tasksByDate.size).toBe(0);
  expect(shared.hook).toHaveBeenLastCalledWith({ enabled: true });
  expect(shared.invoke).not.toHaveBeenCalled();
  expect(state).not.toHaveProperty("readingByDate");
});
it("passes shared loading, errors, mutation and refresh without independent state", async () => {
  snapshot = { ...snapshot, loading: true, error: "任务读取失败", taskBusyIds: new Set([task().id]) };
  await render({ dataVersion: "sync-2" });
  expect(state.tasksLoading).toBe(true); expect(state.tasksError).toBe("任务读取失败");
  expect(state.taskBusyIds).toBe(snapshot.taskBusyIds);
  expect(state.setTaskCompleted).toBe(shared.setTaskCompleted);
  expect(state.retry).toBe(shared.refresh);
  expect(shared.hook).toHaveBeenLastCalledWith({ enabled: true });
  act(() => state.retry()); expect(shared.refresh).toHaveBeenCalledOnce();
});
it("derives new groups when the shared task snapshot changes", async () => {
  await render();
  snapshot = { ...snapshot, dashboard: { tasks: [task(task().id, { completed: true, status: "completed", completedAt: localInstant(13), completedTimeSource: "hub" })] } };
  await render();
  expect(state.tasksByDate.get(base.from)?.scheduled).toEqual([]);
  expect(state.tasksByDate.get(base.from)?.completed[0].completedSource).toBe("hub");
});
it("disables the shared subscription for disabled, empty-scope and invalid ranges", async () => {
  await render({ enabled: false }); expect(state.tasksByDate.size).toBe(0); expect(shared.hook).toHaveBeenLastCalledWith({ enabled: false });
  await render({ scope: [] }); expect(state.tasksByDate.size).toBe(0); expect(state.tasksError).toBe("");
  await render({ from: "2026-02-30" }); expect(state.tasksError).toBe("日期范围无效"); expect(state.tasksLoading).toBe(false);
  expect(shared.invoke).not.toHaveBeenCalled();
});
