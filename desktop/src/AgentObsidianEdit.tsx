import { useState } from "react";
import { FileText } from "lucide-react";
import type { AgentActions, ObsidianEditAction } from "./AgentActionTypes";
import { materialKey, type AgentMaterial, type NoteLocator } from "./AgentMaterials";
import "./agent-obsidian-edit.css";

const states: Record<string, string> = { superseded: "已有更新草稿", preparing: "正在准备", prepared: "待你确认", executing: "正在保存", saved: "已保存，待核对索引", verified: "保存已核验", expired: "原文件或依据已变化", interrupted: "已中断", needs_review: "结果待核对", unknown: "结果待核对" };
export function AgentObsidianTarget({ targets, current, disabled, onAction }: { targets: AgentMaterial[]; current?: NoteLocator | null; disabled: boolean; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const currentKey = current ? materialKey(current) : "";
  const [selected, setSelected] = useState(currentKey);
  const target = targets.find(item => materialKey(item.locator) === selected);
  return <section className="agent-obsidian-edit" aria-label="选择保存目标">
    <form onSubmit={event => { event.preventDefault(); if (!selected || target) void onAction({ action: "selectObsidianTarget", target: target?.locator ?? null }); }}>
      <label>保存到哪篇笔记<select value={selected} disabled={disabled} onChange={event => setSelected(event.target.value)}>
        <option value="">不指定保存目标</option>
        {targets.map(item => <option key={materialKey(item.locator)} value={materialKey(item.locator)}>{item.libraryName} · {item.path}</option>)}
      </select></label>
      <p className="agent-note">只列出已授权的 Obsidian 笔记。选择目标不会保存内容；之后仍需预览并确认。</p>
      {!targets.length && <p className="agent-note">请先从＋添加要保存到的 Obsidian 笔记。</p>}
      <button type="submit" disabled={disabled || selected === currentKey || (!!selected && !target)}>确认保存目标</button>
    </form>
  </section>;
}
export function AgentReportSave({ actions, disabled, onAction }: { actions?: AgentActions; disabled: boolean; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const target = actions?.obsidianReportTarget;
  if (!target) return null;
  return <section className="agent-obsidian-edit agent-report-save" aria-label="保存当前报告">
    <div className="agent-result-heading"><FileText size={17} aria-hidden="true"/><strong>保存报告到 Obsidian</strong></div>
    <p className="agent-result-path">{target.path}</p>
    <p className="agent-note">先预览，确认后追加；保留原有正文和属性。</p>
    <button type="button" disabled={disabled} onClick={() => void onAction({ action: "prepareObsidianReportSave" })}>预览追加当前报告</button>
  </section>;
}
export function AgentObsidianEdit({ actions, disabled, revoked, onAction, formsOnly = false, recordsOnly = false, verificationPending = false }: { verificationPending?: boolean; formsOnly?: boolean; recordsOnly?: boolean; actions?: AgentActions; disabled: boolean; revoked: boolean; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const [instruction, setInstruction] = useState("");
  const records = actions?.items.filter((a): a is ObsidianEditAction => a.kind === "obsidianEdit") ?? [];
  if (!actions?.obsidianEditAvailable && !records.length) return null;
  if (revoked) return <section aria-label="Obsidian 笔记编辑"><p className="agent-note">笔记编辑授权已撤回，修改内容已隐藏。</p></section>;
  return <section className="agent-obsidian-edit" aria-label="Obsidian 笔记编辑">
    {!recordsOnly && <h3>修改 Obsidian 笔记</h3>}
    {!recordsOnly && actions?.obsidianEditAvailable && <form onSubmit={event => { event.preventDefault(); if (instruction.trim()) void onAction({ action: "prepareObsidianEdit", instruction: instruction.trim() }); }}>
      <label>希望怎样修改<textarea name="obsidianEditInstruction" value={instruction} onChange={event => setInstruction(event.target.value)} required maxLength={2000} rows={2} disabled={disabled} placeholder="例如：整理结构，保留原意，为相关内容补充双链" /></label>
      <p className="agent-note">先生成草稿，查看后再确认保存到原文件。每次修改一篇 UTF-8 笔记，正文最多 12000 字符。笔记属性保持原样；新增双链仅使用当前授权内已核对的笔记。</p>
      <button type="submit" disabled={disabled || !instruction.trim()}>准备笔记修改</button>
    </form>}
    {!formsOnly && records.map(item => <article key={item.id} className="agent-action-record agent-note-result" aria-label="笔记操作结果">
      <div className="agent-result-heading"><FileText size={17} aria-hidden="true"/><strong>{item.payload?.mode === "reportUndo" ? "撤回报告追加" : item.payload?.mode === "restore" ? "恢复写前版本" : item.payload?.mode === "reportAppend" ? "报告追加" : "笔记修改"}</strong><span className="agent-result-state">{verificationPending ? "结果待核对" : states[item.state] || item.state}</span></div>
      {item.payload && <><p className="agent-result-path">{item.payload.path}</p><p className="agent-result-summary">{item.payload.summary}</p>
        {!!item.payload.warnings.length && <ul>{item.payload.warnings.map((text, i) => <li key={i}>{text}</li>)}</ul>}
      </>}
      {verificationPending && <p className="agent-notice" role="status">保存结果尚未核对，已暂停再次提交。</p>}
      {!verificationPending && item.receipt && <p className="agent-result-receipt" role="status">{item.receipt.fileVerified ? item.receipt.indexed ? "已保存并回读核验" : "原文件已保存，Hub 索引更新尚需核对" : "写入结果待核对，请先核对保存结果"}</p>}
      <details className="agent-result-details">
      <summary>查看变更与保存记录</summary>
      {verificationPending && item.receipt && <p className="agent-note">以下为上次保存回执，当前操作结果仍待核对。</p>}
      {item.payload && <>
        <div className="agent-note-comparison">
          <details><summary>修改前的完整文件</summary><pre>{item.payload.before}</pre></details>
          <details open={item.state === "prepared"}><summary>修改后的完整文件</summary><pre>{item.payload.after}</pre></details>
        </div>
      </>}
      {item.receipt && <p className="agent-note">{item.receipt.fileVerified ? item.receipt.indexed ? "这次保存已回读核验，Hub 正文已更新；搜索索引按现有队列更新。" : "原文件已核验保存，Hub 索引更新尚需核对。" : "这次写入尚未取得完整保存证明，请先核对结果。"} 此回执不代表文件之后没有被其他程序修改。</p>}
      </details>
      {item.undoUnavailableReason && <p className="agent-note">{item.undoUnavailableReason}</p>}
      {item.error && <p className="agent-notice" role="status">{item.error}</p>}
      {item.inspectionBudget?.canInspect===false && <p className="agent-note" role="status">{item.inspectionBudget.reason}</p>}
      {item.state === "expired" && <p className="agent-note">旧批准已失效，草稿已保留。请按当前原文件重新准备修改。</p>}
      {item.state === "expired" && item.conflict && <section aria-label="撤回草稿冲突核对">
        {item.conflict.current !== undefined && <>
          <details><summary>冲突时核对的当前完整文件</summary><pre>{item.conflict.current}</pre></details>
          <p className="agent-note">这是本次核对时的内容，未锁定后续修改。旧草稿不会直接保存；重新预览后仍需确认。</p>
        </>}
        {item.conflict.unavailableReason && <p className="agent-note">{item.conflict.unavailableReason}</p>}
        {!verificationPending && item.conflict.reprepareActionId && <button type="button" disabled={disabled} onClick={() => void onAction({ action: "restoreObsidianEdit", actionId: item.conflict!.reprepareActionId })}>按当前文件重新预览撤回</button>}
      </section>}
      {!verificationPending && (item.state === "prepared" || item.state === "interrupted") && item.payload && item.confirmationToken && <>
        <p className="agent-note">保存前会再次核对原文件；发现外部修改会停止保存。写前版本会保留，供你核对和恢复。</p>
        <button type="button" disabled={disabled} onClick={() => void onAction({ action: "submitObsidianEdit", actionId: item.id, confirmationToken: item.confirmationToken })}>{item.payload.mode === "reportUndo" ? "确认撤回本次报告追加" : item.payload.mode === "restore" ? "确认恢复到原文件" : item.payload.mode === "reportAppend" ? "确认追加报告到原文件" : "确认保存到原文件"}</button>
      </>}
      {item.receipt && <>
        {["saved", "needs_review", "executing"].includes(item.state) && <button type="button" disabled={disabled || item.inspectionBudget?.canInspect===false} onClick={() => void onAction({ action: "inspectObsidianEdit", actionId: item.id })}>核对保存结果</button>}
        {!verificationPending && item.canRestore && <button type="button" disabled={disabled} onClick={() => void onAction({ action: "restoreObsidianEdit", actionId: item.id })}>{item.payload?.mode === "reportAppend" ? "预览撤回本次报告追加" : "预览恢复写前版本"}</button>}
      </>}
    </article>)}
  </section>;
}
