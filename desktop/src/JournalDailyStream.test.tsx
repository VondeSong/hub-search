// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { JournalDailyStream, journalDailyDates } from "./JournalDailyStream";
import { defaultJournalView, type JournalViewConfig, type JournalViewStore } from "./JournalViews";
import type { SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { UnifiedTaskProvider, useUnifiedTasks } from "./UnifiedTaskData";
import { SharedTaskPreviewStatus } from "./SharedTaskPreviewStatus";

const { invoke, resolveTask, listen } = vi.hoisted(() => ({ invoke: vi.fn(), resolveTask: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
vi.mock("./TaskWorkspaceResult", () => ({ resolveTaskResult: resolveTask }));

const journal = (date: string, id = date): SearchResult => ({
  journalDate: date, id, entityKey: `document:craft:library:${id}`, documentId: id, provider: "craft", libraryId: "library", libraryName: "日记库", spaceId: "library", spaceName: "日记库", title: date, path: "", contentType: "document", sourceType: "craft_page", snippet: date === "2026-10-12" ? "更早的日志" : "当天日志正文", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
});
const task = (id: string, patch: Partial<UnifiedTask> = {}): UnifiedTask => ({
  id, provider: "craft", libraryId: "library", libraryName: "任务库", sourceId: id, parentTaskId: "", parentPageId: "", documentId: "task-doc", documentTitle: "任务清单", title: id, completed: false, status: "open", isAllDay: true, dueAt: "2026-10-13", path: "", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked", ...patch,
});
const instant = (day = 13, hour = 12) => new Date(2026, 9, day, hour).toISOString();
const deferred = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; };
const last = <T,>(items: T[]) => items[items.length - 1];
let container: HTMLDivElement, root: Root, logs: SearchResult[], tasks: UnifiedTask[];
let currentStore: JournalViewStore;
const preview = vi.fn(), choose = vi.fn(), create = vi.fn();
function store(patch: Partial<JournalViewConfig> = {}, anchor = ""): JournalViewStore {
  return { view: { ...defaultJournalView(), month: "2026-10", ...patch }, saved: [], activeId: "", anchor, active: undefined, modified: false, update: vi.fn(), navigate: vi.fn(), select: vi.fn(), reset: vi.fn(), save: vi.fn(), updateSaved: vi.fn(), rename: vi.fn(), hide: vi.fn(), remove: vi.fn(), move: vi.fn() };
}
function TaskProbe() {
  const { dashboard } = useUnifiedTasks();
  return <output data-shared-task-state>{dashboard.tasks.map(task => `${task.id}:${task.status}`).join("|")}</output>;
}
const rows = () => [...container.querySelectorAll<HTMLElement>("[data-journal-day]")].map(row => row.dataset.journalDay);
const button = (label: string) => [...container.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent?.trim() === label)!;
const ariaButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(value => value.getAttribute("aria-label")?.startsWith(label))!;
const modal = () => document.body.querySelector<HTMLDialogElement>(".journal-completed-dialog")!;
const completedTrigger = (date = "2026-10-13") => day(date).querySelector<HTMLButtonElement>(".journal-daily-completed-trigger")!;
const day = (date = "2026-10-13") => container.querySelector<HTMLElement>(`[data-journal-day="${date}"]`)!;
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
const taskReadCalls = () => invoke.mock.calls.filter(([command]) => command === "list_unified_tasks");
const render = async (next = currentStore, today = "2026-10-13", extra: Partial<Parameters<typeof JournalDailyStream>[0]> = {}) => {
  currentStore = next;
  await act(async () => root.render(<UnifiedTaskProvider><TaskProbe /><JournalDailyStream store={next} today={today} scope={null} dataVersion="v1" selectedKey="" canCreate={false} onChoose={choose} onPreview={preview} onCreate={create} {...extra} /></UnifiedTaskProvider>));
};
beforeEach(() => {
  logs = []; tasks = []; currentStore = store(); preview.mockClear(); choose.mockClear(); create.mockClear(); resolveTask.mockReset();
  listen.mockReset(); listen.mockResolvedValue(vi.fn());
  invoke.mockReset(); invoke.mockImplementation(async (command, args) => {
    if (command === "journal_page") {
      const items = logs.filter(log => (!args.options.from||log.journalDate! >= args.options.from) && (!args.options.to||log.journalDate! <= args.options.to));
      return { items, total: items.length, days: new Set(items.map(item => item.journalDate)).size, libraries: items.length ? 1 : 0, revision: "v1" };
    }
    if (command === "list_unified_tasks") return { tasks, syncReviews: [], syncEnabled: false, backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0 };
    if (command === "set_unified_task_status") {
      const previous = tasks.find(task => task.id === args.taskId)!;
      const completed = args.status === "completed";
      const changed: UnifiedTask = { ...previous, completed, status: args.status,
        completedAt: completed ? instant() : undefined, completedTimeSource: completed ? "hub" : undefined,
        completionHistory: completed ? [...(previous.completionHistory || []), { at: instant(), source: "hub", reopened: false }]
          : (previous.completionHistory || []).map(event => ({ ...event, reopened: true })),
      };
      tasks = tasks.map(task => task.id === args.taskId ? changed : task); return changed;
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.setAttribute("open", ""); this.querySelector<HTMLButtonElement>("[autofocus]")?.focus(); }) });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: vi.fn(function(this: HTMLDialogElement) { this.removeAttribute("open"); }) });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal"); Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("shows today first and the recent week without adding reading entries", async () => {
  logs = [journal("2026-10-12")]; await render();
  expect(rows()[0]).toBe("2026-10-13");
  expect(last(rows())).toBe("2026-10-06");
  expect(container.querySelectorAll(".journal-daily-date")).toHaveLength(8);
  expect(container.querySelectorAll(".journal-record-preview")).toHaveLength(1);
  expect(container.querySelector(".is-today .relative-day")?.textContent).toBe("今天");
  expect(day("2026-10-12").querySelector(".relative-day")?.textContent).toBe("昨天");
  expect(container.textContent).toContain("更早的日志");
  expect(container.querySelector(".journal-daily-reading")).toBeNull(); expect(container.querySelector("dialog")).toBeNull();
  expect(invoke.mock.calls.some(([command]) => ["list_collection_items", "set_collection_read"].includes(command))).toBe(false);
  expect(invoke).toHaveBeenCalledWith("journal_page", expect.objectContaining({ options: expect.objectContaining({ from: "2026-10-06", to: "2026-10-13" }) }));
  expect(taskReadCalls()).toHaveLength(1);
  expect(container.querySelector(".journal-daily-completed-trigger")).toBeNull();
});
it("stops monthly continuous days at the month boundary and reuses the shared task source", async () => {
  await render(currentStore, "2026-10-29"); expect(rows()[0]).toBe("2026-10-29"); expect(last(rows())).toBe("2026-10-22");
  await click(button("显示前几天")); expect(rows()).toHaveLength(15); expect(last(rows())).toBe("2026-10-15");
  await click(button("显示后几天")); expect(rows()).toHaveLength(17); expect(rows()[0]).toBe("2026-10-31"); expect(button("显示后几天").hasAttribute("disabled")).toBe(true);
  const request = last(invoke.mock.calls.filter(([command]) => command === "journal_page"))![1];
  expect(request.options).toEqual(expect.objectContaining({ from: "2026-10-15", to: "2026-10-31", offset: 0 }));
  expect(taskReadCalls()).toHaveLength(1);
});
it("resets to an outside date or single-day filter while reusing the same tasks", async () => {
  await render(); await click(button("显示前几天"));
  await render(store({ month: "2026-11" }, "2026-11-04")); expect(rows()[0]).toBe("2026-11-04"); expect(rows()).toHaveLength(7);
  await render(store({ period: "day", day: "2026-10-07" })); expect(rows()).toEqual(["2026-10-07"]);
  expect([...container.querySelectorAll("button")].some(value => value.textContent === "显示前几天")).toBe(false);
  expect(invoke).toHaveBeenCalledWith("journal_page", expect.objectContaining({ options: expect.objectContaining({ from: "2026-10-07", to: "2026-10-07" }) }));
  expect(taskReadCalls()).toHaveLength(1);
});
it("keeps multiple source journals independent and forwards preview and creation dates", async () => {
  logs = [journal("2026-10-13", "one"), { ...journal("2026-10-13", "two"), libraryId: "other", libraryName: "个人库" }];
  await render(undefined, undefined, { canCreate: true }); expect(container.querySelectorAll(".journal-record-preview")).toHaveLength(2);
  await click(ariaButton("预览日志：")); expect(preview.mock.calls[0][0]).toEqual(expect.objectContaining({ documentId: "one", libraryName: "日记库" }));
  await click(day().querySelector<HTMLButtonElement>(".journal-daily-date")!); expect(choose).toHaveBeenCalledWith("2026-10-13");
  await render({ ...currentStore, anchor: "2026-10-13" }, undefined, { canCreate: true });
  const addButtons = day().querySelectorAll<HTMLButtonElement>(".journal-daily-add");
  expect(addButtons).toHaveLength(1);
  expect(addButtons[0].textContent).toBe("补记");
  await click(addButtons[0]);
  expect(create).toHaveBeenCalledWith("2026-10-13");
});
it("places the backfill editor within only the matching date", async () => {
  await render(undefined, undefined, { canCreate: true, composer: <input aria-label="补记正文" />, composerDate: "2026-10-12" });
  expect(day("2026-10-12").querySelector('[aria-label="补记正文"]')).not.toBeNull();
  expect(day("2026-10-12").querySelector(".journal-daily-add")?.getAttribute("aria-expanded")).toBe("true");
  expect(day().querySelector('[aria-label="补记正文"]')).toBeNull();
});
it("separates today's arrangements, actual completions and new tasks without same-day duplicates", async () => {
  tasks = [
    task("当天安排", { startAt: "2026-10-13", reminderAt: [instant(13, 9)], createdAt: instant(13, 8) }),
    task("新建但下周安排", { dueAt: "2026-10-20", createdAt: instant(13, 10) }),
    task("昨天到期今天完成", { dueAt: "2026-10-12", completed: true, status: "completed", completedAt: instant(13, 14), completedTimeSource: "source", createdAt: instant(13, 8) }),
    task("未知完成日期", { completed: true, status: "completed" }),
  ];
  await render();
  const today = day(), created = today.querySelector<HTMLDetailsElement>(".journal-daily-created")!;
  expect(today.querySelector(".journal-daily-task-heading")).toBeNull();
  expect(today.querySelector('[data-task-id="当天安排"] button[aria-label^="查看任务"]')?.getAttribute("title")).toBe("任务库 · 开始 · 截止 · 提醒 · 新建");
  expect(completedTrigger().textContent).toBe("1已完成的任务"); expect(today.querySelector(".journal-daily-completed")).toBeNull();
  expect(created.querySelector("summary")?.textContent).toBe("1当天新建"); expect(created.open).toBe(true);
  expect(created.querySelector(".task-title")?.textContent).toBe("新建但下周安排");
  expect(today.querySelector('[data-task-id="昨天到期今天完成"]')).toBeNull();
  await click(completedTrigger()); expect(modal().querySelector(".task-title")?.textContent).toBe("昨天到期今天完成");
  expect(today.querySelectorAll('[data-task-id="当天安排"]')).toHaveLength(1); expect(modal().querySelectorAll('[data-task-id="昨天到期今天完成"]')).toHaveLength(1);
  expect(today.querySelector('[data-task-id="未知完成日期"]')).toBeNull();
});
it("opens the actual source task preview when today's completed section is expanded", async () => {
  tasks = [task("已完成任务", { completed: true, status: "completed", dueAt: "2026-10-01", completedAt: instant() })]; resolveTask.mockResolvedValue(journal("2026-10-13", "resolved-task"));
  await render(); await click(completedTrigger()); expect(modal().open).toBe(true);
  await click(ariaButton("查看任务：已完成任务")); expect(resolveTask).toHaveBeenCalledWith(tasks[0]); expect(preview).toHaveBeenCalledWith(expect.objectContaining({ documentId: "resolved-task" }));
});
it("returns reopened tasks to their schedule and removes the completed entry", async () => {
  tasks = [task("完成后重开", { dueAt: "2026-10-14", completionHistory: [{ at: instant(13, 9), source: "hub", reopened: true }] })];
  await render();
  expect(completedTrigger()).toBeNull();
  expect(document.body.querySelector(".journal-completed-dialog")).toBeNull();
  await click(button("显示后几天"));
  expect(day("2026-10-14").querySelectorAll(".journal-daily-task")).toHaveLength(1);
});
it("waits for confirmed completion and updates every consumer of the shared task snapshot", async () => {
  tasks = [task("Craft任务"), task("滴答任务", { provider: "dida365" }), task("笔记任务", { provider: "obsidian" })]; await render();
  const writable = container.querySelector<HTMLButtonElement>('[aria-label="完成任务：Craft任务"]')!;
  expect(writable.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('[aria-label="完成任务：滴答任务"]')!.disabled).toBe(false);
  expect(container.querySelector<HTMLButtonElement>('[aria-label^="完成任务：笔记任务"]')!.disabled).toBe(true);
  const pending = deferred<UnifiedTask>(), handler = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "set_unified_task_status" ? pending.promise : handler(command, args));
  await click(writable); expect(writable.getAttribute("aria-checked")).toBe("true"); expect(writable.disabled).toBe(false);
  expect(writable.getAttribute("aria-busy")).toBe("true");
  expect(container.querySelector("[data-shared-task-state]")?.textContent).toContain("Craft任务:open");
  await act(async () => pending.resolve(task("Craft任务", { completed: true, status: "completed", completedAt: instant(), completedTimeSource: "hub", completionHistory: [{ at: instant(), source: "hub", reopened: false }] })));
  expect(completedTrigger().textContent).toBe("1已完成的任务"); await click(completedTrigger());
  const confirmed = modal().querySelector<HTMLButtonElement>('[aria-label="重新打开任务：Craft任务"]')!;
  expect(confirmed.getAttribute("aria-checked")).toBe("true"); expect(confirmed.disabled).toBe(false);
  expect(confirmed.closest(".journal-completed-dialog")).not.toBeNull();
  expect(completedTrigger().textContent).toBe("1已完成的任务");
  expect(container.querySelector("[data-shared-task-state]")?.textContent).toContain("Craft任务:completed");
  expect(taskReadCalls()).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith("set_unified_task_status", { taskId: "Craft任务", status: "completed", expectedStatus: "open", expectedLibraryId: "library", expectedDocumentId: "task-doc", expectedSourceId: "Craft任务" });
  tasks = tasks.map(item => item.id === "Craft任务" ? { ...item, status: "completed", completed: true,
    completedAt: instant(), completionHistory: [{ at: instant(), source: "hub", reopened: false }] } : item);
  invoke.mockImplementation(handler);
  await click(confirmed);
  expect(completedTrigger()).toBeNull();
  expect(document.body.querySelector(".journal-completed-dialog")).toBeNull();
  expect(day().querySelector<HTMLButtonElement>('[aria-label="完成任务：Craft任务"]')?.getAttribute("aria-checked")).toBe("false");
  expect(container.querySelector("[data-shared-task-state]")?.textContent).toContain("Craft任务:open");
  expect(taskReadCalls()).toHaveLength(1);
});
it("keeps the original arrangement and shared state when source completion fails", async () => {
  tasks = [task("失败任务")]; await render(); const pending = deferred<UnifiedTask>(), handler = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "set_unified_task_status" ? pending.promise : handler(command, args));
  await click(container.querySelector<HTMLButtonElement>('[aria-label="完成任务：失败任务"]')!);
  await act(async () => pending.reject(new Error("来源拒绝写入")));
  const current = container.querySelector<HTMLButtonElement>('[aria-label="完成任务：失败任务"]')!;
  expect(current.getAttribute("aria-checked")).toBe("false"); expect(current.disabled).toBe(false); expect(current.closest(".journal-daily-completed")).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("来源拒绝写入");
  expect(container.querySelector("[data-shared-task-state]")?.textContent).toContain("失败任务:open");
});
it("keeps keyboard focus reachable when a completion moves the task into the folded section", async () => {
  tasks = [task("键盘任务")]; await render();
  const input = container.querySelector<HTMLButtonElement>('[aria-label="完成任务：键盘任务"]')!;
  input.focus(); expect(document.activeElement).toBe(input);
  await click(input);
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
  expect(document.activeElement).toBe(completedTrigger());
});
it("closes the completed dialog and restores the scheduled row after successful reopen", async () => {
  tasks = [task("重开任务", { completed: true, status: "completed", completedAt: instant(), completedTimeSource: "hub", completionHistory: [{ at: instant(), source: "hub", reopened: false }] })]; await render();
  await click(completedTrigger());
  await click(modal().querySelector<HTMLButtonElement>('[aria-label="重新打开任务：重开任务"]')!);
  const reopened = day().querySelector<HTMLButtonElement>('[aria-label="完成任务：重开任务"]')!;
  expect(reopened.getAttribute("aria-checked")).toBe("false");
  expect(completedTrigger()).toBeNull(); expect(modal()).toBeNull();
  expect(day().querySelectorAll('[data-task-id="重开任务"]')).toHaveLength(1);
  expect(tasks[0].completionHistory?.[0].reopened).toBe(true);
  expect(container.querySelector("[data-shared-task-state]")?.textContent).toContain("重开任务:open");
});

it("moves a task out of completed when reopening it from the still-open sidebar", async () => {
  tasks = [task("侧栏任务")];
  const selected: SearchResult = { ...journal("2026-10-13"), documentId: "task-doc", blockId: "侧栏任务", contentType: "task" };
  await act(async () => root.render(<UnifiedTaskProvider><JournalDailyStream store={currentStore} today="2026-10-13"
    scope={null} dataVersion="v1" selectedKey="" canCreate={false} onChoose={choose} onPreview={preview} />
    <aside data-sidebar><SharedTaskPreviewStatus result={selected}/></aside></UnifiedTaskProvider>));
  const sidebarControl = () => container.querySelector<HTMLButtonElement>("[data-sidebar] .task-status-control")!;
  await click(sidebarControl());
  expect(completedTrigger().textContent).toBe("1已完成的任务");
  expect(day().querySelector('[data-task-id="侧栏任务"]')).toBeNull();
  expect(sidebarControl().getAttribute("aria-checked")).toBe("true");
  await click(sidebarControl());
  expect(sidebarControl().getAttribute("aria-checked")).toBe("false");
  expect(completedTrigger()).toBeNull();
  expect(day().querySelectorAll('[data-task-id="侧栏任务"]')).toHaveLength(1);
  expect(taskReadCalls()).toHaveLength(1);
});
it("applies query and library filters as projections without reloading the native dashboard", async () => {
  tasks = [task("工程任务"), task("个人任务", { libraryId: "personal", libraryName: "个人库" })]; await render();
  await render(store({ query: "工程" }), undefined, { scope: ["library"] });
  expect(day().querySelectorAll(".journal-daily-task")).toHaveLength(1); expect(day().querySelector(".task-title")?.textContent).toBe("工程任务");
  await render(store(), undefined, { scope: ["personal"] });
  expect(day().querySelector(".task-title")?.textContent).toBe("个人任务"); expect(taskReadCalls()).toHaveLength(1);
});
it("discards a pending task preview after navigating to another date range", async () => {
  tasks = [task("打开中的任务")]; const pending = deferred<SearchResult>(); resolveTask.mockReturnValue(pending.promise);
  await render(); await click(ariaButton("查看任务：打开中的任务"));
  await render(store({ month: "2026-11" }, "2026-11-01"));
  await act(async () => pending.resolve(journal("2026-10-13", "old-task-preview")));
  expect(preview).not.toHaveBeenCalled(); expect(container.querySelectorAll("[role=alert]")).toHaveLength(0);
});
it("enumerates leap days and year boundaries without dropping empty days", () => {
  expect(journalDailyDates("2028-02-28", "2028-03-02")).toEqual(["2028-02-28", "2028-02-29", "2028-03-01"]);
  expect(journalDailyDates("2026-12-31", "2027-01-02")).toEqual(["2026-12-31", "2027-01-01"]);
});

it("keeps the recent calendar newest first and exposes all four task inclusion rules", async () => {
  logs = [journal("2026-10-13")];
  tasks = [
    task("区间中的任务", { provider: "dida365", libraryId: "dida", linkedLibraryIds: ["library", "dida"], collectionName: "工作清单", startAt: "2026-10-10", dueAt: "2026-10-16" }),
    task("今天提醒", { provider: "dida365", dueAt: undefined, reminderAt: [instant(13, 9)] }),
    task("今天新建", { provider: "dida365", dueAt: undefined, createdAt: instant(13, 8) }),
    task("今天完成", { provider: "dida365", completed: true, status: "completed", dueAt: "2026-10-01", completedAt: instant(13, 14) }),
  ];
  await render(store({ ascending: false }), undefined, { scope: ["library"] });
  expect(rows().slice(0, 2)).toEqual(["2026-10-13", "2026-10-12"]);
  expect(day().querySelector(".date-title")?.textContent).toBe("10月13日");
  expect(day().querySelector(".journal-record-card>header")?.textContent).toContain("2026-10-13");
  expect(day().querySelector('[data-task-id="区间中的任务"] .task-library')?.textContent).toBe("工作清单");
  expect(day().querySelector('[data-task-id="区间中的任务"] button[aria-label^="查看任务"]')?.getAttribute("title")).toContain("进行中");
  expect(day().querySelector('[data-task-id="今天提醒"]')).not.toBeNull();
  expect(day().querySelector<HTMLDetailsElement>(".journal-daily-created")?.open).toBe(true);
  await click(completedTrigger());
  expect(modal().open).toBe(true);
  expect(modal().querySelector('[data-task-id="今天完成"]')).not.toBeNull();
  expect(taskReadCalls()).toHaveLength(1);
});

it("opens completion records outside the day row and restores focus when dismissed", async () => {
  tasks = [task("完成记录", { status: "completed", completed: true, completedAt: instant() })];
  await render();
  const trigger = completedTrigger(); trigger.focus();
  const originalContent = day().innerHTML;
  await click(trigger);
  expect(modal().open).toBe(true);
  expect(day().querySelector("dialog")).toBeNull();
  expect(day().querySelectorAll(".journal-daily-task")).toHaveLength(0);
  expect(modal().querySelector(".journal-completed-date")?.textContent).toBe("10月13日");
  expect(modal().querySelector("header h2")?.textContent).toBe("日志 · 星期二");
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  await act(async () => modal().dispatchEvent(new Event("cancel", { bubbles: true, cancelable: true })));
  expect(modal()).toBeNull(); expect(document.activeElement).toBe(trigger);
  expect(day().innerHTML).toBe(originalContent);
});

it("keeps the source task row enabled while opening and coalesces repeated clicks", async () => {
  tasks = [task("首次预览")]; const pending = deferred<SearchResult>(); resolveTask.mockReturnValue(pending.promise);
  await render(); const open = ariaButton("查看任务：首次预览");
  await click(open); await click(open);
  expect(open.disabled).toBe(false); expect(open.getAttribute("aria-busy")).toBe("true");
  expect(resolveTask).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(journal("2026-10-13", "opened")));
  expect(open.getAttribute("aria-busy")).toBe("false"); expect(preview).toHaveBeenCalledOnce();
});

it("cancels an unfinished completed-task preview when the dialog is dismissed", async () => {
  tasks = [task("取消预览", { status: "completed", completed: true, completedAt: instant() })];
  const pending = deferred<SearchResult>(); resolveTask.mockReturnValue(pending.promise);
  await render(); await click(completedTrigger()); await click(ariaButton("查看任务：取消预览"));
  await click(ariaButton("关闭已完成任务"));
  await act(async () => pending.resolve(journal("2026-10-13", "cancelled")));
  expect(preview).not.toHaveBeenCalled(); expect(modal()).toBeNull();
});

it("hides completion controls when today has only logs and open tasks", async () => {
  logs = [journal("2026-10-13")];
  tasks = [task("今天安排"), task("今天新建", { dueAt: undefined, createdAt: instant() }),
    task("未知完成日期", { status: "completed", completed: true })];
  await render();
  expect(day().querySelectorAll(".journal-daily-task")).toHaveLength(2);
  expect(day().querySelector(".journal-record-preview")).not.toBeNull();
  expect(day().querySelector(".journal-daily-completed-trigger")).toBeNull();
  expect(modal()).toBeNull();
});

it("closes a completion dialog when the shared source removes its last completion", async () => {
  tasks = [task("来源删除的任务", { status: "completed", completed: true, completedAt: instant() })];
  await render(); await click(completedTrigger()); expect(modal().open).toBe(true);
  tasks = [];
  await act(async () => {
    const handler = listen.mock.calls.find(([name]) => name === "task-list-updated")![1];
    handler({ payload: {} });
    await new Promise(resolve => setTimeout(resolve, 220));
  });
  expect(completedTrigger()).toBeNull(); expect(modal()).toBeNull();
});

it("shows a historical match outside the current writing week under monthly search",async()=>{
 logs=[journal("2026-10-02")]; await render(store({query:"历史"}));
 expect(rows()).toEqual(["2026-10-02"]);
 expect(container.querySelector(".journal-daily-previous")).toBeNull();
 expect(invoke.mock.calls.some(([cmd,args])=>cmd==="journal_page"&&args.options.from==="2026-10-01"&&args.options.to==="2026-10-31")).toBe(true);
});
it("shows all-date results across months without empty days or a writing-week bound",async()=>{
 logs=[journal("2026-08-01"),journal("2026-10-02")]; await render(store({period:"all"}));
 expect(rows()).toEqual(["2026-08-01","2026-10-02"]);
 expect(invoke.mock.calls.some(([cmd,args])=>cmd==="journal_page"&&args.options.from===null&&args.options.to===null)).toBe(true);
});
