// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanPanel } from "./TagContentScanPanel";
import { resetCodexSuiteForTests } from "./CodexSuite";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root, stale: boolean;
const snapshot = () => ({ run: { runId: "run-1", tag: "focus", version: 2, status: "active", stale, blockers: stale ? ["定义已变化"] : [],
  totalEntities: 60, maxEntities: 30, maxChars: 15000, entitiesRead: 30, charsRead: 15000, remainingEntities: 0, remainingChars: 0,
  counts: { unread: 30, read: 5, recorded: 25, already_tagged: 0, unavailable: 0 }, decisionCounts: { recommend_add: 10, related_only: 5, out_of_scope: 5, insufficient_evidence: 5 } }, budgetHistory: [] });
const change = { runId: "run-1", expectedVersion: 2, addEntities: 30, addChars: 15000,
  before: { maxEntities: 30, maxChars: 15000 }, after: { maxEntities: 60, maxChars: 30000 } };
beforeEach(() => {
  resetCodexSuiteForTests();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); stale = false;
  invoke.mockReset().mockImplementation(async (command: string, { args }: { args: { action: string } }) => {
    if (command === "model_runtime") {
      if (args.action === "models") return { models: [] };
      return { settings: { model: "", reasoningEffort: "", fast: false, maxConcurrent: 2 }, jobs: [], revision: 1 };
    }
    if (args.action === "definition_models") return { models: [] };
    if (args.action === "scan_generate") return { ...snapshot(), submitted: [], unjudged: [], errors: [], pauseReason: "预算已用尽", coverage: "范围保留", newEntitiesRead: 0, newCharsRead: 0 };
    if (args.action === "scan_status") return snapshot();
    if (args.action === "scan_preview_budget") return { change, confirmationToken: "token" };
    if (args.action === "scan_apply_budget") return { ...snapshot(), run: { ...snapshot().run, version: 3, maxChars: 30000, maxEntities: 60, remainingEntities: 30, remainingChars: 15000 }, budgetHistory: [{ change }] };
    throw Error("Unexpected action");
  });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetCodexSuiteForTests(); });
const render = () => act(async () => root.render(<TagContentScanPanel tagId="focus" />));
const open = () => act(async () => { const d = host.querySelector("details")!; d.open = true; d.dispatchEvent(new Event("toggle")); });
const button = (s: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === s);
const click = (s: string) => act(async () => { expect(button(s)).toBeTruthy(); expect(button(s)!.disabled).toBe(false); button(s)!.click(); });

it("loads only on expansion and requires preview then a separate confirmation", async () => {
  await render(); expect(invoke).not.toHaveBeenCalled(); await open();
  expect(host.textContent).toContain("不是批准数量");
  expect(host.textContent).toContain("排除跳过（未分析）");
  expect(button("确认追加预算")).toBeUndefined();
  await click("预览预算追加");
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "scan_apply_budget")).toBe(false);
  await click("确认追加预算");
  const applied = invoke.mock.calls.find(([, p]) => p.args.action === "scan_apply_budget")![1].args;
  expect(applied).toMatchObject({ confirmationToken: "token", requestId: "budget-token", expectedVersion: 2, addChars: 15000 });
  expect(host.textContent).toContain("预算已追加");
  expect(host.textContent).toContain("最近 1 次预算追加");
});

it("shows excluded items separately from recorded decisions", async () => {
  invoke.mockResolvedValueOnce({ ...snapshot(), run: { ...snapshot().run, counts: { ...snapshot().run.counts, excluded: 4 } } });
  await render(); await open();
  const label = Array.from(host.querySelectorAll("dt")).find(e => e.textContent === "排除跳过（未分析）");
  expect(label?.nextElementSibling?.textContent).toBe("4");
  expect(host.textContent).toContain("不是批准数量");
});

it("does not expose budget editing for stale tasks", async () => {
  stale = true; await render(); await open();
  expect(host.textContent).toContain("仅可查看");
  expect(button("预览预算追加")).toBeUndefined();
  expect(button("复制继续任务")).toBeUndefined();
});

it("discards rejected confirmation and requires fresh status before another attempt", async () => {
  await render(); await open(); await click("预览预算追加");
  invoke.mockRejectedValueOnce(new Error("任务进度已变化"));
  await click("确认追加预算");
  expect(host.textContent).toContain("勿重复追加");
  expect(button("确认追加预算")).toBeUndefined();
  await click("刷新进度"); expect(button("预览预算追加")).toBeTruthy();
});

it("cancel does not change budget and one-click continuation pins the exact run", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await render(); await open(); await click("预览预算追加"); await click("取消"); await click("用模型 继续逐篇检查");
  expect(invoke.mock.calls.some(([, p]) => p.args.action === "scan_apply_budget")).toBe(false);
  expect(invoke.mock.calls.find(([, p]) => p.args.action === "scan_generate")?.[1].args.runId).toBe("run-1");
  expect(writeText).not.toHaveBeenCalled();
});

it("selects an older task and refreshes that exact task without starting one", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    if (payload.args.action === "scan_history") return { runs: [{ runId: "older-run", status: "active", entitiesRead: 2, charsRead: 100 }], nextCursor: null };
    if (payload.args.action === "scan_status" && payload.args.runId) return { ...snapshot(), run: { ...snapshot().run, runId: payload.args.runId } };
    return base(command, payload);
  });
  await render(); await open(); await click("查看历史任务");
  const old = Array.from(host.querySelectorAll("button")).find(b => b.textContent?.startsWith("older-run"))!;
  await act(async () => old.click());
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_status", tag: "focus", runId: "older-run" } });
  await click("刷新进度");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_status", tag: "focus", runId: "older-run" } });
  await click("返回最近任务");
  expect(invoke).toHaveBeenCalledWith("tag_assignment", { args: { action: "scan_status", tag: "focus" } });
});
