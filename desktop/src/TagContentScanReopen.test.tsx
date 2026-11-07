// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanReopen } from "./TagContentScanReopen";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const reopened = vi.fn();
const render = (runId = "run") => act(async () => root.render(<TagContentScanReopen key={runId} runId={runId} onReopened={reopened} />));
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); reopened.mockReset();
  invoke.mockReset().mockImplementation(async (_cmd, { args }) => {
    if (args.action === "scan_reopen_items") return { version: 3, items: [{ ordinal: 1, title: "Note", state: "recorded" }], nextAfterOrdinal: null };
    if (args.action === "scan_preview_reopen") return { confirmationToken: "token", change: { ordinal: 1, expectedVersion: 3, reason: "正文已变化", beforeRunStatus: "completed", before: { title: "Note", proposalId: "p" }, entitiesRead: 1, charsRead: 20, maxEntities: 30, maxChars: 100 } };
    return { run: { version: 4 } };
  }); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (s: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === s)!;
const click = (s: string) => act(async () => button(s).click());
it("loads only on demand and requires separate preview and confirmation", async () => {
  expect(invoke).not.toHaveBeenCalled(); await click("刷新可检查项"); await click("检查是否可重开");
  expect(reopened).not.toHaveBeenCalled(); expect(host.textContent).toContain("原任务将恢复");
  await act(async () => { button("确认只重开此项").click(); button("确认只重开此项").click(); });
  expect(invoke).toHaveBeenCalledTimes(3);
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_apply_reopen", runId: "run", ordinal: 1, expectedVersion: 3, confirmationToken: "token", requestId: "reopen-token" } });
  expect(reopened).toHaveBeenCalledTimes(1);
});
it("cancellation never applies and stale confirmation is discarded", async () => {
  await click("刷新可检查项"); await click("检查是否可重开"); await click("取消重开");
  expect(invoke).toHaveBeenCalledTimes(2);
  await click("检查是否可重开"); invoke.mockRejectedValueOnce(Error("预览已失效")); await click("确认只重开此项");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("先刷新任务进度"); expect(reopened).not.toHaveBeenCalled();
  expect(button("确认只重开此项")).toBeUndefined();
});
it("ignores a previous task response after switching", async () => {
  let resolve!: (v: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click("刷新可检查项"); await render("other");
  await act(async () => resolve({ items: [{ ordinal: 9, title: "Old note" }], version: 3, nextAfterOrdinal: null }));
  expect(host.textContent).not.toContain("Old note");
});

it("checks a batch without reopening and still requires separate confirmation", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => payload.args.action === "scan_check_save"
    ? { checked: true, version: 3, items: [{ ordinal: 1, title: "Changed", state: "recorded", assessment: { code: "evidence_changed", reason: "正文变化", canReopen: true } }, { ordinal: 2, title: "Same", state: "recorded", assessment: { code: "evidence_unchanged", reason: "正文版本未变", canReopen: false } }], nextCursor: "cursor" }
    : base(command, payload));
  await click("分批检查失效项");
  expect(host.textContent).toContain("本次已核对 2 项，其中 1 项可预览重开");
  expect(host.querySelectorAll('[aria-label^="检查重开第"]')).toHaveLength(1);
  expect(reopened).not.toHaveBeenCalled();
  await click("检查下一批"); expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_check_save", runId: "run", cursor: "cursor", checkpointId: undefined, limit: 10, requestId: expect.any(String) } });
  await click("检查是否可重开"); expect(reopened).not.toHaveBeenCalled();
  await click("确认只重开此项"); expect(reopened).toHaveBeenCalledTimes(1);
});

it("retains batch results on failure and lets the user restart the check", async () => {
  invoke.mockResolvedValueOnce({ checked: true, version: 3, items: [{ ordinal: 1, title: "Result", state: "recorded", assessment: { code: "evidence_unchanged", reason: "正文版本未变", canReopen: false } }], nextCursor: "cursor" });
  await click("分批检查失效项"); invoke.mockRejectedValueOnce(Error("进度已变化，请从头刷新")); await click("检查下一批");
  expect(host.textContent).toContain("Result"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("从头刷新");
  invoke.mockResolvedValueOnce({ checked: true, version: 4, items: [], nextCursor: null }); await click("分批检查失效项");
  expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args.cursor).toBeUndefined(); expect(host.textContent).toContain("已检查至清单末尾");
});

it("shows context-only changes but never offers unknown context for reopening", async () => {
  invoke.mockResolvedValueOnce({ checked: true, version: 3, items: [
    { ordinal: 1, title: "Context changed", assessment: { code: "context_changed", reason: "标签上下文已变化（正文证据未变）", canReopen: true } },
    { ordinal: 2, title: "Legacy", assessment: { code: "context_unknown", reason: "缺少有效历史标签上下文，无法核验", canReopen: false } }
  ], nextCursor: null });
  await click("分批检查失效项");
  expect(host.textContent).toContain("标签上下文已变化（正文证据未变）");
  expect(host.textContent).toContain("缺少有效历史标签上下文，无法核验");
  expect(host.querySelectorAll('[aria-label^="检查重开第"]')).toHaveLength(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(reopened).not.toHaveBeenCalled();
});
it("restores a saved page on demand and resumes its exact checkpoint", async () => {
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockResolvedValueOnce({ saved: true, checked: true, checkpointId: 7, version: 3, items: [], nextCursor: "saved-cursor" });
  await click("恢复上次检查");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_check_saved", runId: "run" } });
  invoke.mockResolvedValueOnce({ saved: true, checked: true, checkpointId: 8, version: 3, items: [], nextCursor: null });
  await click("检查下一批");
  expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args).toMatchObject({ action: "scan_check_save", checkpointId: 7, cursor: "saved-cursor" });
  expect(reopened).not.toHaveBeenCalled();
});
it("keeps stale checkpoints historical without claiming completion", async () => {
  invoke.mockResolvedValueOnce({ saved: true, checked: true, checkpointStale: true, version: 3, items: [{ ordinal: 1, title: "Old", assessment: { canReopen: true, reason: "Old reason" } }], nextCursor: null });
  await click("恢复上次检查");
  expect(button("检查下一批")).toBeUndefined();
  expect(button("检查是否可重开")).toBeUndefined();
  expect(host.textContent).toContain("历史检查仅供参考");
  expect(host.textContent).not.toContain("已检查至清单末尾");
});
