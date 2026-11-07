// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("./PreviewRenderer", () => ({ PreviewRenderer: () => <p>Craft 正文保留</p> }));
import { TaskWorkspace } from "./TaskWorkspace";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

let root: Root;
let container: HTMLDivElement;
let task: UnifiedTask;
let syncEnabled: boolean;
let failResume: boolean;
let failRun: boolean;
let otherTasks: UnifiedTask[];
const onStatusMessage = vi.fn();
const resumeButton = () => container.querySelector<HTMLButtonElement>(".task-sync-resume button");
const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  HTMLElement.prototype.scrollTo = vi.fn();
  onStatusMessage.mockReset();
  syncEnabled = true;
  failResume = false;
  failRun = false;
  otherTasks = [];
  task = {
    id: "hub-page", provider: "craft", libraryId: "craft-main", libraryName: "Main",
    sourceId: "craft-project-page:PAGE-HUB", parentTaskId: "", parentPageId: "PAGE-HUB",
    documentId: "root", documentTitle: "Hub #项目", title: "Hub", completed: false,
    status: "open", isAllDay: true, path: "AI/使用AI", depth: 0, isProject: true,
    linkedProviders: ["craft"], syncState: "paused",
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_unified_tasks") return {
      tasks: [{ ...task }, ...otherTasks], total: 1 + otherTasks.length, open: 1 + otherTasks.filter(item => !item.completed).length,
      completed: otherTasks.filter(item => item.completed).length, craft: 1 + otherTasks.length, dida365: 0, obsidian: 0,
      linked: 0, syncEnabled, backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0, syncReviews: [],
    };
    if (command === "local_document") return "Craft 正文保留";
    if (command === "resume_craft_task_sync") {
      if (failResume) throw new Error("任务正在同步");
      task.syncState = "unlinked";
      return "已恢复项目同步；缺少的父任务会创建到收件箱";
    }
    if (command === "run_task_sync") {
      if (failRun) throw new Error("远端连接失败");
      return { message: "同步完成：项目父任务已创建", failed: 0 };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<TaskWorkspace desktopSidebarVisible onStatusMessage={onStatusMessage} />));
  await act(async () => container.querySelector<HTMLElement>(".task-row")!.click());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  HTMLElement.prototype.scrollTo = originalScrollTo;
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("explains the saved pause and restores only the selected source before the normal sync", async () => {
  expect(container.querySelector(".task-paused")?.getAttribute("title")).toContain("已停止同步到滴答");
  expect(container.querySelector(".task-sync-resume")?.textContent).toContain("现有子任务的关联和所在清单会保留");
  await act(async () => resumeButton()!.click());
  expect(invokeMock).toHaveBeenCalledWith("resume_craft_task_sync", {
    libraryId: "craft-main", sourceId: "craft-project-page:PAGE-HUB",
  });
  expect(invokeMock).toHaveBeenCalledWith("run_task_sync", { fullReconcile: false });
  const commands = invokeMock.mock.calls.map(call => call[0]);
  expect(commands.indexOf("resume_craft_task_sync")).toBeLessThan(commands.indexOf("run_task_sync"));
  expect(commands).not.toContain("exclude_task_from_dida");
  expect(commands).not.toContain("configure_task_sync");
  expect(resumeButton()).toBeNull();
});

it("keeps the pause actionable when recovery is blocked and reports the error in the status bar", async () => {
  failResume = true;
  await act(async () => resumeButton()!.click());
  expect(invokeMock).not.toHaveBeenCalledWith("run_task_sync", expect.anything());
  expect(onStatusMessage).toHaveBeenCalledWith(expect.stringContaining("恢复同步失败"), "error", 8_000);
  expect(resumeButton()!.disabled).toBe(false);
  expect(container.textContent).not.toContain("Error: 任务正在同步");
});

it("refreshes the restored rule after a sync failure so the old paused state does not stick", async () => {
  failRun = true;
  await act(async () => resumeButton()!.click());
  expect(onStatusMessage).toHaveBeenCalledWith(expect.stringContaining("同步规则已恢复，但本轮同步失败"), "error", 8_000);
  expect(resumeButton()).toBeNull();
});

it("does not silently enable global task sync when reversing one exclusion", async () => {
  syncEnabled = false;
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click());
  await act(async () => resumeButton()!.click());
  expect(invokeMock).not.toHaveBeenCalledWith("configure_task_sync", expect.anything());
  expect(invokeMock).not.toHaveBeenCalledWith("run_task_sync", expect.anything());
  expect(onStatusMessage).toHaveBeenCalledWith(expect.stringContaining("请先启用任务同步"), "warning", 8_000);
});

it("keeps the paused project visible with its real topology in the default list and when children are collapsed", async () => {
  otherTasks = Array.from({ length: 7 }, (_, index) => ({
    ...task, id: `child-${index}`, sourceId: `CHILD-${index}`, parentTaskId: task.sourceId,
    title: index === 0 ? "精简版搜索框，唤醒搜索框，搜索搜索" : `已完成的页面任务 ${index}`,
    isProject: false, depth: 1, completed: index !== 0,
    status: index === 0 ? "open" : "completed", syncState: "linked", linkedProviders: ["craft", "dida365"],
  }));
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="刷新"]')!.click());
  expect(container.querySelector(".task-row.project")?.textContent).toContain("Hub");
  expect(container.querySelector(".task-row.project .task-paused")?.textContent).toBe("已暂停");
  await act(async () => container.querySelector<HTMLButtonElement>(".task-source-chip.craft")!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="折叠Hub的子任务"]')!.click());
  expect(container.querySelector(".task-row.project")?.textContent).toContain("Hub");
  expect([...container.querySelectorAll(".task-row")].some(row => row.textContent?.includes("精简版搜索框"))).toBe(false);
  await act(async () => container.querySelector<HTMLElement>(".task-row.project")!.click());
  expect(resumeButton()).not.toBeNull();
  expect(container.querySelector(".task-sync-resume")?.textContent).toContain("所在清单会保留");
});
