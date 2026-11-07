// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
import { UnifiedTaskProvider, useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl } from "./TaskStatusControl";
import { taskSearchResult } from "./TaskWorkspaceResult";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { SearchResult } from "./SearchTypes";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

const original: UnifiedTask = {
  id: "hub-task", provider: "dida365", libraryId: "dida-account", libraryName: "滴答清单", sourceId: "dida-task",
  documentId: "dida-task", documentTitle: "收件箱", title: "Search task", status: "open", completed: false,
  parentTaskId: "", parentPageId: "", isAllDay: false, path: "收件箱", depth: 0, isProject: false,
  linkedProviders: ["dida365"], syncState: "unlinked",
};
const result: SearchResult = { ...taskSearchResult(original), id: "search-hit", contentType: "dida_task", taskStatus: 0 };
const previewProps: PreviewPaneProps = {
  selected: result, canGoBack: false, canGoForward: false, previewPinned: false,
  onNavigatePreviewHistory: vi.fn(), onTogglePreviewPinned: vi.fn(), selectedMatchTerms: [], previewMatchCount: 0,
  previewMatchIndex: 0, copiedResultId: "", spaces: [], pdfPreview: null, ocrImagePreview: null, previewLoading: false,
  previewMarkdown: "**状态：** 未完成", renderedPreviewMarkdown: <p>Original task content</p>, onOpenLink: vi.fn(),
  previewCard: createRef<HTMLElement>(), startWindowDrag: vi.fn(), onCloseMobilePreview: vi.fn(),
  setPdfPreviewPage: vi.fn(), navigatePreviewMatch: vi.fn(), copySelectedLink: vi.fn(), openSelectedResult: vi.fn(),
  providerName: () => "滴答清单",
};
let root: Root | undefined;
let host: HTMLDivElement | undefined;

async function mount(task = original, selected = result) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  invoke.mockReset();
  invoke.mockImplementation(async command => command === "list_unified_tasks" ? { tasks: [task], syncReviews: [] } : undefined);
  function TaskRow() {
    const shared = useUnifiedTasks();
    const current = shared.dashboard.tasks[0];
    return current ? <div data-task-row><TaskStatusControl task={current} busy={shared.taskBusyIds.has(current.id)}
      pendingStatus={shared.taskStatusTargets.get(current.id)} onChange={(task, completed) => { void shared.setTaskCompleted(task, completed); }}/></div> : null;
  }
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<UnifiedTaskProvider><TaskRow/><PreviewPane {...previewProps} selected={selected}/></UnifiedTaskProvider>));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove(); root = undefined; host = undefined;
});

it.each(["dida_task", "document"])("lets %s search previews reverse a pending status using the shared latest target", async contentType => {
  await mount(original, { ...result, contentType });
  const writes: Array<{ resolve: (task: UnifiedTask) => void; status: string }> = [];
  invoke.mockImplementation((command, args) => command === "set_unified_task_status"
    ? new Promise<UnifiedTask>(resolve => writes.push({ resolve, status: args.status })) : undefined);
  const previewControl = () => host!.querySelector<HTMLButtonElement>(".preview-heading [role=checkbox]")!;
  const controls = () => [...host!.querySelectorAll<HTMLButtonElement>("[role=checkbox]")];
  expect(previewControl()).not.toBeNull();
  expect(host!.querySelector(".preview-task-status")).toBeNull();
  await act(async () => previewControl().click());
  expect(controls().every(control => control.getAttribute("aria-checked") === "true" && control.getAttribute("data-unsynced") === "true" && !control.disabled)).toBe(true);
  await act(async () => previewControl().click());
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && !control.disabled)).toBe(true);
  expect(writes.map(write => write.status)).toEqual(["completed"]);
  await act(async () => writes[0].resolve({ ...original, status: "completed", completed: true }));
  expect(writes.map(write => write.status)).toEqual(["completed", "open"]);
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && control.getAttribute("aria-busy") === "true")).toBe(true);
  await act(async () => writes[1].resolve(original));
  expect(controls().every(control => control.getAttribute("aria-checked") === "false" && control.getAttribute("data-unsynced") === "false")).toBe(true);
  expect(host!.textContent).toContain("Original task content");
  expect(host!.textContent).not.toContain("待同步");
});

it("uses confirmed shared state when cached preview markdown still contains the old status", async () => {
  await mount({ ...original, status: "completed", completed: true });
  expect(host!.querySelector(".preview-heading [role=checkbox]")?.getAttribute("aria-checked")).toBe("true");
  expect(host!.querySelector(".preview-task-status")).toBeNull();
  expect(invoke.mock.calls.filter(([command]) => command === "list_unified_tasks")).toHaveLength(1);
});

it("edits a linked Dida search alias through the same primary task identity as the task page", async () => {
  const primary: UnifiedTask = { ...original, provider: "craft", libraryId: "craft-library", sourceId: "craft-block",
    documentId: "craft-page", syncState: "linked", linkedProviders: ["craft", "dida365"],
    sourceRefs: [{ provider: "craft", libraryId: "craft-library", documentId: "craft-page", sourceId: "craft-block" },
      { provider: "dida365", libraryId: original.libraryId, documentId: original.documentId, sourceId: original.sourceId }] };
  await mount(primary);
  invoke.mockImplementation(async command => command === "set_unified_task_status" ? { ...primary, status: "completed", completed: true } : undefined);
  await act(async () => host!.querySelector<HTMLButtonElement>(".preview-heading [role=checkbox]")!.click());
  expect(invoke).toHaveBeenCalledWith("set_unified_task_status", expect.objectContaining({ taskId: primary.id,
    expectedLibraryId: "craft-library", expectedDocumentId: "craft-page", expectedSourceId: "craft-block", status: "completed" }));
  expect([...host!.querySelectorAll("[role=checkbox]")].every(control => control.getAttribute("aria-checked") === "true")).toBe(true);
});

it("keeps blocked task previews read only using the shared capability check", async () => {
  await mount({ ...original, statusWriteBlockedReason: "重复任务需在滴答中操作" });
  const control = host!.querySelector<HTMLButtonElement>(".preview-heading [role=checkbox]")!;
  expect(control.disabled).toBe(true);
  expect(control.title).toBe("重复任务需在滴答中操作");
  await act(async () => control.click());
  expect(invoke.mock.calls.some(([command]) => command === "set_unified_task_status")).toBe(false);
});

it("edits real indexed Craft task blocks while ordinary markdown sections keep their plain preview title", async () => {
  const craft: UnifiedTask = { ...original, provider: "craft", libraryId: "craft-library", sourceId: "craft-block", documentId: "craft-page" };
  const indexed = { ...taskSearchResult(craft), contentType: "markdown_section", sourceType: "craft_page" };
  await mount(craft, indexed);
  invoke.mockImplementation(async command => command === "set_unified_task_status" ? { ...craft, status: "completed", completed: true } : undefined);
  await act(async () => host!.querySelector<HTMLButtonElement>(".preview-heading [role=checkbox]")!.click());
  expect(invoke).toHaveBeenCalledWith("set_unified_task_status", expect.objectContaining({ expectedSourceId: "craft-block", status: "completed" }));
  await act(async () => root!.render(<UnifiedTaskProvider><PreviewPane {...previewProps}
    selected={{ ...indexed, blockId: "ordinary-heading-block", id: "other-block-hit" }}/></UnifiedTaskProvider>));
  expect(host!.querySelector(".preview-heading [role=checkbox]")).toBeNull();
  expect(host!.querySelector(".preview-task-status")).toBeNull();
});
