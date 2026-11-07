// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagContentScanNewRound } from "./TagContentScanNewRound";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const created = vi.fn();
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); created.mockReset();
  invoke.mockReset().mockImplementation(async (_command, { args }) => args.action === "scan_preview_new"
    ? { confirmationToken: "token", plan: { tag: "focus", definition: { version: 1, definition: { description: "Focus", libraryIds: ["lib"] } }, maxEntities: 30, maxChars: 15000, totalEntities: 60, previousRunCount: 2, activeRunCount: 1 } }
    : { run: { runId: "new-run" } });
  await act(async () => root.render(<TagContentScanNewRound tagId="focus" onCreated={created} />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const button = (text: string) => Array.from(host.querySelectorAll("button")).find(b => b.textContent === text);
const click = (text: string) => act(async () => { expect(button(text)).toBeTruthy(); button(text)!.click(); });
it("previews without creation, then confirms the exact plan once", async () => {
  expect(invoke).not.toHaveBeenCalled(); await click("预览新轮次");
  expect(invoke).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  expect(host.textContent).toContain("保留全部 2 个旧任务");
  await act(async () => { button("确认创建新轮次")!.click(); button("确认创建新轮次")!.click(); });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "scan_create_new", tag: "focus", maxEntities: 30, maxChars: 15000, definitionVersion: 1, confirmationToken: "token", requestId: "round-token" } });
  expect(created).toHaveBeenCalledExactlyOnceWith("new-run");
});
it("cancels without creating a task", async () => {
  await click("预览新轮次"); await click("取消新轮次");
  expect(invoke).toHaveBeenCalledTimes(1); expect(created).not.toHaveBeenCalled();
  expect(button("确认创建新轮次")).toBeUndefined();
});
it("discards a rejected preview and warns to inspect history", async () => {
  await click("预览新轮次"); invoke.mockRejectedValueOnce(Error("预览已过期"));
  await click("确认创建新轮次");
  expect(button("确认创建新轮次")).toBeUndefined(); expect(created).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("先刷新历史");
});
it("previews union libraries and confirms the exact selected tag versions", async () => {
  const unionTags = [{ tag: "second", definitionVersion: 2 }];
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    return payload.args.action === "scan_preview_new" ? { ...result, plan: { ...result.plan, manifestMode: "union", manifestScope: ["lib", "other"], unionTags } } : result;
  });
  await act(async () => root.render(<TagContentScanNewRound tagId="focus" unionTags={unionTags} onCreated={created} />));
  expect(host.textContent).toContain("新建合并范围检查");
  await click("预览新轮次");
  expect(invoke.mock.calls[0][1].args.unionTags).toEqual(unionTags);
  expect(host.textContent).toContain("lib、other");
  expect(host.textContent).toContain("已有一个标签不跳过其他标签");
  expect(created).not.toHaveBeenCalled();
  await click("确认创建新轮次");
  expect(invoke.mock.calls[1][1].args.unionTags).toEqual(unionTags);
  expect(invoke.mock.calls[1][1].args.confirmationToken).toBe("token");
});
it("requires a separate confirmation for the exact incremental baseline", async () => {
  const base = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (command, payload) => {
    const result = await base(command, payload);
    return payload.args.action === "scan_preview_new" ? { ...result, plan: { ...result.plan, incrementalFromRunId: "base-run", totalEntities: 3, jointSelection: [{ tag: "second", definitionVersion: 2 }] } } : result;
  });
  await act(async () => root.render(<TagContentScanNewRound tagId="focus" incrementalFromRunId="base-run" onCreated={created} />));
  expect(host.textContent).toContain("仅检查新增内容");
  expect(invoke).not.toHaveBeenCalled();
  await click("预览新轮次");
  expect(invoke.mock.calls[0][1].args.incrementalFromRunId).toBe("base-run");
  expect(host.textContent).toContain("当前去重清单 3 个实体");
  expect(host.textContent).toContain("#second（v2）");
  expect(created).not.toHaveBeenCalled();
  await click("确认创建新轮次");
  expect(invoke.mock.calls[1][1].args.incrementalFromRunId).toBe("base-run");
  expect(invoke.mock.calls[1][1].args.confirmationToken).toBe("token");
  expect(invoke.mock.calls[1][1].args.unionTags).toBeUndefined();
});
