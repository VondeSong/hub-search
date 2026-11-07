// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentBusinessActions } from "./AgentBusinessActions";
import type { AgentActions, ArchiveAction, FlashcardAction } from "./AgentActionTypes";
let host: HTMLDivElement, root: Root;
const onAction = vi.fn(async (_args: Record<string, unknown>) => {});
const card: FlashcardAction = { id: "card-action", kind: "flashcardDrafts", state: "prepared", confirmationToken: "card-token", payload: { deckName: "学习", learningGoal: "记住测量条件", cards: [{ question: "加工前检查什么？", answer: "先测量配合条件。", explanation: "测量是加工前置条件。", evidenceText: "先测量再加工" }], uncoveredTargets: ["图片未分析"] } };
const archive: ArchiveAction = { id: "archive-action", kind: "archiveCopy", state: "prepared", confirmationToken: "archive-token", payload: { libraryId: "craft", targetName: "工作资料", sourceTitle: "装配资料", plan: { title: "装配验证", summary: "保存验证条件", reason: "供后续核对", destinationPath: "工作资料 / 实验记录", markdown: "先测量再加工", warnings: ["尚无实测结果"] } } };
const data = (items: AgentActions["items"] = []): AgentActions => ({ items, tagOptions: [], flashcardDecks: ["学习"], archiveTargets: [{ id: "craft", name: "工作资料" }] });
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.append(host); root = createRoot(host); onAction.mockClear(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const render = async (actions: AgentActions, sourceKind: "note" | "reading" = "note", revoked = false, disabled = false) => act(async () => root.render(<AgentBusinessActions actions={actions} sourceKind={sourceKind} initialGoal="记住测量条件" revoked={revoked} disabled={disabled} onAction={onAction} />));
const button = (name: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent?.includes(name))!;
it("does not prepare on render and notes do not expose the reading archive action", async () => {
  await render(data()); expect(onAction).not.toHaveBeenCalled(); expect(host.textContent).toContain("准备闪卡草稿"); expect(host.textContent).not.toContain("准备归档方案");
  await act(async () => host.querySelector("form")!.requestSubmit());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "prepareFlashcards", deckName: "收件箱", learningGoal: "记住测量条件" });
});
it("reading archive needs an explicit target choice and does not submit until confirmed", async () => {
  await render(data(), "reading"); expect(host.textContent).not.toContain("准备闪卡草稿");
  const select = host.querySelector("select")!; expect(select.required).toBe(true);
  await act(async () => { select.value = "craft"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onAction).not.toHaveBeenCalled(); await act(async () => host.querySelector("form")!.requestSubmit());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "prepareArchive", libraryId: "craft" });
});
it("renders concrete archive content and submits the immutable confirmation", async () => {
  await render(data([archive]), "reading"); expect(host.textContent).toContain("工作资料 / 实验记录"); expect(host.textContent).toContain("先测量再加工");
  expect(onAction).not.toHaveBeenCalled(); await act(async () => button("确认保存归档副本").click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitArchive", actionId: "archive-action", confirmationToken: "archive-token" });
});
it("renders source-grounded card drafts and submits to the inbox without activating study", async () => {
  await render(data([card])); expect(host.textContent).toContain("先测量再加工"); expect(host.textContent).toContain("不自动加入复习");
  await act(async () => button("确认导入闪卡收件箱").click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitFlashcards", actionId: "card-action", confirmationToken: "card-token" });
});
it("unknown archive outcomes offer association instead of another creation", async () => {
  const unknown: ArchiveAction = { ...archive, state: "unknown", receipt: { goalCompleted: false }, currentResult: { state: "unknown" } };
  await render(data([unknown]), "reading"); expect(button("确认保存归档副本")).toBeUndefined(); expect(button("继续保存并核验")).toBeUndefined();
  const input = host.querySelector<HTMLInputElement>('[name="agentArchiveRemoteId"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "known-page"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => button("核对并关联已有页面").click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "associateArchive", actionId: "archive-action", confirmationToken: "archive-token", remoteId: "known-page" });
});
it("only a host-authorized partial result can continue and revoke hides write controls", async () => {
  const partial: ArchiveAction = { ...archive, state: "partial", canContinue: true, receipt: { goalCompleted: false }, currentResult: { state: "partial", copies: [{ objectId: "known", parentId: "document", verified: false }] } };
  await render(data([partial]), "reading"); await act(async () => button("继续保存并核验").click()); expect(onAction.mock.calls[0][0]).toMatchObject({ action: "submitArchive", actionId: "archive-action" });
  await render(data([partial]), "reading", true); expect(button("继续保存并核验").disabled).toBe(true);
  expect(host.textContent).toContain("已有目标身份");
});
it("shows actual inbox review status and preserves missing or unavailable records as unknown", async () => {
  const done: FlashcardAction = { ...card, state: "verified", receipt: { goalCompleted: false, result: { imported: 2, duplicates: 1 } }, currentResult: { imported: 2, duplicates: 1, missingDrafts: 1, drafts: [{ id: "draft", status: "rejected" }] } };
  await render(data([done]), "note", true); expect(host.textContent).toContain("新增 2 张，重复跳过 1 张"); expect(host.textContent).toContain("已拒绝"); expect(host.textContent).toContain("不推断为已接受");
  const unavailable: FlashcardAction = { ...done, currentResult: { available: false } };
  await render(data([unavailable]), "note", true); expect(host.textContent).toContain("当前收件箱状态无法读取"); expect(host.querySelector("form")).toBeNull();
});
it("expired drafts and active operations cannot trigger a write", async () => {
  await render(data([{ ...card, state: "expired", payload: null, confirmationToken: undefined }])); expect(button("确认导入")).toBeUndefined();
  await render(data([card]), "note", false, true); expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(b => b.disabled)).toBe(true);
});

it("keeps selected-card changes separate from import and requires the updated confirmation",async()=>{
 const two:FlashcardAction={...card,payload:{...card.payload!,cards:[card.payload!.cards[0],{...card.payload!.cards[0],question:"第二张问题"}]}};
 await render(data([two]));const checks=host.querySelectorAll<HTMLInputElement>('[aria-label^="保留第"]');
 await act(async()=>checks[1].click());expect(onAction).not.toHaveBeenCalled();expect(button("确认导入").disabled).toBe(true);
 await act(async()=>button("保留选中的 1 张").click());expect(onAction).toHaveBeenCalledExactlyOnceWith({action:"selectFlashcards",actionId:"card-action",confirmationToken:"card-token",selectedIndices:[0]});
 expect(button("确认导入").disabled).toBe(true);
 await render(data([{...two,confirmationToken:"new-token",payload:{...two.payload!,cards:[two.payload!.cards[0]]}}]));
 expect(button("确认导入").disabled).toBe(false);
});

it("previews the complete Dida reference note and target before confirmation", async () => {
  const item: ArchiveAction = { ...archive, payload: { ...archive.payload!, libraryId: "dida", targetName: "滴答", plan: { ...archive.payload!.plan, provider: "dida365", title: "", markdown: "", tasks: [{ title: "原文标题", content: "完整的原文资料，不是模型摘要", projectId: "references", projectName: "参考资料", tags: ["已有标签"] }] } } };
  await render(data([item]), "reading");
  for (const text of ["原文标题", "完整的原文资料，不是模型摘要", "参考资料", "已有标签"]) expect(host.textContent).toContain(text);
  expect(onAction).not.toHaveBeenCalled();
  await act(async () => button("确认保存归档副本").click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ action: "submitArchive", actionId: item.id, confirmationToken: item.confirmationToken });
});
