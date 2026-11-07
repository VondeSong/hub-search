// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TaskWorkspace } from "./TaskWorkspace";
import { UnifiedTaskProvider } from "./UnifiedTaskData";
import { resolveTaskResult, taskSearchResult } from "./TaskWorkspaceResult";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import type { LibrarySummary } from "./SearchTypes";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => undefined) }));

// Keep the actual shared renderer; prepare its first Vite transform before the
// interaction clock starts, rather than resolving that graph inside React act.
beforeAll(async () => { await import("./PreviewRenderer"); }, 30_000);

const task: UnifiedTask = {
  id: "first", provider: "dida365", libraryId: "account", libraryName: "滴答清单", sourceId: "source-first",
  documentId: "source-first", documentTitle: "收件箱", path: "收件箱", title: "前挡板减震垫",
  status: "open", completed: false, isAllDay: true, parentTaskId: "", parentPageId: "", depth: 0,
  isProject: false, linkedProviders: ["dida365"], syncState: "unlinked",
};
const second: UnifiedTask = { ...task, id: "second", sourceId: "source-second", documentId: "source-second", title: "热场报告" };
let root: Root | undefined;
let host: HTMLDivElement;
const heading = () => host.querySelector(".task-preview-pane .preview-heading h1")!;
const control = () => heading().querySelector<HTMLButtonElement>("[role=checkbox]")!;
const choose = async (title: string) => {
  const row = [...host.querySelectorAll<HTMLElement>(".task-row")].find(row => row.textContent?.includes(title))!;
  await act(async () => row.click());
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  HTMLElement.prototype.scrollTo = vi.fn();
  invoke.mockReset();
  invoke.mockImplementation(async (command, args) => {
    if (command === "list_unified_tasks") return { tasks: [task, second], syncReviews: [], total: 2, open: 2, completed: 0, craft: 0, dida365: 2, obsidian: 0, linked: 0 };
    if (command === "local_document") {
      const current = args.documentId === task.documentId ? task : second;
      return `# ${current.title}\n\n**清单：** 收件箱\n**状态：** 未完成\n**时区：** Asia/Shanghai\n**标签：** 工作、验证\n\n${current.title}的正文说明\n\n[原始附件](https://example.com/fixture.png)`;
    }
    if (command === "resolve_unified_task_search_result") return { resultId: "indexed-task", documentId: task.documentId, blockId: task.documentId, matchField: "heading" };
    return undefined;
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host.remove(); root = undefined;
});

it("maps journal and task entries to the same title, path and status as an indexed search task", async () => {
  const direct = taskSearchResult(task);
  const journal = await resolveTaskResult(task);
  for (const selected of [direct, journal]) {
    expect(selected.documentTitle).toBe(task.title);
    expect(selected.path).toBe("收件箱");
    expect(selected.taskStatus).toBe(0);
    expect(selected.matchTerms).toEqual([]);
  }
  expect(taskSearchResult({ ...task, completed: true, status: "completed" }).taskStatus).toBe(2);
  expect(taskSearchResult({ ...task, status: "abandoned" }).taskStatus).toBe(-1);
});

it("keeps distinct task identities when a source has no indexed result yet", async () => {
  invoke.mockResolvedValue({ resultId: "", documentId: task.documentId, blockId: task.documentId, matchField: "" });
  const selected = await resolveTaskResult(task);
  expect(selected.id).toBe(task.id);
  expect(selected.entityKey).toBe(task.id);
});

async function mount() {
  await act(async () => root!.render(<UnifiedTaskProvider><TaskWorkspace desktopSidebarVisible
    libraries={[{ id: task.libraryId, connected: true } as LibrarySummary]}/></UnifiedTaskProvider>));
  await choose(task.title);
  // Flush the real shared lazy markdown renderer, rather than replacing its output.
  await act(async () => { await import("./PreviewRenderer"); });
}

it("renders the search preview header and cleaned task body from the real task page", async () => {
  await mount();
  expect(heading().textContent).toBe(task.title);
  expect(heading().firstElementChild).toBe(control());
  expect(control().disabled).toBe(false);
  const body = host.querySelector(".task-preview-pane .preview-content")!;
  expect(body.querySelector("h1")).toBeNull();
  expect(body.textContent).toContain("工作");
  expect(body.textContent).toContain(`${task.title}的正文说明`);
  expect(body.textContent).toContain("原始附件");
  expect(body.textContent).not.toMatch(/清单：|状态：|Asia\/Shanghai|收件箱/);
  expect(host.querySelector('.task-preview-pane [aria-label="固定预览"]')).not.toBeNull();
  expect(host.querySelector('.task-preview-pane [aria-label="复制结果链接"]')).not.toBeNull();
});

it("shares latest-click status behavior while preserving the preview body", async () => {
  await mount();
  const writes: Array<{ status: string; resolve: (task: UnifiedTask) => void }> = [];
  const normal = invoke.getMockImplementation()!;
  invoke.mockImplementation((command, args) => command === "set_unified_task_status"
    ? new Promise<UnifiedTask>(resolve => writes.push({ status: args.status, resolve })) : normal(command, args));
  await act(async () => control().click());
  expect(control().getAttribute("aria-checked")).toBe("true");
  expect(control().disabled).toBe(false);
  await act(async () => control().click());
  expect(control().getAttribute("aria-checked")).toBe("false");
  await act(async () => writes[0].resolve({ ...task, status: "completed", completed: true }));
  expect(writes.map(write => write.status)).toEqual(["completed", "open"]);
  await act(async () => writes[1].resolve(task));
  expect(control().getAttribute("data-unsynced")).toBe("false");
  expect(host.querySelector(".task-preview-pane .preview-content")?.textContent).toContain("正文说明");
});

it("supports preview history and pinning through the shared search toolbar", async () => {
  await mount();
  await choose(second.title);
  expect(heading().textContent).toBe(second.title);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true })));
  expect(heading().textContent).toBe(task.title);
  await act(async () => host.querySelector<HTMLButtonElement>('.task-preview-pane [aria-label="固定预览"]')!.click());
  await choose(second.title);
  expect(heading().textContent).toBe(task.title);
  await act(async () => host.querySelector<HTMLButtonElement>('.task-preview-pane [aria-label="解除固定预览"]')!.click());
  await choose(second.title);
  expect(heading().textContent).toBe(second.title);
});
