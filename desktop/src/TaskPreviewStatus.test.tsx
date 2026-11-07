// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { UnifiedTaskProvider, useUnifiedTasks } from "./UnifiedTaskData";
import { usePreviewController } from "./usePreviewController";
import type { SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

it.each(["task", "dida_task", "document"])("retains %s sidebar content until a confirmed shared status refresh arrives", async contentType => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const task: UnifiedTask = {
    id: "preview-task", provider: "dida365", libraryId: "preview-library", libraryName: "Fixture",
    sourceId: "preview-source", documentId: "preview-source", title: "Owned preview task", documentTitle: "Owned preview task",
    status: "open", completed: false, parentTaskId: "", parentPageId: "", isAllDay: false, path: "", depth: 0,
    isProject: false, linkedProviders: [], syncState: "unlinked",
  };
  const selected: SearchResult = {
    id: "preview-result", entityKey: "task:dida365:preview-library:preview-source", provider: "dida365",
    libraryId: task.libraryId, libraryName: "Fixture", spaceId: task.libraryId, spaceName: "Fixture",
    documentId: task.documentId, title: task.title, contentType, sourceType: "dida_task", taskStatus: 0,
    path: "", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
  };
  let resolvePreview!: (value: string) => void;
  const nextPreview = new Promise<string>(resolve => { resolvePreview = resolve; });
  let refreshDelayed = false;
  invoke.mockReset();
  invoke.mockImplementation(async command => {
    if (command === "list_unified_tasks") return { tasks: [task], syncReviews: [] };
    if (command === "local_document") return refreshDelayed ? nextPreview : "# Owned preview task\n\nOriginal content";
    if (command === "set_unified_task_status") return { ...task, status: "completed", completed: true,
      completedAt: "2026-10-14T10:00:00+08:00", statusMutation: { operationId: 9, state: "confirmed", targetStatus: "completed" } };
    throw new Error(`Unexpected command ${command}`);
  });
  function Preview() {
    const shared = useUnifiedTasks();
    const preview = usePreviewController({ selected, results: [selected], selectedIndex: 0,
      selectedMatchTerms: [], showPreviewPane: true, showOperationStatus: vi.fn() });
    return <><div data-preview-loading={String(preview.previewLoading)}>{preview.preview}</div>
      <button onClick={() => void shared.setTaskCompleted(task, true)}>Complete</button>
      <output>{shared.dashboard.tasks[0]?.status}</output></>;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<UnifiedTaskProvider><Preview /></UnifiedTaskProvider>));
    expect(container.querySelector("[data-preview-loading]")?.textContent).toContain("Original content");
    refreshDelayed = true;
    await act(async () => container.querySelector("button")!.click());
    expect(container.querySelector("output")?.textContent).toBe("completed");
    expect(container.querySelector("[data-preview-loading]")?.getAttribute("data-preview-loading")).toBe("false");
    expect(container.querySelector("[data-preview-loading]")?.textContent).toContain("Original content");
    await act(async () => resolvePreview("# Owned preview task\n\nConfirmed completed content"));
    expect(container.querySelector("[data-preview-loading]")?.textContent).toContain("Confirmed completed content");
    expect(invoke.mock.calls.filter(([command]) => command === "set_unified_task_status")).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
