// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedMemory } from "./SharedMemory";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
let host: HTMLDivElement, root: Root;
const empty = { configured: true, entries: [], projects: [{ id: "p1", name: "Hub" }], selection: { projectId: "", enabled: false } };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockResolvedValue(empty);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function open() {
  await act(async () => root.render(<SharedMemory workId="work-1" disabled={false} />));
  await act(async () => {
    const detail = host.querySelector("details")!; detail.open = true; detail.dispatchEvent(new Event("toggle"));
  });
}
it("does not load or enable memory until the user opens and opts in", async () => {
  await act(async () => root.render(<SharedMemory workId="work-1" disabled={false} />));
  expect(invoke).not.toHaveBeenCalled();
  await open();
  expect(invoke.mock.calls.every(([, { args }]) => args.action === "status")).toBe(true);
  expect(host.querySelector<HTMLInputElement>('[type="checkbox"]')!.checked).toBe(false);
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  expect(invoke).toHaveBeenLastCalledWith("shared_memory", { args: {
    action: "selectScope", workId: "work-1", projectId: "", enabled: true,
  } });
});
it("prepares built-in memory without asking for interpreter or model paths and exposes repair", async () => {
  await open();
  expect(host.textContent).toContain("本地记忆已就绪");
  expect(host.textContent).not.toMatch(/选择.*Python|连接本地记忆环境|模型缓存目录/);
  const repair = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "修复本地记忆")!;
  await act(async () => repair.click());
  expect(invoke).toHaveBeenLastCalledWith("shared_memory", { args: { action: "repair", workId: "work-1" } });
});
it("preserves the exact submission identity after a transport interruption", async () => {
  await open();
  const inputs = Array.from(host.querySelectorAll("input")).filter(input => input.type !== "checkbox");
  const title = inputs[1];
  const content = host.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(title, "后端决定");
    title.dispatchEvent(new Event("input", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(content, "采用 Basic Memory");
    content.dispatchEvent(new Event("input", { bubbles: true }));
  });
  invoke.mockImplementation(async (_, { args }) => { if (args.action === "put") throw new Error("连接中断"); return empty; });
  const save = Array.from(host.querySelectorAll("button")).find(b => b.textContent === "确认并保存记忆")!;
  await act(async () => save.click());
  await act(async () => save.click());
  const calls = invoke.mock.calls.filter(([, { args }]) => args.action === "put");
  expect(calls).toHaveLength(2);
  expect(calls[0][1].args.requestKey).toBe(calls[1][1].args.requestKey);
  expect(calls[0][1].args.confirmed).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("连接中断");
});
it("keeps a new investigation selection local until its work identity exists", async () => {
  const selection = vi.fn();
  await act(async () => root.render(<SharedMemory disabled={false} onSelectionChange={selection} />));
  await act(async () => { const detail = host.querySelector('details')!; detail.open = true; detail.dispatchEvent(new Event('toggle')); });
  await act(async () => host.querySelector<HTMLInputElement>('[type="checkbox"]')!.click());
  expect(selection).toHaveBeenLastCalledWith({ projectId: '', enabled: true });
  expect(invoke.mock.calls.every(([, { args }]) => args.action === 'status')).toBe(true);
});

it("keeps model proposals separate and requires an explicit reviewed save", async () => {
  const proposal = { id: "proposal-1", projectId: "", expectedVersion: 0,
    candidate: { topicKey: "format", title: "报告格式", kind: "decision", body: "报告用中文", reason: "供后续项目复用" },
    source: { origin: "modelProposal", proposedBy: "deepseek", workId: "source-work", sourceRecordId: "source-message", runId: "source-run" } };
  invoke.mockResolvedValue({ ...empty, proposals: [proposal] });
  await open();
  expect(host.textContent).toContain("模型建议尚未生效");
  expect(host.textContent).toContain("source-message");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "put")).toBe(false);
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "检查并修改建议")!.click());
  expect(host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("报告用中文");
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "put")).toBe(false);
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "确认并保存记忆")!.click());
  const saved = invoke.mock.calls.find(([, { args }]) => args.action === "put")![1].args;
  expect(saved).toMatchObject({ confirmed: true, proposalId: "proposal-1", expectedVersion: 0, topicKey: "format", body: "报告用中文" });
});
it("dismisses a proposal without saving memory", async () => {
  invoke.mockResolvedValue({ ...empty, proposals: [{ id: "p-2", projectId: "", expectedVersion: 0, candidate: { title: "临时安排", body: "一次性", reason: "建议", kind: "decision", topicKey: "temporary" }, source: { origin: "modelProposal" } }] });
  await open();
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "忽略建议")!.click());
  expect(invoke).toHaveBeenLastCalledWith("shared_memory", { args: { action: "dismissProposal", proposalId: "p-2", workId: "work-1" } });
  expect(invoke.mock.calls.some(([, { args }]) => args.action === "put")).toBe(false);
});
it("rejects a late memory response belonging to the previous work", async () => {
  let finish: (value: unknown) => void = () => {};
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await open();
  invoke.mockResolvedValue({ ...empty, entries: [] });
  await act(async () => root.render(<SharedMemory workId="work-2" disabled={false} />));
  await act(async () => finish({ ...empty, entries: [{ id: "old", title: "旧事项的迟到内容", body: "不应显示", state: "active", version: 1, projectId: "", kind: "decision" }] }));
  expect(host.textContent).not.toContain("旧事项的迟到内容");
});

it("refreshes the selected project's proposals before a new work exists", async () => {
  const proposal = { id: "project-proposal", projectId: "p1", expectedVersion: 0,
    candidate: { title: "项目内待确认建议", topicKey: "format", kind: "decision", body: "项目内容", reason: "用户要求" }, source: { origin: "modelProposal" } };
  invoke.mockImplementation(async (_, { args }) => ({ ...empty, entries: [{ id:"common-memory", revisionId:"common-v1", topicKey:"common", title:"个人通用规则", body:"正文", kind:"decision", version:1, state:"active", projectId:"" }], proposals: args.projectId === "p1" ? [proposal] : [] }));
  await act(async () => root.render(<SharedMemory disabled={false} />));
  await act(async () => { const detail = host.querySelector("details")!; detail.open = true; detail.dispatchEvent(new Event("toggle")); });
  await act(async () => { const select = host.querySelector("select")!; select.value = "p1"; select.dispatchEvent(new Event("change", {bubbles:true})); });
  expect(host.textContent).toContain("项目内待确认建议");
  expect(invoke).toHaveBeenLastCalledWith("shared_memory", { args: { action: "status", projectId: "p1", workId: undefined } });
  expect(invoke.mock.calls.some(([, {args}]) => args.action === "selectScope")).toBe(false);
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "修改")!.click());
  await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent === "确认并保存记忆")!.click());
  expect(invoke.mock.calls.some(([, {args}]) => args.action === "put" && args.projectId === "")).toBe(true);
  expect(host.textContent).toContain("项目内待确认建议");
});
