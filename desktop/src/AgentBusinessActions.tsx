import { useEffect, useId, useState } from "react";
import type { AgentActions, ArchiveAction, FlashcardAction } from "./AgentActionTypes";
type ActionCall = (args: Record<string, unknown>) => Promise<void>;
const states: Record<string, string> = { superseded: "已有更新草稿", preparing: "正在准备", prepared: "待你确认", executing: "正在保存并核验", verified: "结果已核验", interrupted: "已中断", expired: "草稿已失效", partial: "已有部分结果", unknown: "写入结果待核对" };
const inboxStates: Record<string, string> = { pending: "待审核", accepted: "已接受", rejected: "已拒绝", duplicate: "重复已跳过" };

export function ArchiveRecord({ item, disabled, revoked, onAction }: { item: ArchiveAction; disabled: boolean; revoked: boolean; onAction: ActionCall }) {
  const [remoteId, setRemoteId] = useState("");
  const draft = item.payload;
  const current = item.currentResult;
  const submit = () => onAction({ action: "submitArchive", actionId: item.id, confirmationToken: item.confirmationToken });
  return <details open className="agent-action-record"><summary>归档副本 · {states[item.state] || item.state}</summary>
    {draft && <p>{draft.sourceTitle} → {draft.targetName}</p>}
    {item.state === "prepared" && draft && <>
      <p><strong>{draft.plan.title}</strong> · {draft.plan.destinationPath}</p><p>{draft.plan.summary}</p><p>{draft.plan.reason}</p>
      {!!draft.plan.warnings.length && <ul>{draft.plan.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
      <details><summary>查看归档正文</summary>{draft.plan.provider === "dida365" ? draft.plan.tasks?.map((task, index) => <div key={index}><p><strong>{task.title}</strong> → {task.projectName || task.projectId}</p><p>已有标签：{task.tags?.join("、") || "无"}</p><div className="agent-action-text">{task.content}</div></div>) : <div className="agent-action-text">{draft.plan.markdown}</div>}</details>
      <p className="agent-note">确认后沿现有归档流程创建并核验副本，保留原材料。停止后可能已有写入，已有身份和结果会保留。</p>
      <button type="button" disabled={disabled || revoked || !item.confirmationToken} onClick={() => void submit()}>确认保存归档副本</button>
    </>}
    {item.receipt && <>
      <p>{current?.state === "verified" ? "原归档流程已完成保存与核验。" : current?.state === "partial" ? "已有目标身份，正文或附件仍需补齐核验。" : "尚未取得完整保存证明。请核对现有处理记录，勿重复创建。"}</p>
      {current?.error && <p className="agent-notice">{current.error}</p>}
      <p className="agent-note">这里显示上次业务核验的回执，未重新查询远端。副本保存成功也不代表事项目标完成。</p>
      {item.canContinue && <button type="button" disabled={disabled || revoked || !item.confirmationToken} onClick={() => void submit()}>继续保存并核验</button>}
      {item.state === "unknown" && <form onSubmit={event => { event.preventDefault(); if (remoteId.trim()) void onAction({ action: "associateArchive", actionId: item.id, confirmationToken: item.confirmationToken, remoteId: remoteId.trim() }); }}>
        <label>已创建页面或滴答笔记的 ID<input type="text" name="agentArchiveRemoteId" value={remoteId} required maxLength={150} disabled={disabled} onChange={event => setRemoteId(event.target.value)} /></label>
        <p className="agent-note">先在目标资料库核对页面或滴答笔记。关联会沿原流程读取并检查目标，不重新创建副本。</p>
        <button type="submit" disabled={disabled || !item.confirmationToken}>核对并关联已有页面</button>
      </form>}
    </>}
    {item.error && <p className="agent-notice">{item.error}</p>}
  </details>;
}
export function FlashcardRecord({ item, disabled, revoked, onAction }: { item: FlashcardAction; disabled: boolean; revoked: boolean; onAction: ActionCall }) {
  const draft = item.payload;
  const result = item.currentResult;
  const [excluded,setExcluded]=useState<number[]>([]);
  useEffect(()=>setExcluded([]),[item.confirmationToken]);
  return <details open className="agent-action-record"><summary>闪卡草稿 · {states[item.state] || item.state}</summary>
    {item.state === "prepared" && draft && <>
      <p>学习目标：{draft.learningGoal} · 建议牌组：{draft.deckName}</p>
      <ol>{draft.cards.map((card, index) => <li key={index}><label className="agent-card-check"><input type="checkbox" aria-label={`保留第 ${index+1} 张卡片`} checked={!excluded.includes(index)} disabled={disabled} onChange={event=>setExcluded(current=>event.target.checked?current.filter(i=>i!==index):[...current,index])}/><strong>{card.question}</strong></label><p>{card.answer}</p><p>{card.explanation}</p><details><summary>原文依据</summary><blockquote>{card.evidenceText}</blockquote></details></li>)}</ol>
      <p className="agent-note">基于当前页面文本；图片和附件未分析。导入后需在现有闪卡收件箱审核，不自动加入复习。</p>
      {!!draft.uncoveredTargets.length && <details><summary>未覆盖或按偏好排除的目标</summary><ul>{draft.uncoveredTargets.map((target, i) => <li key={i}>{target}</li>)}</ul></details>}
      {!!excluded.length && <button type="button" disabled={disabled || revoked || excluded.length===draft.cards.length || !item.confirmationToken} onClick={()=>void onAction({action:"selectFlashcards",actionId:item.id,confirmationToken:item.confirmationToken,selectedIndices:draft.cards.map((_,i)=>i).filter(i=>!excluded.includes(i))})}>保留选中的 {draft.cards.length-excluded.length} 张</button>}
      <button type="button" disabled={disabled || revoked || !!excluded.length || !item.confirmationToken} onClick={() => void onAction({ action: "submitFlashcards", actionId: item.id, confirmationToken: item.confirmationToken })}>确认导入闪卡收件箱</button>
    </>}
    {item.receipt && <>
      <p>提交回执：新增 {item.receipt.result.imported ?? "未知"} 张，重复跳过 {item.receipt.result.duplicates ?? "未知"} 张。</p>
      {result?.available === false || !result ? <p className="agent-notice">当前收件箱状态无法读取，历史提交回执保留。</p> : <>
        <ul>{result.drafts?.map((card, index) => <li key={card.id}>草稿 {index + 1}：{inboxStates[card.status] || card.status}</li>)}</ul>
        {!!result.missingDrafts && <p className="agent-notice">有 {result.missingDrafts} 张原草稿当前无法读取，不推断为已接受。</p>}
      </>}
      <p className="agent-note">在「闪卡收件箱」继续审核。此动作未自动开始复习，也未将事项目标标为完成。</p>
    </>}
    {item.error && <p className="agent-notice">{item.error}</p>}
  </details>;
}
export function AgentBusinessActions({ actions, sourceKind, initialGoal, disabled, revoked, onAction, formsOnly = false }: { formsOnly?: boolean; actions?: AgentActions; sourceKind: "note" | "reading" | "task" | "attachment"; initialGoal: string; disabled: boolean; revoked: boolean; onAction: ActionCall }) {
  const [goal, setGoal] = useState(initialGoal);
  const [deck, setDeck] = useState("收件箱");
  const [target, setTarget] = useState("");
  const deckList = useId();
  if (!actions) return null;
  const records = actions.items.filter((item): item is FlashcardAction | ArchiveAction => item.kind === "flashcardDrafts" || item.kind === "archiveCopy");
  return <section className="agent-business-actions" aria-label="归档与闪卡动作">
    {!revoked && sourceKind === "note" && actions.flashcardDecks && <form onSubmit={event => { event.preventDefault(); if (goal.trim() && deck.trim()) void onAction({ action: "prepareFlashcards", learningGoal: goal.trim(), deckName: deck.trim() }); }}>
      <h3>把来源做成闪卡</h3>
      <label>希望记住什么<input type="text" name="agentFlashcardGoal" required maxLength={2000} disabled={disabled} value={goal} onChange={event => setGoal(event.target.value)} /></label>
      <label>建议牌组<input type="text" name="agentFlashcardDeck" required maxLength={120} list={deckList} disabled={disabled} value={deck} onChange={event => setDeck(event.target.value)} /></label>
      <datalist id={deckList}>{actions.flashcardDecks.map(name => <option key={name} value={name} />)}</datalist>
      <p className="agent-note">只读取当前页面文本和适用制卡偏好，最多准备 5 张草稿；超过 12000 字符的页面请使用原制卡流程。</p>
      <button type="submit" disabled={disabled}>准备闪卡草稿</button>
    </form>}
    {!revoked && sourceKind === "reading" && actions.archiveTargets && <form onSubmit={event => { event.preventDefault(); if (target) void onAction({ action: "prepareArchive", libraryId: target }); }}>
      <h3>归档这份阅读材料</h3>
      {actions.archiveTargets.length ? <>
        <label>归档到<select name="agentArchiveTarget" required disabled={disabled} value={target} onChange={event => setTarget(event.target.value)}><option value="" disabled>选择 Craft 或滴答资料库</option>{actions.archiveTargets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <p className="agent-note">沿原归档流程准备具体方案；Craft 保存归档页，滴答只保存一条保留原文的参考笔记。确认后才保存副本。</p>
        <button type="submit" disabled={disabled}>准备归档方案</button>
      </> : <p className="agent-note">请先连接一个启用的 Craft 或滴答资料库。</p>}
    </form>}
    {!formsOnly && records.map(item => item.kind === "archiveCopy" ? <ArchiveRecord key={item.id} item={item} disabled={disabled} revoked={revoked} onAction={onAction} /> : <FlashcardRecord key={item.id} item={item} disabled={disabled} revoked={revoked} onAction={onAction} />)}
  </section>;
}
