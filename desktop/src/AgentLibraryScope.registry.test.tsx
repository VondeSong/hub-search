// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentLibraryScope, type AgentLibrary } from "./AgentLibraryScope";
import type { LibrarySummary } from "./SearchTypes";

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), handlers: new Set<() => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));

const library = (id: string, name: string, overrides: Partial<LibrarySummary> = {}): LibrarySummary => ({ id, name, provider: "craft", connected: true, documentCount: 12, excludedPaths: [], ...overrides });
let host: HTMLDivElement, root: Root, catalogue: LibrarySummary[];
const change = vi.fn();
function Harness({ initial = [], disabled = false }: { initial?: AgentLibrary[]; disabled?: boolean }) {
  const [selected, setSelected] = useState(initial);
  return <AgentLibraryScope selected={selected} disabled={disabled} onChange={items => { change(items); setSelected(items); }} />;
}
function checkbox(label: string) {
  const input = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(item => item.getAttribute("aria-label") === label);
  if (!input) throw new Error(`没有找到 ${label}`);
  return input;
}
function button(label: string) {
  const target = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.getAttribute("aria-label") === label || item.textContent === label);
  if (!target) throw new Error(`没有找到 ${label}`);
  return target;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  catalogue = [library("one", "库一"), library("two", "库二", { provider: "obsidian" })];
  native.invoke.mockReset().mockImplementation(async (command: string) => { if (command !== "list_libraries") throw new Error(`意外调用 ${command}`); return catalogue; });
  native.handlers.clear();
  native.listen.mockReset().mockImplementation(async (_event: string, handler: () => void) => { native.handlers.add(handler); return () => native.handlers.delete(handler); });
  change.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("selects explicit IDs for all libraries and does not automatically add newly registered ones", async () => {
  await act(async () => root.render(<Harness />));
  await act(async () => checkbox("选择全部资料库").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "one", name: "库一" }, { id: "two", name: "库二" }]);
  expect(checkbox("选择全部资料库").checked).toBe(true);
  change.mockClear(); catalogue = [...catalogue, library("new", "新资料库")];
  await act(async () => native.handlers.forEach(handler => handler()));
  expect(checkbox("允许查找 新资料库").checked).toBe(false);
  expect(checkbox("选择全部资料库").checked).toBe(false);
  expect(checkbox("选择全部资料库").indeterminate).toBe(true);
  expect(change).not.toHaveBeenCalled();
});

it("keeps offline cached libraries selectable and shows their actual provider and document count", async () => {
  catalogue = [library("offline", "离线笔记", { provider: "obsidian", connected: false, documentCount: 37 })];
  await act(async () => root.render(<Harness />));
  expect(host.textContent).toContain("Obsidian");
  expect(host.textContent).toContain("37 篇文档");
  expect(host.textContent).toContain("离线 · 可查找缓存");
  expect(checkbox("允许查找 离线笔记").disabled).toBe(false);
  await act(async () => checkbox("允许查找 离线笔记").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "offline", name: "离线笔记" }]);
  expect(native.invoke.mock.calls.every(call => call[0] === "list_libraries")).toBe(true);
});

it("filters by real library names or providers without changing what select-all authorizes", async () => {
  await act(async () => root.render(<Harness />));
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Obsidian");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll(".agent-library-choice")).toHaveLength(1);
  expect(host.querySelector(".agent-library-choice")?.textContent).toContain("库二");
  await act(async () => checkbox("选择全部资料库").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "one", name: "库一" }, { id: "two", name: "库二" }]);
});

it("refreshes a renamed library and retains a removed selected ID until explicit removal", async () => {
  await act(async () => root.render(<Harness initial={[{ id: "one", name: "库一" }, { id: "two", name: "库二" }]} />));
  catalogue = [library("one", "新的库名")];
  await act(async () => native.handlers.forEach(handler => handler()));
  expect(checkbox("允许查找 新的库名").checked).toBe(true);
  expect(host.querySelector('[aria-label="当前不可用的已选资料库"]')?.textContent).toContain("库二");
  expect(change).not.toHaveBeenCalled();
  await act(async () => button("移除不可用资料库 库二").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "one", name: "新的库名" }]);
});

it("preserves unavailable selections when toggling available libraries, and clears all only explicitly", async () => {
  catalogue = [library("one", "库一")];
  await act(async () => root.render(<Harness initial={[{ id: "gone", name: "旧资料" }]} />));
  await act(async () => checkbox("选择全部资料库").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "gone", name: "旧资料" }, { id: "one", name: "库一" }]);
  await act(async () => checkbox("选择全部资料库").click());
  expect(change).toHaveBeenLastCalledWith([{ id: "gone", name: "旧资料" }]);
  await act(async () => button("清除库范围").click());
  expect(change).toHaveBeenLastCalledWith([]);
});

it("shows a retry for a failed first read without treating selected libraries as removed", async () => {
  native.invoke.mockRejectedValueOnce(new Error("暂时无法读取"));
  await act(async () => root.render(<Harness initial={[{ id: "one", name: "库一" }]} />));
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("暂时无法读取");
  expect(host.querySelector('[aria-label="当前不可用的已选资料库"]')).toBeNull();
  await act(async () => button("重新读取").click());
  expect(checkbox("允许查找 库一").checked).toBe(true);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("locks every scope mutation while the conversation disallows changes", async () => {
  await act(async () => root.render(<Harness initial={[{ id: "gone", name: "旧资料" }]} disabled />));
  for (const input of host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    expect(input.disabled).toBe(true);
    await act(async () => input.click());
  }
  expect(button("移除不可用资料库 旧资料").disabled).toBe(true);
  expect(button("清除库范围").disabled).toBe(true);
  expect(change).not.toHaveBeenCalled();
});

it("uses the parent registry without starting another query or event subscription", async () => {
  const registry = { libraries: catalogue, loaded: true, loading: false, error: "", watchError: "", reload: vi.fn(async () => undefined) };
  await act(async () => root.render(<AgentLibraryScope selected={[]} disabled={false} onChange={change} registry={registry} />));
  expect(checkbox("允许查找 库一")).toBeTruthy();
  expect(native.invoke).not.toHaveBeenCalled();
  expect(native.listen).not.toHaveBeenCalled();
  await act(async () => button("刷新资料库").click());
  expect(registry.reload).toHaveBeenCalledTimes(1);
});
