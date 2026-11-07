// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

const { invokeMock, eventHandlers } = vi.hoisted(() => ({
  invokeMock: vi.fn(), eventHandlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, handler) => {
  eventHandlers.set(name, handler);
  return () => eventHandlers.delete(name);
}) }));
import { createUnifiedTaskStore, UnifiedTaskProvider, useUnifiedTasks, type UnifiedTaskDashboard } from "./UnifiedTaskData";

const task: UnifiedTask = {
  id: "task-1", provider: "craft", libraryId: "craft-one", libraryName: "工作",
  sourceId: "block-1", parentTaskId: "", parentPageId: "page-1", documentId: "doc-1",
  documentTitle: "日常", title: "核对图纸", completed: false, status: "open", isAllDay: true,
  dueAt: "2026-10-13", path: "", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked",
};
const dashboard = (tasks: UnifiedTask[] = [task]): UnifiedTaskDashboard => ({
  tasks, total: tasks.length, open: tasks.filter(item => item.status === "open").length,
  completed: tasks.filter(item => item.status === "completed").length,
  craft: tasks.length, dida365: 0, obsidian: 0, linked: 0, syncEnabled: false,
  backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0, syncReviews: [],
});
const savedTask = () => ({ ...task, completed: true, status: "completed" as const,
  completedAt: "2026-10-13T10:00:00+08:00", completedTimeSource: "hub" as const,
  completionHistory: [{ at: "2026-10-13T10:00:00+08:00", source: "hub" as const, reopened: false }],
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
let root: Root | null = null;
let container: HTMLDivElement | null = null;
const consumers = new Map<string, ReturnType<typeof useUnifiedTasks>>();
function Consumer({ id, enabled = true, query = "", dataVersion }: { id: string; enabled?: boolean; query?: string; dataVersion?: string }) {
  const data = useUnifiedTasks({ enabled, dataVersion });
  consumers.set(id, data);
  return <p data-consumer={id}>{query}:{data.dashboard.open}/{data.dashboard.completed}:{data.dashboard.tasks[0]?.status}</p>;
}
const lists = () => invokeMock.mock.calls.filter(([command]) => command === "list_unified_tasks");
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  invokeMock.mockReset(); eventHandlers.clear(); consumers.clear();
  invokeMock.mockImplementation(async command => command === "list_unified_tasks" ? dashboard() : savedTask());
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove(); root = null; container = null;
  vi.useRealTimers();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
async function mount(element: React.ReactNode) {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root!.render(element));
}

it("shares one lazy unfiltered read across simultaneous consumers and retains it when pages switch", async () => {
  const page = (enabled: boolean, query: string) => <UnifiedTaskProvider dataVersion="session">
    <Consumer id="main" enabled={enabled} query={query} /><Consumer id="journal" enabled={enabled} query={query} />
  </UnifiedTaskProvider>;
  await mount(page(false, "")); expect(lists()).toHaveLength(0);
  await act(async () => root!.render(page(true, ""))); expect(lists()).toHaveLength(1);
  await act(async () => root!.render(page(true, "明天"))); expect(lists()).toHaveLength(1);
  await act(async () => root!.render(<UnifiedTaskProvider dataVersion="session"><Consumer id="other" /></UnifiedTaskProvider>));
  expect(lists()).toHaveLength(1);
  expect(consumers.get("other")!.dashboard.tasks).toHaveLength(1);
});

it("ignores consumer log revisions under a controlled provider and refreshes on the full source version", async () => {
  await mount(<UnifiedTaskProvider dataVersion="global-1"><Consumer id="journal" dataVersion="scope-1" /></UnifiedTaskProvider>);
  await act(async () => root!.render(<UnifiedTaskProvider dataVersion="global-1"><Consumer id="journal" dataVersion="scope-2" query="任务" /></UnifiedTaskProvider>));
  expect(lists()).toHaveLength(1);
  await act(async () => root!.render(<UnifiedTaskProvider dataVersion="global-2"><Consumer id="journal" dataVersion="scope-2" /></UnifiedTaskProvider>));
  expect(lists()).toHaveLength(2);
});

it("fans out only confirmed task completion and counts to both views", async () => {
  await mount(<UnifiedTaskProvider><Consumer id="main" /><Consumer id="journal" /></UnifiedTaskProvider>);
  await act(async () => { expect(await consumers.get("journal")!.setTaskCompleted(task, true)).toBe(true); });
  for (const id of ["main", "journal"]) {
    expect(consumers.get(id)!.dashboard.tasks[0]).toMatchObject({ status: "completed", completedAt: savedTask().completedAt });
    expect(consumers.get(id)!.dashboard).toMatchObject({ open: 0, completed: 1 });
  }
  expect(invokeMock).toHaveBeenCalledWith("set_unified_task_status", {
    taskId: task.id, status: "completed", expectedStatus: "open", expectedLibraryId: task.libraryId,
    expectedDocumentId: task.documentId, expectedSourceId: task.sourceId,
  });
});

it("retains a saved status when an earlier read resolves after the native write", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  const oldRead = deferred<UnifiedTaskDashboard>();
  invokeMock.mockImplementation(command => command === "list_unified_tasks" ? oldRead.promise : Promise.resolve(savedTask()));
  const refresh = store.refresh();
  expect(await store.setTaskCompleted(task, true)).toBe(true);
  oldRead.resolve(dashboard()); await refresh;
  expect(store.getSnapshot().dashboard).toMatchObject({ open: 0, completed: 1 });
  expect(store.getSnapshot().dashboard.tasks[0].completedAt).toBe(savedTask().completedAt);
  // A new read begun after the save is authoritative and may reflect a later source reopen.
  invokeMock.mockResolvedValue(dashboard()); await store.refresh();
  expect(store.getSnapshot().dashboard.tasks[0].status).toBe("open");
});

it("does not lose a task confirmed by a write when the old snapshot omitted that task", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  const oldRead = deferred<UnifiedTaskDashboard>();
  invokeMock.mockImplementation(command => command === "list_unified_tasks" ? oldRead.promise : Promise.resolve(savedTask()));
  const refresh = store.refresh(); await store.setTaskCompleted(task, true);
  oldRead.resolve(dashboard([])); await refresh;
  expect(store.getSnapshot().dashboard.tasks).toEqual([savedTask()]);
});

it("coalesces duplicate targets and rejects stale identities without changing the confirmed state", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  const write = deferred<UnifiedTask>(); invokeMock.mockImplementation(() => write.promise);
  const first = store.setTaskCompleted(task, true);
  expect(store.getSnapshot().taskBusyIds.has(task.id)).toBe(true);
  expect(store.getSnapshot().taskStatusTargets.get(task.id)).toBe("completed");
  const duplicate = store.setTaskCompleted(task, true);
  expect(invokeMock.mock.calls.filter(([command]) => command === "set_unified_task_status")).toHaveLength(1);
  expect(store.getSnapshot().dashboard.tasks[0].status).toBe("open");
  write.resolve(savedTask()); expect(await first).toBe(true);
  expect(await duplicate).toBe(true);
  expect(store.getSnapshot().taskBusyIds.size).toBe(0);
  expect(store.getSnapshot().taskStatusTargets.size).toBe(0);
  const count = invokeMock.mock.calls.length;
  expect(await store.setTaskCompleted({ ...savedTask(), sourceId: "reused-wrong-block" }, false)).toBe(false);
  expect(invokeMock.mock.calls).toHaveLength(count);
});

it("keeps the newest target through an old confirmation and rebases the next write", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  const firstWrite = deferred<UnifiedTask>(), lastWrite = deferred<UnifiedTask>();
  invokeMock.mockImplementationOnce(() => firstWrite.promise).mockImplementationOnce(() => lastWrite.promise);
  const first = store.setTaskCompleted(task, true);
  const last = store.setTaskCompleted(task, false);
  expect(store.getSnapshot().taskStatusTargets.get(task.id)).toBe("open");
  firstWrite.resolve(savedTask()); await Promise.resolve(); await Promise.resolve();
  expect(store.getSnapshot().taskStatusTargets.get(task.id)).toBe("open");
  expect(invokeMock).toHaveBeenLastCalledWith("set_unified_task_status", expect.objectContaining({ status: "open", expectedStatus: "completed" }));
  lastWrite.resolve(task);
  expect(await first).toBe(false);
  expect(await last).toBe(true);
  expect(store.getSnapshot().dashboard).toMatchObject({ open: 1, completed: 0 });
  expect(store.getSnapshot().taskStatusTargets.size).toBe(0);
});

it("collapses complete–open–complete clicks into the in-flight completion", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  const write = deferred<UnifiedTask>(); invokeMock.mockImplementation(() => write.promise);
  const first = store.setTaskCompleted(task, true), middle = store.setTaskCompleted(task, false), last = store.setTaskCompleted(task, true);
  write.resolve(savedTask());
  expect(await Promise.all([first, middle, last])).toEqual([true, false, true]);
  expect(invokeMock.mock.calls.filter(([name]) => name === "set_unified_task_status")).toHaveLength(1);
});

it("replaces an offline pending completion even when the source is still open", async () => {
  const pendingTask: UnifiedTask = { ...task, provider: "dida365", statusMutation: { operationId: 11, state: "pending", targetStatus: "completed" } };
  invokeMock.mockResolvedValue(dashboard([pendingTask]));
  const store = createUnifiedTaskStore(); await store.refresh();
  invokeMock.mockResolvedValue({ ...pendingTask, statusMutation: { operationId: 12, state: "confirmed", targetStatus: "open" } });
  expect(await store.setTaskCompleted(pendingTask, false)).toBe(true);
  expect(invokeMock).toHaveBeenLastCalledWith("set_unified_task_status", expect.objectContaining({ status: "open", expectedStatus: "open" }));
  expect(store.getSnapshot().taskBusyIds.size).toBe(0);
});

it("keeps unsupported and synthetic tasks read-only before any native write", async () => {
  const readonly = [
    { ...task, id: "recurring", provider: "dida365" as const, statusWriteBlockedReason: "循环任务请在滴答中修改" },
    { ...task, id: "obsidian", provider: "obsidian" as const },
    { ...task, id: "project", isProject: true },
    { ...task, id: "synthetic", sourceId: "doc:line:4" },
    { ...task, id: "conflict", syncState: "conflict" as const },
    { ...task, id: "abandoned", status: "abandoned" as const },
  ];
  invokeMock.mockResolvedValue(dashboard(readonly));
  const store = createUnifiedTaskStore(); await store.refresh();
  for (const item of readonly) expect(await store.setTaskCompleted(item, true)).toBe(false);
  expect(invokeMock.mock.calls).toHaveLength(1);
  expect(store.getSnapshot().taskBusyIds.size).toBe(0);
});

it("rejects mismatched native confirmations and retains the old dashboard after read or write failures", async () => {
  const store = createUnifiedTaskStore(); await store.refresh();
  invokeMock.mockResolvedValue({ ...savedTask(), libraryId: "other-library" });
  expect(await store.setTaskCompleted(task, true)).toBe(false);
  expect(store.getSnapshot().dashboard.tasks[0]).toBe(task);
  expect(store.getSnapshot().error).toContain("来源尚未确认");
  invokeMock.mockRejectedValue(new Error("离线")); await store.refresh();
  expect(store.getSnapshot().dashboard.tasks[0]).toBe(task);
  expect(store.getSnapshot().loading).toBe(false); expect(store.getSnapshot().error).toContain("离线");
  expect(await store.setTaskCompleted(task, true)).toBe(false);
  expect(store.getSnapshot().taskBusyIds.size).toBe(0);
});

it("ignores active sync phases and coalesces settled native changes into one dashboard read", async () => {
  await mount(<UnifiedTaskProvider><Consumer id="main" /><Consumer id="journal" /></UnifiedTaskProvider>);
  vi.useFakeTimers();
  const runtime = { libraryId: "craft-one", state: "running", phase: "indexing", detail: "更新索引",
    activeOperations: 1, pending: 0, updatedAt: 1_792_000_000_000 };
  await act(async () => {
    eventHandlers.get("library-runtime-updated")!({ payload: runtime });
    eventHandlers.get("library-runtime-updated")!({ payload: { ...runtime, phase: "committing", updatedAt: runtime.updatedAt + 1 } });
    // A cancelled operation may still hold the writer until the Operation is dropped.
    eventHandlers.get("library-runtime-updated")!({ payload: { ...runtime, state: "cancelled", phase: "stopping" } });
    eventHandlers.get("task-sync-updated")!({ payload: { status: "running" } });
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(lists()).toHaveLength(1);
  await act(async () => {
    eventHandlers.get("task-list-updated")!({ payload: {} });
    eventHandlers.get("task-sync-updated")!({ payload: { status: "completed" } });
    eventHandlers.get("library-runtime-updated")!({ payload: { ...runtime, state: "idle", phase: "idle", activeOperations: 0, pending: 0, updatedAt: runtime.updatedAt + 2 } });
    await vi.advanceTimersByTimeAsync(160);
  });
  expect(lists()).toHaveLength(2);
});

it("marks a dormant shared session stale without fetching until the next active page", async () => {
  await mount(<UnifiedTaskProvider><Consumer id="main" /></UnifiedTaskProvider>);
  await act(async () => root!.render(<UnifiedTaskProvider><Consumer id="main" enabled={false} /></UnifiedTaskProvider>));
  vi.useFakeTimers();
  await act(async () => {
    eventHandlers.get("task-list-updated")!({ payload: {} }); await vi.advanceTimersByTimeAsync(160);
  });
  expect(lists()).toHaveLength(1);
  await act(async () => root!.render(<UnifiedTaskProvider><Consumer id="journal" /></UnifiedTaskProvider>));
  expect(lists()).toHaveLength(2);
});

it("submits Dida completion once and patches both consumers without a dashboard reload", async () => {
  const dida: UnifiedTask = { ...task, id: "dida-real", provider: "dida365", sourceId: "dida-source", documentId: "dida-source" };
  invokeMock.mockImplementation(async command => command === "list_unified_tasks" ? dashboard([dida]) : {
    ...dida, status: "completed", completed: true, completedAt: "2026-10-13T23:59:58+08:00", completedTimeSource: "source",
  });
  await mount(<UnifiedTaskProvider><Consumer id="main"/><Consumer id="journal"/></UnifiedTaskProvider>);
  await act(async () => { expect(await consumers.get("main")!.setTaskCompleted(dida, true)).toBe(true); });
  expect(lists()).toHaveLength(1);
  for (const id of ["main", "journal"]) expect(consumers.get(id)!.dashboard.tasks[0]).toMatchObject({ status: "completed", completedAt: "2026-10-13T23:59:58+08:00" });
});

it("retains pending intents across refresh and enables retry after a terminal failure", async () => {
  const dida: UnifiedTask = { ...task, provider: "dida365" };
  invokeMock.mockResolvedValue(dashboard([dida]));
  const store = createUnifiedTaskStore(); await store.refresh();
  const pending = { ...dida, statusMutation: { operationId: 7, state: "pending" as const, targetStatus: "completed" as const } };
  invokeMock.mockResolvedValue(pending);
  expect(await store.setTaskCompleted(dida, true)).toBe(false);
  expect(store.getSnapshot().dashboard.tasks[0].completed).toBe(false);
  expect(store.getSnapshot().taskBusyIds.has(dida.id)).toBe(true);
  expect(store.getSnapshot().taskStatusTargets.get(dida.id)).toBe("completed");
  invokeMock.mockResolvedValue(dashboard([pending])); await store.refresh();
  expect(store.getSnapshot().taskBusyIds.has(dida.id)).toBe(true);
  const failed = { ...pending, statusMutation: { ...pending.statusMutation, state: "failed" as const, error: "网络不可用" } };
  invokeMock.mockResolvedValue(dashboard([failed])); await store.refresh();
  expect(store.getSnapshot().taskBusyIds.has(dida.id)).toBe(false);
  expect(store.getSnapshot().taskStatusTargets.get(dida.id)).toBe("completed");
  invokeMock.mockResolvedValue({ ...dida, status: "completed", completed: true });
  expect(await store.setTaskCompleted(failed, true)).toBe(true);
});
