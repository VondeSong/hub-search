import { useEffect, useState } from "react";

import type { AgentActions, TagAction } from "./AgentActionTypes";
export type { AgentActions } from "./AgentActionTypes";
const decisions: Record<string, string> = { recommend_add: "建议补标", related_only: "仅相关", out_of_scope: "不在标签范围", insufficient_evidence: "证据不足" };
const states: Record<string, string> = { preparing: "正在准备", prepared: "待你确认提交", verified: "提交结果已核验", interrupted: "准备已中断", expired: "建议已失效" };
const reviewStates: Record<string, string> = { pending: "待审核", accepted: "已批准", rejected: "已驳回", withdrawn: "已撤回" };

export function AgentTagAction({ actions, disabled, revoked, onAction }: { actions?: AgentActions; disabled: boolean; revoked: boolean; onAction: (args: Record<string, unknown>) => Promise<void> }) {
  const [tag, setTag] = useState("");
  useEffect(() => { if (tag && !actions?.tagOptions.includes(tag)) setTag(""); }, [tag, actions?.tagOptions]);
  if (!actions) return null;
  const prepareDisabled=disabled || actions.standaloneModelDrafts?.allowed===false;
  return <section className="agent-tag-action" aria-label="受控补标建议">
    <h3>把调查推进一步</h3>
    {!revoked && (actions.tagOptions.length ? <form onSubmit={event => { event.preventDefault(); if (tag && !prepareDisabled) void onAction({ action: "prepareTagProposal", tag }); }}>
      <label>为当前笔记核对标签<select name="agentActionTag" required value={tag} disabled={prepareDisabled} onChange={event => setTag(event.target.value)}>
        <option value="" disabled>选择已确认定义的标签</option>
        {actions.tagOptions.map(option => <option key={option} value={option}>{option}</option>)}
      </select></label>
      <p className="agent-note">当前模型将读取选定标签的定义、当前页面节选与该内容的审核记录，准备一条建议。查看并提交后才会进入待审核。</p>
      <button type="submit" disabled={prepareDisabled}>准备补标建议</button>
    </form> : <p className="agent-note">如需准备补标建议，请先在「标签治理」确认本资料库的标签定义。这里每次显示最多 100 个已定义标签。</p>)}
    {actions.items.filter((item): item is TagAction => !item.kind || item.kind === "tagProposal").map((item, index) => {
      const draft = item.payload;
      const receipt = item.receipt;
      const proposal = item.currentProposal && "status" in item.currentProposal ? item.currentProposal : null;
      return <details key={item.id} open={index === 0} className="agent-action-record">
        <summary>{draft ? `补标「${draft.tag}」` : "补标建议"} · {states[item.state] || item.state}</summary>
        {item.state === "prepared" && draft && <>
          <p><strong>{decisions[draft.decision] || draft.decision}</strong> · 对象：当前笔记页面</p>
          <blockquote>{draft.quote}</blockquote>
          <p>{draft.rationale}</p>
          {draft.risks && <p>风险与局限：{draft.risks}</p>}
          {draft.reconsiderationReason && <p>重新考虑的依据：{draft.reconsiderationReason}</p>}
          <p className="agent-note">提交会在 Hub 的标签审核流程中登记建议。调查授权本身不会执行这一步。</p>
          <button type="button" disabled={disabled || !item.confirmationToken} onClick={() => void onAction({ action: "submitTagProposal", actionId: item.id, confirmationToken: item.confirmationToken })}>提交「{draft.tag}」到待审核</button>
        </>}
        {receipt && <>
          <p>{receipt.result.existing || receipt.result.replayed ? "已关联现有建议" : "建议已提交"} · 标签审核状态：{proposal ? reviewStates[proposal.status] || proposal.status : "当前状态无法读取"}</p>
          <p className="agent-note">源标签没有因这次提交而改变。请在「标签治理」审核；事项目标是否完成仍需继续核对。</p>
        </>}
        {item.error && <p className="agent-notice">{item.error}</p>}
      </details>;
    })}
  </section>;
}
