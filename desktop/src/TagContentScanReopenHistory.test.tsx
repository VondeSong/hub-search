// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanReopenHistory } from "./TagContentScanReopenHistory";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const entry = (id: string) => ({ requestId: id, createdAt: 100, snapshot: { ordinal: 1, title: "Note", reason: "正文变化", previousState: "recorded", previousRunStatus: "completed", expectedVersion: 3, previousProposalId: "old-proposal", proposalStatusAtReopen: "pending", actor: "hub-user", entitiesRead: 1, charsRead: 20, maxEntities: 30, maxChars: 100, previousSourceHash: "old", currentSourceHashAtReopen: "new" } });
const render = (id = "run") => act(async () => root.render(<TagContentScanReopenHistory key={id} runId={id} />));
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockResolvedValue({ entries: [entry("a")], nextCursor: "cursor" }); await render();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (s: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === s)!;
const click = (s: string) => act(async () => button(s).click());
it("loads only on request and presents historical snapshots with stable pagination", async () => {
  expect(invoke).not.toHaveBeenCalled(); await click("查看重开历史");
  expect(host.textContent).toContain("不代表当前状态"); expect(host.textContent).toContain("old-proposal"); expect(host.textContent).toContain("20 / 100");
  invoke.mockResolvedValueOnce({ entries: [entry("a"), entry("b")], nextCursor: null }); await click("加载更早重开记录");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_reopen_history", runId: "run", limit: 20, cursor: "cursor" } });
  expect(host.querySelectorAll("li")).toHaveLength(2); expect(host.textContent).toContain("新增记录请刷新");
});
it("keeps records and cursor after an error and refresh resets pagination", async () => {
  await click("查看重开历史"); invoke.mockRejectedValueOnce(Error("offline")); await click("加载更早重开记录");
  expect(host.querySelectorAll("li")).toHaveLength(1); expect(host.querySelector('[role="alert"]')).toBeTruthy();
  await click("加载更早重开记录"); expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args.cursor).toBe("cursor");
  await click("刷新重开历史"); expect(invoke.mock.calls[invoke.mock.calls.length - 1][1].args.cursor).toBeUndefined();
});
it("ignores late responses from a different selected task and handles empty history", async () => {
  let resolve!: (v: unknown) => void; invoke.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  await click("查看重开历史"); await render("other");
  await act(async () => resolve({ entries: [entry("a")], nextCursor: null })); expect(host.textContent).not.toContain("old-proposal");
  invoke.mockResolvedValueOnce({ entries: [], nextCursor: null }); await click("查看重开历史"); expect(host.textContent).toContain("尚无重开记录");
});
