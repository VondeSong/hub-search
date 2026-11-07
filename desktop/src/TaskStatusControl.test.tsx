// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { taskSearchResult } from "./TaskWorkspaceResult";
const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { UnifiedTaskProvider, useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl } from "./TaskStatusControl";
import { SharedTaskPreviewStatus } from "./SharedTaskPreviewStatus";

const task: UnifiedTask = { id: "dida-task", provider: "dida365", libraryId: "dida", libraryName: "滴答", sourceId: "source", documentId: "source", documentTitle: "收件箱", title: "同步状态", completed: false, status: "open", isAllDay: true, parentTaskId: "", parentPageId: "", path: "", depth: 0, isProject: false, linkedProviders: [], syncState: "unlinked" };
let root: Root | undefined, host: HTMLDivElement | undefined;
let rowClicks = 0;
let refreshTasks: () => Promise<void>;
function Row() {
  const shared = useUnifiedTasks();
  refreshTasks = shared.refresh;
  const current = shared.dashboard.tasks[0];
  return current ? <div data-row onClick={() => rowClicks++}><TaskStatusControl task={current} busy={shared.taskBusyIds.has(current.id)}
    pendingStatus={shared.taskStatusTargets.get(current.id)}
    onChange={(task, completed) => { void shared.setTaskCompleted(task, completed); }}/></div> : null;
}
async function mount(initial: UnifiedTask) {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  rowClicks = 0; invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => command === "list_unified_tasks"
    ? { tasks: [initial], total: 1, open: initial.completed ? 0 : 1, completed: initial.completed ? 1 : 0, syncReviews: [] }
    : command === "set_unified_task_status" ? { ...initial, completed: args.status === "completed", status: args.status,
      completedAt: "2026-10-14T00:10:00+08:00", statusMutation: { operationId: 2, state: "confirmed", targetStatus: args.status } } : undefined);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<UnifiedTaskProvider><Row/><SharedTaskPreviewStatus result={taskSearchResult(initial)}/></UnifiedTaskProvider>));
}
afterEach(async () => { if(root) await act(async () => root!.unmount()); host?.remove(); root=undefined; delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it("updates row and sidebar controls together and does not open the row when checking", async () => {
  await mount(task);
  const checkbox = host!.querySelector<HTMLButtonElement>("[data-row] [role=checkbox]")!;
  await act(async () => checkbox.click());
  expect(rowClicks).toBe(0);
  expect([...host!.querySelectorAll("[role=checkbox]")].map(node => node.getAttribute("aria-checked"))).toEqual(["true", "true"]);
  expect(invokeMock.mock.calls.filter(([name]) => name === "list_unified_tasks")).toHaveLength(1);
  await act(async () => host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")[1].click());
  expect([...host!.querySelectorAll("[role=checkbox]")].map(node => node.getAttribute("aria-checked"))).toEqual(["false", "false"]);
});

it("retries a failed mirror without toggling an already completed primary task", async () => {
  await mount({ ...task, completed: true, status: "completed", statusMutation: { operationId: 1, state: "failed", targetStatus: "completed", error: "Craft 离线" } });
  await act(async () => host!.querySelector<HTMLButtonElement>('[aria-label="重试状态同步：同步状态"]')!.click());
  expect(invokeMock).toHaveBeenCalledWith("set_unified_task_status", expect.objectContaining({ status: "completed", expectedStatus: "completed" }));
  expect([...host!.querySelectorAll("[role=checkbox]")].every(node => node.getAttribute("aria-checked") === "true")).toBe(true);
  expect(host!.textContent).not.toContain("重试同步");
});

it("retains a failed latest target and lets the user cancel it with the next click", async () => {
  await mount({ ...task, completed: true, status: "completed", statusMutation: { operationId: 3, state: "failed", targetStatus: "open", error: "回读暂不可用" } });
  const control = host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")[1];
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.getAttribute("data-unsynced")).toBe("true");
  expect(control.disabled).toBe(false);
  await act(async () => control.click());
  expect(invokeMock).toHaveBeenCalledWith("set_unified_task_status", expect.objectContaining({ status: "completed", expectedStatus: "completed" }));
  expect(control.getAttribute("aria-checked")).toBe("true");
  expect(control.getAttribute("data-unsynced")).toBe("false");
});

it("shows the target icon in both views while completing and reopening, then clears sync feedback", async () => {
  await mount(task);
  let resolveWrite!: (saved: UnifiedTask) => void;
  invokeMock.mockImplementation((command) => command === "set_unified_task_status"
    ? new Promise<UnifiedTask>(resolve => { resolveWrite = resolve; }) : undefined);
  const controls = () => [...host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")];
  await act(async () => controls()[1].click());
  for (const control of controls()) {
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.querySelector('svg[data-variant="filled"]')).not.toBeNull();
    expect(control.querySelector(".lucide-loader-circle")).toBeNull();
    expect(control.disabled).toBe(false);
  }
  const completed: UnifiedTask = { ...task, completed: true, status: "completed",
    statusMutation: { operationId: 8, state: "confirmed", targetStatus: "completed" } };
  await act(async () => resolveWrite(completed));
  expect(controls().every(control => control.getAttribute("aria-busy") === "false" && !control.disabled)).toBe(true);
  await act(async () => controls()[1].click());
  for (const control of controls()) {
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-busy")).toBe("true");
    expect(control.querySelector(".lucide-circle")).not.toBeNull();
  }
  // An offline intent remains translucent after the native call returns.
  await act(async () => resolveWrite({ ...completed,
    statusMutation: { operationId: 9, state: "pending", targetStatus: "open" } }));
  expect(controls().every(control => control.getAttribute("aria-busy") === "true" && control.getAttribute("aria-checked") === "false")).toBe(true);
  expect(host!.textContent).not.toContain("待同步");
  invokeMock.mockResolvedValue({ tasks: [{ ...task, statusMutation: { operationId: 9, state: "confirmed", targetStatus: "open" } }], syncReviews: [] });
  await act(async () => refreshTasks());
  expect(controls().every(control => control.getAttribute("aria-busy") === "false" && control.getAttribute("aria-checked") === "false" && !control.disabled)).toBe(true);
});

it("can reverse an in-flight target from either control and ignores the older displayed state", async () => {
  await mount(task);
  const writes: Array<{ resolve: (saved: UnifiedTask) => void; status: string }> = [];
  invokeMock.mockImplementation((command, args) => command === "set_unified_task_status"
    ? new Promise<UnifiedTask>(resolve => writes.push({ resolve, status: args.status })) : undefined);
  const controls = () => [...host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")];
  await act(async () => controls()[1].click());
  await act(async () => controls()[0].click());
  expect(writes.map(write => write.status)).toEqual(["completed"]);
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && !control.disabled)).toBe(true);
  await act(async () => writes[0].resolve({ ...task, completed: true, status: "completed" }));
  expect(writes.map(write => write.status)).toEqual(["completed", "open"]);
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && control.getAttribute("aria-busy") === "true")).toBe(true);
  await act(async () => writes[1].resolve(task));
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && control.getAttribute("aria-busy") === "false" && !control.disabled)).toBe(true);
});

it("restores the confirmed icon and enables the control after a rejected change", async () => {
  await mount(task);
  let rejectWrite!: (reason: Error) => void;
  invokeMock.mockImplementation(() => new Promise((_, reject) => { rejectWrite = reject; }));
  await act(async () => host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")[1].click());
  expect(host!.querySelector('[aria-checked="true"]')).not.toBeNull();
  await act(async () => rejectWrite(new Error("来源拒绝写入")));
  for (const control of host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")) {
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.getAttribute("aria-busy")).toBe("false");
    expect(control.disabled).toBe(false);
  }
});
