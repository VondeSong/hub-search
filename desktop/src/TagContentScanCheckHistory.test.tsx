// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanCheckHistory } from "./TagContentScanCheckHistory";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const entry = (id: number) => ({ checkpointId: id, checkedAt: 1, version: 2, stale: false, reachedEndAtCheck: false, items: [{ ordinal: id, title: `Note${id}`, assessment: { reason: "Historical reason", canReopen: true } }] });
beforeEach(async () => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); invoke.mockReset(); host = document.createElement("div"); document.body.append(host); root = createRoot(host); await act(async () => root.render(<TagContentScanCheckHistory key="run" runId="run" />)); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const click = (text: string) => act(async () => { Array.from(host.querySelectorAll("button")).find(b => b.textContent === text)!.click(); });
it("loads only on demand and appends history without mutation controls", async () => {
  expect(invoke).not.toHaveBeenCalled(); invoke.mockResolvedValueOnce({ entries: [entry(2)], nextCursor: "cursor" });
  await click("刷新检查历史"); expect(host.textContent).toContain("Note2");
  invoke.mockResolvedValueOnce({ entries: [entry(1)], nextCursor: null }); await click("加载更早检查批次");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_check_history", runId: "run", limit: 5, cursor: "cursor" } });
  expect(host.textContent).toContain("Note1"); expect(host.textContent).toContain("Note2");
  expect(host.querySelectorAll("button")).toHaveLength(1);
});
it("preserves history on failure and ignores late responses after switching", async () => {
  invoke.mockResolvedValueOnce({ entries: [entry(2)], nextCursor: "cursor" }); await click("刷新检查历史");
  invoke.mockRejectedValueOnce(Error("retry")); await click("加载更早检查批次"); expect(host.textContent).toContain("Note2");
  let resolve!: (v: unknown) => void; invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click("刷新检查历史"); await act(async () => root.render(<TagContentScanCheckHistory key="other" runId="other" />));
  await act(async () => resolve({ entries: [entry(99)], nextCursor: null })); expect(host.textContent).not.toContain("Note99");
});
