// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AgentConversationHistory, type HistoryChange, type WorkSummary } from "./AgentConversationHistory";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
type Props = ComponentProps<typeof AgentConversationHistory>;
const mounts: { root: Root; host: HTMLDivElement }[] = [];
const defaults: Props = { works: [], disabled: false, more: false, loading: false, error: "", states: {},
  onOpen: () => {}, onChange: async () => {}, onMore: () => {}, onClose: () => {} };

function mount() {
  const host = document.createElement("div"), root = createRoot(host);
  document.body.append(host); mounts.push({ root, host });
  return { host, root, render: (props: Partial<Props> = {}, onUnhandledKey?: () => void) => act(async () => root.render(<div onKeyDown={onUnhandledKey}><AgentConversationHistory {...defaults} {...props} /></div>)) };
}
function button(host: ParentNode, label: string) {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.getAttribute("aria-label") === label || node.textContent === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function click(host: ParentNode, label: string) { await act(async () => button(host, label).click()); }
async function actions(host: ParentNode, title: string) { await click(host, `更多对话操作 ${title}`); }
async function flushFocus() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 1)); }); }
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
afterEach(async () => {
  for (const { root, host } of mounts.splice(0)) { await act(async () => root.unmount()); host.remove(); }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("shows all loaded history in date groups, with fixed entries appearing only once and older pages requested explicitly", async () => {
  const { host, render } = mount(), more = vi.fn(), open = vi.fn();
  const now = new Date(2026, 10, 7, 12).getTime();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const works: WorkSummary[] = [
    { id: "fixed", goal: "固定的对话", state: "completed", updatedAt: now, pinned: true },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `today-${i}`, goal: `今天的对话 ${i}`, state: "completed", updatedAt: now - i * 3_600_000 })),
    { id: "week", goal: "一周前的对话", state: "completed", updatedAt: new Date(2026, 9, 30).getTime() },
    { id: "old", goal: "很早的对话", state: "completed", updatedAt: new Date(2026, 2, 8).getTime() },
  ];
  await render({ works, currentId: "today-0", more: true, onMore: more, onOpen: open });
  expect([...host.querySelectorAll(".agent-history-group > h3")].map(node => node.textContent)).toEqual(["已固定", "今天", "过去 30 天", "更早"]);
  expect(host.querySelectorAll(".agent-history-row")).toHaveLength(8);
  expect(host.querySelectorAll('[data-work-id="fixed"]')).toHaveLength(1);
  expect(host.querySelector('[aria-current="true"]')?.getAttribute("data-work-id")).toBe("today-0");
  expect(host.querySelector(".agent-history-row small")).toBeNull();
  await click(host, "加载更多对话"); expect(more).toHaveBeenCalledOnce();
  await click(host, "打开对话 很早的对话"); expect(open).toHaveBeenCalledWith(works[7]);
  vi.restoreAllMocks();
});

it("requests host title search instead of filtering just the loaded page and keeps search keyboard focus", async () => {
  const { host, render } = mount(), query = vi.fn(), escaped = vi.fn();
  const works = [{ id: "loaded", goal: "当前已加载的对话", state: "completed" }];
  await render({ works, query: "", onQueryChange: query }, escaped);
  await click(host, "搜索对话标题");
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  expect(document.activeElement).toBe(input);
  await type(input, "更早的标题");
  expect(query).toHaveBeenLastCalledWith("更早的标题");
  expect(host.querySelectorAll(".agent-history-row")).toHaveLength(1);
  await render({ works: [{ id: "remote-page", goal: "更早的标题", state: "completed" }], query: "更早的标题", onQueryChange: query }, escaped);
  expect(host.textContent).toContain("更早的标题");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(query).toHaveBeenLastCalledWith(""); expect(escaped).not.toHaveBeenCalled();
  await render({ works, query: "", onQueryChange: query }, escaped);
  expect(host.querySelector("input")).toBeNull();
  expect(document.activeElement).toBe(button(host, "搜索对话标题"));
});

it("archives and restores through a separate durable preference while retaining pin state", async () => {
  const { host, root } = mount(), change = vi.fn();
  function History() {
    const [items, setItems] = useState<WorkSummary[]>([{ id: "chat", goal: "保留的对话", state: "completed", pinned: true, archived: false }]);
    const [archived, setArchived] = useState(false);
    return <AgentConversationHistory {...defaults} works={items.filter(item => !!item.archived === archived)} archived={archived} onArchivedChange={setArchived}
      onChange={async (work, update) => { change(work.id, update); setItems(current => current.map(item => item.id === work.id ? { ...item, ...update } : item)); }} />;
  }
  await act(async () => root.render(<History />));
  await actions(host, "保留的对话"); await click(host, "归档对话 保留的对话");
  expect(change).toHaveBeenLastCalledWith("chat", { archived: true });
  expect(host.querySelectorAll(".agent-history-row")).toHaveLength(0);
  expect(host.textContent).toContain("已归档对话");
  await click(host, "已归档的对话");
  expect(host.querySelector('[aria-label="已归档的对话"]')).not.toBeNull();
  expect(host.querySelectorAll(".agent-history-row")).toHaveLength(1);
  expect(host.querySelector('[aria-label="已固定"]')).toBeNull();
  await actions(host, "保留的对话"); await click(host, "恢复对话 保留的对话");
  expect(change).toHaveBeenLastCalledWith("chat", { archived: false });
  await click(host, "返回对话历史");
  expect(host.querySelector('[aria-label="已固定"] .agent-history-title')?.textContent).toBe("保留的对话");
  expect(change.mock.calls.every(([, update]) => !("deleted" in update))).toBe(true);
});

it("keeps pin, delete and undo actions separate and returns focus after menu operations", async () => {
  const { host, render } = mount(), change = vi.fn(async () => {}), open = vi.fn();
  const work = { id: "a", goal: "需要保留的标题", state: "completed", pinned: false };
  await render({ works: [work], onChange: change, onOpen: open });
  await actions(host, work.goal);
  expect(document.activeElement?.getAttribute("aria-label")).toBe(`置顶对话 ${work.goal}`);
  await click(host, `置顶对话 ${work.goal}`); expect(change).toHaveBeenLastCalledWith(work, { pinned: true });
  await flushFocus(); expect(document.activeElement).toBe(button(host, `更多对话操作 ${work.goal}`));
  await actions(host, work.goal); await click(host, `删除对话 ${work.goal}`);
  expect(change).toHaveBeenLastCalledWith(work, { deleted: true }); expect(open).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain("确认删除");
  await flushFocus(); expect(document.activeElement).toBe(button(host, "撤销"));
  await click(host, "撤销"); expect(change).toHaveBeenLastCalledWith(work, { deleted: false });
  expect(host.querySelector(".agent-history-undo")).toBeNull();
  await flushFocus(); expect(document.activeElement).toBe(button(host, "关闭对话历史"));
});

it("supports menu keyboard navigation and Escape closes only the row menu", async () => {
  const { host, render } = mount(), escaped = vi.fn();
  await render({ works: [{ id: "a", goal: "键盘操作", state: "completed" }] }, escaped);
  await actions(host, "键盘操作");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  expect(document.activeElement?.getAttribute("aria-label")).toBe("归档对话 键盘操作");
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(button(host, "更多对话操作 键盘操作"));
  expect(escaped).not.toHaveBeenCalled();
});

it("distinguishes loading, empty archive, no title matches and retryable errors", async () => {
  const { host, render } = mount(), retry = vi.fn();
  await render({ loading: true }); expect(host.textContent).toContain("正在读取历史对话"); expect(host.textContent).not.toContain("还没有历史对话");
  await render(); expect(host.textContent).toContain("还没有历史对话");
  await render({ archived: true }); expect(host.textContent).toContain("还没有已归档的对话");
  await render({ query: "搜索词" }); expect(host.textContent).toContain("没有找到匹配的对话");
  await render({ error: "读取失败", onRetry: retry }); expect(host.textContent).not.toContain("还没有历史对话");
  await click(host, "重新读取历史"); expect(retry).toHaveBeenCalledOnce();
});

it("does not offer undo when deletion fails and preserves the actionable menu", async () => {
  const { host, render } = mount(), open = vi.fn();
  await render({ works: [{ id: "a", goal: "保留这段对话", state: "completed" }], onOpen: open, onChange: async () => { throw Error("保存失败"); } });
  await actions(host, "保留这段对话"); await click(host, "删除对话 保留这段对话");
  expect(host.textContent).toContain("保存失败"); expect(host.querySelector(".agent-history-undo")).toBeNull();
  expect(host.querySelector('[role="menu"]')).not.toBeNull(); expect(open).not.toHaveBeenCalled();
});

it("supports successive deletions and undo in reverse order without conflating archive", async () => {
  const { host, render } = mount(), change = vi.fn(async (_work: WorkSummary, _change: HistoryChange) => {});
  const works = [{ id: "a", goal: "对话 A", state: "completed" }, { id: "b", goal: "对话 B", state: "completed" }];
  await render({ works, onChange: change });
  for (const work of works) { await actions(host, work.goal); await click(host, `删除对话 ${work.goal}`); }
  expect(host.textContent).toContain("已删除 2 段对话");
  await click(host, "撤销"); expect(change).toHaveBeenLastCalledWith(works[1], { deleted: false });
  await click(host, "撤销"); expect(change).toHaveBeenLastCalledWith(works[0], { deleted: false });
  expect(host.querySelector(".agent-history-undo")).toBeNull();
});

it("keeps deletion undo outside a closed history popover and restores focus to its trigger", async () => {
  const { host, root } = mount(), change = vi.fn(async () => {});
  const work = { id: "a", goal: "关闭后仍可撤销", state: "completed" };
  await act(async () => root.render(<div className="agent-panel"><details open><summary tabIndex={0}>历史入口</summary>
    <AgentConversationHistory {...defaults} works={[work]} onChange={change} />
  </details></div>));
  await actions(host, work.goal); await click(host, `删除对话 ${work.goal}`);
  const outer = host.querySelector("details")!;
  await act(async () => { outer.open = false; outer.dispatchEvent(new Event("toggle")); });
  expect(host.querySelector(".agent-panel > .agent-history-toast")).not.toBeNull();
  await click(host, "撤销"); await flushFocus();
  expect(change).toHaveBeenLastCalledWith(work, { deleted: false });
  expect(document.activeElement).toBe(outer.querySelector("summary"));
});
