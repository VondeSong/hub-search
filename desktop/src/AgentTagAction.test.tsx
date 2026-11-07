// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTagAction, type AgentActions } from "./AgentTagAction";

let host: HTMLDivElement, root: Root;
const onAction = vi.fn(async () => {});
const payload = { tag: "装配验证", decision: "recommend_add", quote: "先测量再加工", rationale: "有明确的配合验证要求", risks: "仅节选", confidence: 0.8, reconsiderationReason: "" };
const prepared: AgentActions = { tagOptions: ["装配验证"], items: [{ id: "a-1", state: "prepared", payload, confirmationToken: "frozen-token" }] };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); onAction.mockClear();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (actions: AgentActions, disabled = false, revoked = false) => act(async () => root.render(<AgentTagAction actions={actions} disabled={disabled} revoked={revoked} onAction={onAction} />));
it("shows the concrete draft without submitting it and confirms the exact immutable token", async () => {
  await render(prepared);
  expect(onAction).not.toHaveBeenCalled();
  expect(host.textContent).toContain("先测量再加工");
  expect(host.textContent).toContain("有明确的配合验证要求");
  const button = [...host.querySelectorAll("button")].find(b => b.textContent?.startsWith("提交"))!;
  await act(async () => button.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitTagProposal", actionId: "a-1", confirmationToken: "frozen-token" });
});
it("prepares only after an explicit tag selection and form submission", async () => {
  await render({ tagOptions: ["装配验证"], items: [] });
  const select = host.querySelector("select")!;
  expect(select.required).toBe(true);
  await act(async () => { select.value = "装配验证"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onAction).not.toHaveBeenCalled();
  await act(async () => host.querySelector("form")!.requestSubmit());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "prepareTagProposal", tag: "装配验证" });
});
it("expired drafts cannot be submitted and active work disables both action buttons", async () => {
  await render({ ...prepared, items: [{ id: "a-1", state: "expired", payload: null, error: "定义已变化" }] });
  expect(host.textContent).toContain("定义已变化");
  expect([...host.querySelectorAll("button")].some(b => b.textContent?.startsWith("提交"))).toBe(false);
  await render(prepared, true);
  expect([...host.querySelectorAll("button")].every(b => b.disabled)).toBe(true);
});
it("retains actual review receipts after revoke without offering another submission", async () => {
  const actions: AgentActions = { tagOptions: [], items: [{ id: "a-1", state: "verified", payload, receipt: { result: { existing: true, proposal: { proposalId: "p-1", tag: "装配验证", status: "pending" } }, goalCompleted: false }, currentProposal: { proposalId: "p-1", tag: "装配验证", status: "rejected" } }] };
  await render(actions, false, true);
  expect(host.textContent).toContain("已关联现有建议");
  expect(host.textContent).toContain("标签审核状态：已驳回");
  expect(host.textContent).toContain("事项目标是否完成仍需继续核对");
  expect(host.querySelectorAll("button")).toHaveLength(0);
  expect(onAction).not.toHaveBeenCalled();
});
it("does not present the historical receipt status as current when the business record is unavailable", async () => {
  await render({ tagOptions: [], items: [{ id: "a-1", state: "verified", payload, receipt: { result: { proposal: { proposalId: "p-1", tag: "装配验证", status: "pending" } }, goalCompleted: false }, currentProposal: { available: false } }] });
  expect(host.textContent).toContain("当前状态无法读取");
  expect(host.textContent).not.toContain("标签审核状态：待审核");
});
