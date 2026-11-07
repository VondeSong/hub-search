// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { TagSourceWriteback } from "./TagSourceWriteback";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
const candidate = { id: "item", title: "待写回笔记", path: "note.md", libraryName: "Main", provider: "obsidian", pageId: "", addTag: "new", removeTag: "old" };
const preview = { id: "plan", token: "token", candidate, noop: false, changes: [{ before: "正文 #old", after: "正文 #new" }], append: "", expiresAt: 9999999999 };
const button = (text: string) => Array.from(host.querySelectorAll("button")).find(button => button.textContent === text)!;
const click = (text: string) => act(async () => button(text).click());
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockImplementation(async (_command, { args }) => {
    if (args.action === "source_writeback_list") return { items: [candidate], total: 1, nextOffset: null };
    if (args.action === "source_writeback_preview") return preview;
    if (args.action === "source_writeback_apply") return { id: "plan", status: "written", changed: true };
    if (args.action === "source_writeback_history") return { items: [] };
    throw Error("unexpected action");
  });
  await act(async () => root.render(<TagSourceWriteback proposalId="proposal" kind="governance" />));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

it("requires reading the scope and an exact preview before a source write", async () => {
  expect(invoke).not.toHaveBeenCalled();
  await click("写回来源");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "source_writeback_list", proposalId: "proposal", kind: "governance", offset: 0 } });
  expect(button("确认写入 Obsidian")).toBeUndefined();
  await click("预览变更");
  expect(host.textContent).toContain("正文 #old"); expect(host.textContent).toContain("正文 #new");
  expect(invoke.mock.calls.some(call => call[1].args.action === "source_writeback_apply")).toBe(false);
  await click("确认写入 Obsidian");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "source_writeback_apply", id: "plan", token: "token" } });
  expect(host.textContent).toContain("已写入来源并读回验证");
  expect(button("确认写入 Obsidian")).toBeUndefined();
});

it("cancelling a preview never writes and an uncertain result consumes confirmation", async () => {
  await click("写回来源"); await click("预览变更"); await click("取消");
  expect(invoke.mock.calls.some(call => call[1].args.action === "source_writeback_apply")).toBe(false);
  await click("预览变更"); invoke.mockRejectedValueOnce(Error("响应丢失，需核对来源"));
  await click("确认写入 Obsidian");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("需核对来源");
  expect(button("确认写入 Obsidian")).toBeUndefined();
  await click("预览变更");
  expect(invoke).toHaveBeenLastCalledWith("tag_assignment", { args: { action: "source_writeback_preview", proposalId: "proposal", kind: "governance", candidateId: "item" } });
});

it("skips an already applied change and does not expose confirmation", async () => {
  await click("写回来源"); invoke.mockResolvedValueOnce({ ...preview, noop: true });
  await click("预览变更");
  expect(host.textContent).toContain("此项无需修改");
  expect(button("确认写入 Obsidian")).toBeUndefined();
});

it("drops a late preview when the selected proposal changes", async () => {
  await click("写回来源");
  let resolve!: (value: unknown) => void;
  invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await click("预览变更");
  await act(async () => root.render(<TagSourceWriteback proposalId="other" kind="assignment" />));
  await act(async () => resolve(preview));
  expect(host.textContent).not.toContain("待写回笔记");
  expect(button("确认写入 Obsidian")).toBeUndefined();
});

it("keeps backup history available after the Hub suggestion is withdrawn", async () => {
  await act(async () => root.render(<TagSourceWriteback proposalId="proposal" kind="governance" allowWrite={false} />));
  expect(button("写回来源")).toBeUndefined();
  invoke.mockResolvedValueOnce({ items: [{ id: "old-plan", status: "needs_review", updatedAt: 1, result: { error: "核对部分写入" } }] });
  await click("写回记录与备份");
  expect(host.textContent).toContain("失败或部分完成，需核对");
  invoke.mockResolvedValueOnce({ status: "needs_review", plan: { candidate, before: "原文备份", after: "新文", changes: [], append: "" } });
  await click("查看原文备份");
  expect(host.textContent).toContain("原文备份");
});
