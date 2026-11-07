// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentInvestigation } from "./AgentInvestigation";
import type { SearchResult } from "./SearchTypes";
import saved from "./test-fixtures/agent-business-receipt-unknown.json";

const { invoke, bridge, visibility } = vi.hoisted(() => ({ invoke: vi.fn(), bridge: { receive: null as null | ((event: { payload: Record<string, unknown> }) => void) }, visibility: { value: true } }));
vi.mock("./CodexSuite",async importOriginal=>({...await importOriginal<object>(),loadCodexSuiteModels:vi.fn(async()=>[]),cachedCodexSuiteModels:()=>[],useCodexSuite:()=>({loaded:true,loading:false,settings:{model:"fixture-model",provider:"codex",reasoningEffort:"medium",fast:false,maxConcurrent:2}})}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (_name, receive) => { bridge.receive = receive; return () => { bridge.receive = null; }; }) }));
vi.mock("./WindowVisibility", () => ({ useDocumentVisible: () => visibility.value }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: { desktop: true, localVault: true } }));
let host: HTMLDivElement, root: Root;
const original = () => JSON.parse(JSON.stringify(saved)) as typeof saved;
const failure = "V2_S3_RECEIPT_COMMIT_BLOCKED";
const note = saved.work.grant.notes[0];
const result: SearchResult = { id: "saved-note", entityKey: `note:${note.libraryId}:${note.documentId}`, provider: "obsidian", libraryId: note.libraryId, libraryName: "隔离库", spaceId: note.libraryId, spaceName: "隔离库", documentId: note.documentId, contentType: "markdown", sourceType: "note", title: "验收目标", path: "验收目标.md", snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [] };
const buttons = () => [...document.body.querySelectorAll<HTMLButtonElement>("button")];
const button = (label: string) => buttons().find(b => (b.getAttribute("aria-label") || b.textContent)?.trim() === label);
const click = async (label: string) => act(async () => { const b = button(label); expect(b, label).toBeDefined(); b!.click(); });
const mutations = () => invoke.mock.calls.filter(([, value]) => value.args.action === "submitObsidianEdit");
async function open() {
  await act(async () => root.render(<AgentInvestigation result={result} />));
  await click("调查这篇笔记");
}
function failBoth() {
  invoke.mockImplementation(async (_command, { args }) => {
    if (args.action === "status" || args.action === "submitObsidianEdit") throw Error(failure);
    return original();
  });
}
beforeEach(() => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); visibility.value = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  invoke.mockReset().mockImplementation(async (_command, { args }) => args.action === "list" ? { works: [{ id: saved.work.id, goal: saved.work.goal, state: "expired" }] } : original());
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); bridge.receive = null; vi.useRealTimers(); });

it("replays saved S3 double failure as pending verification and never reoffers the cached confirmation", async () => {
  await open(); failBoth();
  await click("确认撤回本次报告追加");
  expect(document.body.textContent).toContain("结果待核对");
  expect(document.body.textContent).not.toContain("草稿已准备，待你确认");
  expect(document.body.textContent).not.toContain(failure);
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  expect(button("核对当前结果")?.disabled).toBe(false);
  expect(mutations()).toHaveLength(1);
  await click("核对当前结果");
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("预览撤回本次报告追加")?.disabled).toBe(true);
  expect(mutations()).toHaveLength(1);
});

const verified = (recordVersion = 11) => {
  const view = original();
  return { ...view, recordVersion, actions: { ...view.actions, items: view.actions.items.map(a => a.payload.mode === "reportUndo" ? { ...a, state: "verified", confirmationToken: undefined, canRestore: false, receipt: { fileVerified: true, indexed: true, goalCompleted: false } } : a) } };
};
const notify = async () => act(async () => bridge.receive!({ payload: { workId: saved.work.id, eventCategory: "publicStream", publicHasText: true } }));
async function failOnce() { await open(); failBoth(); await click("确认撤回本次报告追加"); }

it("only checks host status after failure, then accepts the same verified action without a new submit", async () => {
  await failOnce();
  invoke.mockImplementation(async (_command, { args }) => { expect(args.action).toBe("status"); return verified(); });
  const before = invoke.mock.calls.length;
  await click("核对当前结果");
  expect(invoke.mock.calls.slice(before).map(([, value]) => value.args)).toEqual([{ action: "status", id: saved.work.id }]);
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(document.body.textContent).not.toContain(failure);
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  expect(mutations()).toHaveLength(1);
});

it("only offers an explicit retry after the host verifies that the write was interrupted", async () => {
  await failOnce();
  const interrupted = original(); interrupted.recordVersion = 11; interrupted.actions.items[0].state = "interrupted";
  invoke.mockImplementation(async () => interrupted);
  await click("核对当前结果");
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(button("确认撤回本次报告追加")?.disabled).toBe(false);
  expect(mutations()).toHaveLength(1);
});

it("cannot unlock with an older in-flight response even if its version number is larger", async () => {
  await open();
  let started = false, resolveOld: ((value: typeof saved) => void) | undefined;
  invoke.mockImplementation((_command, { args }) => {
    if (args.action === "status" && !started) { started = true; return new Promise(resolve => { resolveOld = resolve; }); }
    return Promise.reject(Error(failure));
  });
  await notify();
  await click("确认撤回本次报告追加");
  expect(document.body.textContent).toContain("结果待核对");
  await act(async () => resolveOld!({ ...original(), recordVersion: 100 }));
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  invoke.mockImplementation(async () => verified(11));
  await click("核对当前结果");
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(mutations()).toHaveLength(1);
});

it("does not accept a lower record version as the outcome check", async () => {
  await open();
  invoke.mockImplementation(async (_command, { args }) => {
    if (args.action === "submitObsidianEdit") throw Error(failure);
    return { ...original(), recordVersion: 9 };
  });
  await click("确认撤回本次报告追加");
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  invoke.mockImplementation(async () => verified(11));
  await click("核对当前结果");
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(mutations()).toHaveLength(1);
});

it("waits for a later notification folded into the outcome check before releasing the gate", async () => {
  await failOnce();
  const pending: ((value: ReturnType<typeof verified>) => void)[] = [];
  invoke.mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  await click("核对当前结果");
  await notify();
  expect(pending).toHaveLength(1);
  await act(async () => pending[0](verified(11)));
  expect(pending).toHaveLength(2);
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("核对当前结果")?.disabled).toBe(true);
  await act(async () => pending[1](verified(12)));
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(mutations()).toHaveLength(1);
});

it("blocks two synchronous clicks before React has committed the disabled controls", async () => {
  await open(); let rejectMutation: ((reason: Error) => void) | undefined;
  invoke.mockImplementation((_command, { args }) => args.action === "submitObsidianEdit" ? new Promise((_resolve, reject) => { rejectMutation = reject; }) : Promise.reject(Error(failure)));
  const confirm = button("确认撤回本次报告追加")!;
  await act(async () => { confirm.click(); confirm.click(); });
  expect(mutations()).toHaveLength(1);
  await act(async () => rejectMutation!(Error(failure)));
  expect(document.body.textContent).toContain("结果待核对");
  expect(mutations()).toHaveLength(1);
});

it("keeps the gate through panel reopen and respects a later authoritative revocation", async () => {
  await failOnce();
  await click("关闭助手"); await click("调查这篇笔记");
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  const denied = original(); denied.recordVersion = 12; denied.work.state = "revoked";
  invoke.mockImplementation(async () => denied);
  await notify();
  expect(document.body.textContent).not.toContain("V2-KEEP-20261025");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  expect(mutations()).toHaveLength(1);
});

it("also requires a current check when the mutation reply succeeds but status refresh fails", async () => {
  await open();
  invoke.mockImplementation(async (_command, { args }) => { if (args.action === "status") throw Error(failure); return verified(); });
  await click("确认撤回本次报告追加");
  expect(document.body.textContent).toContain("结果待核对");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  invoke.mockImplementation(async () => verified());
  await click("核对当前结果");
  expect(document.body.textContent).not.toContain("结果待核对");
  expect(mutations()).toHaveLength(1);
});

it("suppresses a transport error during the authoritative check and clears it when the action is verified", async () => {
  await open(); let finishCheck: ((value: ReturnType<typeof verified>) => void) | undefined;
  invoke.mockImplementation((_command, { args }) => args.action === "submitObsidianEdit" ? Promise.reject(Error(failure)) : new Promise(resolve => { finishCheck = resolve; }));
  await click("确认撤回本次报告追加");
  expect(document.body.textContent).not.toContain(failure);
  expect(button("确认撤回本次报告追加")?.disabled).toBe(true);
  await act(async () => finishCheck!(verified()));
  expect(document.body.textContent).not.toContain(failure);
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  expect(mutations()).toHaveLength(1);
});

it("does not unlock or replace the work with a response belonging to another work", async () => {
  await failOnce();
  const wrong = verified(); wrong.work = { ...wrong.work, id: "another-work", goal: "WRONG_WORK_SENTINEL" };
  invoke.mockImplementation(async () => wrong);
  await click("核对当前结果");
  expect(document.body.textContent).toContain("结果待核对");
  expect(document.body.textContent).not.toContain("WRONG_WORK_SENTINEL");
  invoke.mockImplementation(async () => verified());
  await click("核对当前结果");
  expect(document.body.textContent).not.toContain("结果待核对");
});

it("also disables the existing draft-continuation business entry until the result is checked", async () => {
  const initial = { ...original(), draftRequest: { runId: "saved-run", kind: "obsidianEdit" } };
  invoke.mockImplementation(async (_command, { args }) => args.action === "list" ? { works: [{ id: saved.work.id, goal: saved.work.goal, state: "expired" }] } : initial);
  await open();
  expect(button("继续准备本轮草稿")?.disabled).toBe(false);
  failBoth(); await click("确认撤回本次报告追加");
  expect(button("继续准备本轮草稿")?.disabled).toBe(true);
  const before = invoke.mock.calls.length;
  await click("继续准备本轮草稿");
  expect(invoke.mock.calls).toHaveLength(before);
});

it.each([
  { label: "提交「检验」到待审核", item: { id: "tag", kind: "tagProposal", state: "prepared", confirmationToken: "other-token", payload: { tag: "检验", decision: "suggest", quote: "已确认事实", rationale: "核对", risks: "", confidence: 0.9, reconsiderationReason: "" } } },
  { label: "确认导入闪卡收件箱", item: { id: "cards", kind: "flashcardDrafts", state: "prepared", confirmationToken: "other-token", payload: { deckName: "验收", learningGoal: "核对", cards: [{ question: "何时保存", answer: "核对后", explanation: "先核对", evidenceText: "已确认事实" }], uncoveredTargets: [] } } },
  { label: "确认保存归档副本", item: { id: "archive", kind: "archiveCopy", state: "prepared", confirmationToken: "other-token", payload: { libraryId: "test", targetName: "隔离", sourceTitle: "验收目标", plan: { title: "归档", summary: "保存", reason: "测试", destinationPath: "隔离", markdown: "合成内容", warnings: [] } } } },
])("keeps the shared business consumer disabled while the same work needs checking: $label", async ({ label, item }) => {
  const initial = original();
  const withOther = { ...initial, actions: { ...initial.actions, items: [...initial.actions.items, item] } };
  invoke.mockImplementation(async (_command, { args }) => args.action === "list" ? { works: [{ id: saved.work.id, goal: saved.work.goal, state: "expired" }] } : withOther);
  await open();
  expect(button(label)?.disabled).toBe(false);
  failBoth(); await click("确认撤回本次报告追加");
  expect(button(label)?.disabled).toBe(true);
  const before = invoke.mock.calls.length;
  await click(label);
  expect(invoke.mock.calls).toHaveLength(before);
  expect(mutations()).toHaveLength(1);
});
