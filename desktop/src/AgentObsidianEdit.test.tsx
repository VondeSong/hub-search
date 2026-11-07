// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentObsidianEdit, AgentReportSave, AgentObsidianTarget } from "./AgentObsidianEdit";
import { materialKey, type AgentMaterial } from "./AgentMaterials";
import type { AgentActions, ObsidianEditAction } from "./AgentActionTypes";
let host: HTMLDivElement, root: Root;
const onAction = vi.fn(async (_args: Record<string, unknown>) => {});
const draft: ObsidianEditAction = { id: "edit", kind: "obsidianEdit", state: "prepared", confirmationToken: "exact-token", payload: { path: "目录/Note.md", before: "原始内容", after: "整理后内容", summary: "整理结构", warnings: [], mode: "edit" } };
const data = (items: AgentActions["items"] = [], available = true): AgentActions => ({ items, tagOptions: [], obsidianEditAvailable: available });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); onAction.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (actions: AgentActions, revoked = false, disabled = false) => act(async () => root.render(<AgentObsidianEdit actions={actions} revoked={revoked} disabled={disabled} onAction={onAction} />));
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(name));
it("never defaults the write target and selecting one only requests explicit authorization", async () => {
  const note: AgentMaterial={locator:{kind:"note",libraryId:"notes",documentId:"selected",pageId:null},title:"目标",path:"日记/目标.md",libraryName:"隔离笔记"};
  await act(async()=>root.render(<AgentObsidianTarget targets={[note]} disabled={false} onAction={onAction}/>));
  const select=host.querySelector('select')!;
  expect(select.value).toBe("");expect(button("确认保存目标")!.disabled).toBe(true);expect(onAction).not.toHaveBeenCalled();
  await act(async()=>{select.value=materialKey(note.locator);select.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>host.querySelector('form')!.requestSubmit());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({action:"selectObsidianTarget",target:note.locator});
});
it("can explicitly clear a selected target and disables target changes while an action is pending",async()=>{
  const note:AgentMaterial={locator:{kind:"note",libraryId:"notes",documentId:"selected",pageId:null},title:"目标",path:"目标.md",libraryName:"隔离"};
  await act(async()=>root.render(<AgentObsidianTarget targets={[note]} current={note.locator} disabled={false} onAction={onAction}/>));
  const select=host.querySelector('select')!;
  await act(async()=>{select.value="";select.dispatchEvent(new Event('change',{bubbles:true}));});
  await act(async()=>host.querySelector('form')!.requestSubmit());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({action:"selectObsidianTarget",target:null});
  await act(async()=>root.render(<AgentObsidianTarget targets={[note]} current={note.locator} disabled onAction={onAction}/>));
  expect(host.querySelector('select')!.disabled).toBe(true);expect(button("确认保存目标")!.disabled).toBe(true);
});
it("keeps prior versions and receipt visible when verification quota is exhausted",async()=>{
 await render(data([{...draft,state:"saved",receipt:{fileVerified:true,indexed:false,goalCompleted:false},inspectionBudget:{canInspect:false,attemptsUsed:4,reason:"核验额度已用尽，保留上次状态与回执"}}]));
 expect(host.textContent).toContain("原始内容");expect(host.textContent).toContain("整理后内容");expect(host.textContent).toContain("核验额度已用尽");
 expect(button("核对保存结果")!.disabled).toBe(true);await act(async()=>button("核对保存结果")!.click());expect(onAction).not.toHaveBeenCalled();
 expect(host.textContent).toContain("Hub 索引更新尚需核对");
});
it("requires a user instruction and prepares without saving on render", async () => {
  await render(data()); expect(onAction).not.toHaveBeenCalled(); expect(button("准备笔记修改")!.disabled).toBe(true);
  const input = host.querySelector("textarea")!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "整理结构"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => host.querySelector("form")!.requestSubmit()); expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "prepareObsidianEdit", instruction: "整理结构" });
});
it("shows both complete versions and sends only the exact host confirmation", async () => {
  await render(data([draft])); expect(host.textContent).toContain("原始内容"); expect(host.textContent).toContain("整理后内容"); expect(onAction).not.toHaveBeenCalled();
  await act(async () => button("确认保存到原文件")!.click()); expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitObsidianEdit", actionId: "edit", confirmationToken: "exact-token" });
});
it("expired drafts remain reviewable but cannot be saved", async () => {
  await render(data([{ ...draft, state: "expired", confirmationToken: undefined, error: "原文件已变化" }])); expect(host.textContent).toContain("整理后内容"); expect(host.textContent).toContain("原文件已变化"); expect(button("确认保存到原文件")).toBeUndefined(); expect(onAction).not.toHaveBeenCalled();
});
it("restore requests a new preview instead of writing the old version immediately", async () => {
  await render(data([{ ...draft, state: "verified", canRestore: true, receipt: { fileVerified: true, indexed: true, goalCompleted: false } }]));
  await act(async () => button("预览恢复写前版本")!.click()); expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "restoreObsidianEdit", actionId: "edit" }); expect(button("确认保存到原文件")).toBeUndefined();
});
it("revocation hides cached versions and active work disables all edit controls", async () => {
  await render(data([draft]), true); expect(host.textContent).not.toContain("原始内容"); expect(host.textContent).not.toContain("整理后内容"); expect(host.querySelector("button")).toBeNull();
  await render(data([draft]), false, true); expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(b => b.disabled)).toBe(true);
  await render(data([], false)); expect(host.textContent).toBe("");
});
it("previews only the host supplied current report target and never saves immediately", async () => {
  const actions = { ...data(), obsidianReportTarget: { path: "隔离/目标.md", libraryId: "notes", documentId: "target" } };
  await act(async () => root.render(<AgentReportSave actions={actions} disabled={false} onAction={onAction} />));
  expect(host.textContent).toContain("隔离/目标.md"); expect(onAction).not.toHaveBeenCalled();
  await act(async () => button("预览追加当前报告")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "prepareObsidianReportSave" });
  await act(async () => root.render(<AgentReportSave actions={actions} disabled onAction={onAction} />));
  expect(button("预览追加当前报告")!.disabled).toBe(true);
  await act(async () => root.render(<AgentReportSave actions={data()} disabled={false} onAction={onAction} />));
  expect(host.textContent).toBe("");
});
it("report append confirmation binds the exact immutable preview", async () => {
  await render(data([{ ...draft, payload: { ...draft.payload!, mode: "reportAppend" as const } }]));
  expect(host.textContent).toContain("报告追加");
  await act(async () => button("确认追加报告到原文件")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitObsidianEdit", actionId: "edit", confirmationToken: "exact-token" });
});
it("offers conditional report removal instead of full historical file restoration", async () => {
  await render(data([{ ...draft, state: "verified", payload: { ...draft.payload!, mode: "reportAppend" as const }, canRestore: true, receipt: { fileVerified: true, indexed: true, goalCompleted: false } }]));
  expect(button("预览恢复写前版本")).toBeUndefined();
  await act(async () => button("预览撤回本次报告追加")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "restoreObsidianEdit", actionId: "edit" });
});
it("shows preserved later text and requires the distinct report removal confirmation", async () => {
  await render(data([{ ...draft, id: "undo", payload: { ...draft.payload!, mode: "reportUndo" as const, before: "原文+报告+后来正文", after: "原文+后来正文" } }]));
  expect(host.textContent).toContain("原文+后来正文");
  expect(button("确认恢复到原文件")).toBeUndefined();
  expect(onAction).not.toHaveBeenCalled();
  await act(async () => button("确认撤回本次报告追加")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitObsidianEdit", actionId: "undo", confirmationToken: "exact-token" });
  await render(data([{ ...draft, payload: { ...draft.payload!, mode: "reportUndo" as const } }]), false, true);
  expect(button("确认撤回本次报告追加")!.disabled).toBe(true);
});
it("explains unavailable report removal and never offers a destructive fallback", async () => {
  await render(data([{ ...draft, state: "verified", payload: { ...draft.payload!, mode: "reportAppend" as const }, canRestore: false, undoUnavailableReason: "原文或报告段已被修改，不能自动撤回", receipt: { fileVerified: true, indexed: true, goalCompleted: false } }]));
  expect(host.textContent).toContain("原文或报告段已被修改");
  expect(button("预览撤回本次报告追加")).toBeUndefined();
  expect(button("预览恢复写前版本")).toBeUndefined();
  expect(onAction).not.toHaveBeenCalled();
});
it("marks the cached action pending verification and removes its old confirmation", async () => {
  await act(async () => root.render(<AgentObsidianEdit actions={data([draft])} disabled verificationPending revoked={false} onAction={onAction} />));
  expect(host.textContent).toContain("结果待核对");
  expect(host.textContent).toContain("原始内容");
  expect(button("确认保存到原文件")).toBeUndefined();
  expect(onAction).not.toHaveBeenCalled();
});

it("keeps the target, verified receipt and next action visible while full versions stay folded", async () => {
  await render(data([{ ...draft, state: "verified", payload: { ...draft.payload!, mode: "reportAppend" as const }, canRestore: true, receipt: { fileVerified: true, indexed: true, goalCompleted: false } }]));
  const result = host.querySelector<HTMLElement>('[aria-label="笔记操作结果"]')!;
  expect(result.tagName).toBe("ARTICLE");
  expect(result.querySelector('.agent-result-path')?.textContent).toBe("目录/Note.md");
  expect(result.querySelector('.agent-result-receipt')?.textContent).toBe("已保存并回读核验");
  expect(result.querySelector<HTMLDetailsElement>('.agent-result-details')?.open).toBe(false);
  expect(button("预览撤回本次报告追加")?.closest('details')).toBeNull();
  await act(async () => result.querySelector<HTMLElement>('.agent-result-details > summary')!.click());
  expect(result.querySelector<HTMLDetailsElement>('.agent-result-details')!.open).toBe(true);
  expect(result.textContent).toContain("此回执不代表文件之后没有被其他程序修改");
  expect(onAction).not.toHaveBeenCalled();
});

it("does not foreground an old success receipt while the current action is pending verification", async () => {
  await act(async () => root.render(<AgentObsidianEdit actions={data([{ ...draft, receipt: { fileVerified: true, indexed: true, goalCompleted: false } }])} disabled verificationPending revoked={false} onAction={onAction} />));
  expect(host.querySelector('.agent-result-receipt')).toBeNull();
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已暂停再次提交");
  expect(button("确认保存到原文件")).toBeUndefined();
  expect(onAction).not.toHaveBeenCalled();
});

const expiredUndo: ObsidianEditAction = {
  ...draft, id: "old-undo", state: "expired", confirmationToken: undefined,
  payload: { ...draft.payload!, mode: "reportUndo", before: "原文+报告+后来正文", after: "原文+后来正文" },
  conflict: { current: "原文+报告+后来正文+预览后追加", baseHash: "old-base", currentHash: "new-base", proposedHash: "old-proposal", checkedAt: 1792929069804, reprepareActionId: "saved-append" },
};
it("reviews the current conflict beside the immutable old draft and only requests a new preview", async () => {
  await render(data([expiredUndo]));
  expect(host.textContent).toContain("原文+报告+后来正文");
  expect(host.textContent).toContain("原文+后来正文");
  expect(host.textContent).toContain("原文+报告+后来正文+预览后追加");
  expect(host.textContent).toContain("冲突时核对的当前完整文件");
  expect(host.textContent).toContain("旧批准已失效");
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  expect(onAction).not.toHaveBeenCalled();
  await act(async () => button("按当前文件重新预览撤回")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "restoreObsidianEdit", actionId: "saved-append" });
});
it("keeps unavailable conflict recovery read only and hides every version on revocation", async () => {
  const unavailable = { ...expiredUndo, conflict: { ...expiredUndo.conflict!, reprepareActionId: null, unavailableReason: "原文或报告段已被修改，不能自动撤回" } };
  await render(data([unavailable]));
  expect(host.textContent).toContain("原文或报告段已被修改，不能自动撤回");
  expect(button("按当前文件重新预览撤回")).toBeUndefined();
  expect(button("确认撤回本次报告追加")).toBeUndefined();
  await render(data([unavailable]), true);
  expect(host.textContent).not.toContain("预览后追加");
  expect(host.textContent).not.toContain("原文+后来正文");
  expect(onAction).not.toHaveBeenCalled();
});
it("shares the business gate and requires the new preview's own confirmation", async () => {
  await render(data([expiredUndo]), false, true);
  expect(button("按当前文件重新预览撤回")!.disabled).toBe(true);
  await act(async () => root.render(<AgentObsidianEdit actions={data([expiredUndo])} disabled verificationPending revoked={false} onAction={onAction} />));
  expect(button("按当前文件重新预览撤回")).toBeUndefined();
  const replacement: ObsidianEditAction = { ...draft, id: "new-undo", confirmationToken: "new-only-token", payload: { ...draft.payload!, mode: "reportUndo", before: expiredUndo.conflict!.current!, after: "原文+后来正文+预览后追加" } };
  await render(data([replacement, expiredUndo]));
  await act(async () => button("确认撤回本次报告追加")!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitObsidianEdit", actionId: "new-undo", confirmationToken: "new-only-token" });
});
