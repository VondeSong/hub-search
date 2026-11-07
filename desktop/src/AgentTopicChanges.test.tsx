// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentTopicChanges } from "./AgentTopicChanges";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const reply = () => ({ schemaVersion: 1, topicId: "topic", topicRevision: 2, workId: "work", workRevision: 3, authorizationVersion: 1, period: "2026-10", state: "unchanged", sources: { status: "compared", beforeCount: 1, currentCount: 1, added: 0, removed: 0, changed: 0, uncomparable: 0 }, baseline: { origin: "actualRunBinding", runId: "run", configRevision: 2, methodVersion: "method-v1", methodUse: { loadedThisRun: false, sentToRuntime: false } }, selectedMethod: "method-v1", methodChanged: false, parametersChanged: false, sourceRuleChanged: false, requestedModelChanged: false, previousRequestedModel: { provider: "codex", model: "", reasoningEffort: "", fast: false }, currentRequestedModel: { provider: "codex", model: "", reasoningEffort: "", fast: false }, methodCompatible: true, methodUnavailableReason: null });
let host: HTMLDivElement, root: Root;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset().mockResolvedValue(reply()); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render(workId = "work", auth = 1, disabled = false) { await act(async () => root.render(<AgentTopicChanges topicId="topic" topicRevision={2} workId={workId} workRevision={3} authorizationVersion={auth} disabled={disabled} />)); }
async function click() { await act(async () => host.querySelector("button")!.click()); }
it("is lazy and only inspects exact saved identities without dispatch or mutation", async () => {
 await render(); expect(invoke).not.toHaveBeenCalled(); await click();
 expect(invoke).toHaveBeenCalledExactlyOnceWith("agent_investigation", { args: { action: "topicChanges", topicId: "topic", expectedRevision: 2, workId: "work", expectedWorkRevision: 3, expectedAuthorizationVersion: 1 } });
 expect(host.textContent).toContain("未发现变化"); expect(host.textContent).toContain("实际服务端模型身份未知"); expect(host.textContent).toContain("选择方法不等于实际采用");
 expect(host.textContent).not.toContain("语义采用已证明");
});
it("keeps unknown baseline counts distinct from zero and selected method distinct from adoption", async () => {
 invoke.mockResolvedValue({ ...reply(), state: "unverified", sources: { status: "unverified", beforeCount: null, currentCount: 2, added: null, removed: null, changed: null, uncomparable: null, reason: "旧绑定没有完整成员版本" }, methodChanged: null, parametersChanged: null, sourceRuleChanged: null, requestedModelChanged: null });
 await render(); await click(); expect(host.textContent).toContain("原有 未知 篇"); expect(host.textContent).toContain("新增 未知"); expect(host.textContent).toContain("旧记录不足以判断"); expect(host.textContent).not.toContain("未发现变化");
});
it.each([{ workId: "foreign" }, { topicRevision: 3 }, { authorizationVersion: 2 }, { state: "invented" }])("rejects a wrong reply identity %j", async mismatch => {
 invoke.mockResolvedValue({ ...reply(), ...mismatch }); await render(); await click(); expect(host.textContent).toContain("变化说明身份或版本不一致"); expect(host.textContent).not.toContain("未发现变化");
});
it("clears old results when a later inspection fails", async () => {
 await render(); await click(); invoke.mockRejectedValue(new Error("来源授权已撤回")); await click(); expect(host.textContent).toContain("来源授权已撤回"); expect(host.textContent).not.toContain("未发现变化");
});
it("discards delayed responses after Work or authorization changes", async () => {
 let finish!: (v: unknown) => void; invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; })); await render(); await click(); await render("other-work", 2); await act(async () => finish(reply())); expect(host.textContent).not.toContain("未发现变化"); expect(host.textContent).not.toContain("原有 1 篇");
});
it("disables checking during parent work mutations", async () => { await render("work", 1, true); await click(); expect(invoke).not.toHaveBeenCalled(); });
