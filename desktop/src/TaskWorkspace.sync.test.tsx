// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
import { TaskWorkspace } from "./TaskWorkspace";

let root: Root;
let container: HTMLDivElement;
let libraries: Array<{ libraryId: string; name: string }>;
const onStatusMessage = vi.fn();
const button = (label: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === label)!;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  onStatusMessage.mockReset();
  libraries = [{ libraryId: "dida-one", name: "个人账户" }];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "list_unified_tasks") return {
      tasks: [], total: 0, open: 0, completed: 0, craft: 0, dida365: 0, obsidian: 0, linked: 0,
      syncEnabled: false, backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0, syncReviews: [],
    };
    if (command === "preview_task_sync") return {
      craftUnlinked: 2, didaUnlinked: 0, linked: 1, exactTitleCandidates: 0,
      libraries, safeToEnable: libraries.length > 0, message: "新任务进入滴答收件箱，移动清单后保持关联。",
    };
    if (command === "configure_task_sync") return "已启用";
    if (command === "run_task_sync") return { message: "同步完成", failed: 0 };
    throw new Error(`Unexpected command: ${command}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<TaskWorkspace desktopSidebarVisible onStatusMessage={onStatusMessage} />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it("enables inbox sync for a single account without asking for a list", async () => {
  await act(async () => button("同步预览").click());
  const preview = container.querySelector(".task-sync-setup")!;
  expect(preview.textContent).toContain("默认：收件箱");
  expect(preview.querySelector("select")).toBeNull();
  expect(button("启用并同步").disabled).toBe(false);

  await act(async () => button("启用并同步").click());
  expect(invokeMock).toHaveBeenCalledWith("configure_task_sync", { enabled: true, didaLibraryId: "dida-one" });
  expect(invokeMock).toHaveBeenCalledWith("run_task_sync");
  expect(onStatusMessage).toHaveBeenCalledWith("同步完成");
});

it("lets multiple accounts choose their inbox and retains that choice on a new preview", async () => {
  libraries.push({ libraryId: "dida-two", name: "工作账户" });
  await act(async () => button("同步预览").click());
  const account = container.querySelector<HTMLSelectElement>('select[aria-label="滴答账户"]')!;
  expect([...account.options].map((option) => option.textContent)).toEqual(["个人账户", "工作账户"]);
  await act(async () => {
    account.value = "dida-two";
    account.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button("同步预览").click());
  expect(account.value).toBe("dida-two");

  await act(async () => button("启用并同步").click());
  expect(invokeMock).toHaveBeenCalledWith("configure_task_sync", { enabled: true, didaLibraryId: "dida-two" });
});

it("clears a disconnected account and blocks enabling without an inbox", async () => {
  await act(async () => button("同步预览").click());
  expect(button("启用并同步").disabled).toBe(false);
  libraries = [];
  await act(async () => button("同步预览").click());
  expect(button("启用并同步").disabled).toBe(true);
  await act(async () => button("启用并同步").click());
  expect(invokeMock).not.toHaveBeenCalledWith("configure_task_sync", expect.anything());
});

it("explains inbox creation and continued sync after moving a task", async () => {
  await act(async () => container.querySelector<HTMLButtonElement>('[title="同步状态与设置"]')!.click());
  const settings = container.querySelector('[aria-label="同步设置"]')!;
  expect(settings.textContent).toContain("新任务默认进入收件箱");
  expect(settings.textContent).toContain("移动到任意清单后保持关联");
  expect(settings.textContent).toContain("新增子任务跟随父任务所在清单");
});
