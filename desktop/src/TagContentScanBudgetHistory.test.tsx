// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanBudgetHistory } from "./TagContentScanBudgetHistory";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const entry = (id: string) => ({ requestId: id, createdAt: 100, change: { expectedVersion: 1, addEntities: 2, addChars: 30,
  before: { maxEntities: 30, maxChars: 100 }, after: { maxEntities: 32, maxChars: 130 } } });
const render = (id = "run-1") => act(async () => root.render(<TagContentScanBudgetHistory key={id} runId={id} recent={[entry("recent")]} />));
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockResolvedValue({ entries: [entry("a")], nextCursor: "cursor" }); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (s: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === s)!;
const click = (s: string) => act(async () => button(s).click());
it("loads on request only and paginates the exact run with deduplication", async () => {
  expect(invoke).not.toHaveBeenCalled(); expect(host.textContent).toContain("30 → 32");
  await click("查看完整预算历史");
  invoke.mockResolvedValueOnce({ entries: [entry("a"), entry("b")], nextCursor: null });
  await click("加载更早预算记录");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_budget_history", runId: "run-1", limit: 20, cursor: "cursor" } });
  expect(host.querySelectorAll("li")).toHaveLength(2); expect(host.textContent).toContain("已显示全部");
  await click("刷新预算历史");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_budget_history", runId: "run-1", limit: 20 } });
});
it("keeps entries and cursor on failure so the same page can be retried", async () => {
  await click("查看完整预算历史"); invoke.mockRejectedValueOnce(Error("offline"));
  await click("加载更早预算记录");
  expect(host.querySelectorAll("li")).toHaveLength(1); expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await click("加载更早预算记录");
  expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args.cursor).toBe("cursor");
});
it("ignores a late response from a previously selected task", async () => {
  let resolve!: (v: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click("查看完整预算历史"); await render("run-2");
  await act(async () => resolve({ entries: [entry("old")], nextCursor: null }));
  expect(host.textContent).toContain("最近 1 次"); expect(host.textContent).not.toContain("已显示全部");
  await click("查看完整预算历史"); expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args.runId).toBe("run-2");
});
