import { AgentToolResult, type ToolResultScope } from "./AgentToolResult";

type WorkingEntry = {entryId:string;kind:"observation"|"conclusion"|"statistic";value:string|null;status:"proposed"|"observed"|"stale";invalidReason?:string|null;evidenceRefs:{recordId:string;sha256:string}[];metric?:{metric:string;unit:string;filters:string[];timeBasis:string;coverage:string}|null};
export type WorkingState = {schemaVersion?:number;revision?:number;sequence?:string;state?:"unavailable";reason?:string;entries:WorkingEntry[];pendingTargets:{actionId:string;kind?:string;state:string;reason?:string;needsRevalidation?:boolean}[];unresolvedQuestions:string[];questionsNeedReview?:boolean};
export function AgentWorkingState({value,scope}:{value:WorkingState;scope:ToolResultScope}) {
  if(value.state!=="unavailable" && !value.entries.length && !value.pendingTargets.length && !value.unresolvedQuestions.length && !value.questionsNeedReview)return null;
  return <details className="agent-working-state"><summary>工作记录{value.revision!==undefined?` · 第 ${value.revision} 版`:""}</summary>
    <p className="agent-note">辅助工作笔记。目标和步骤仍以上方记录为准，模型结论仍需核对。</p>
    {value.state==="unavailable"?<p role="status">工作记录暂不可读，原目标与成果保留。{value.reason}</p>:<>
      {value.entries.map(entry=><section aria-label={entry.kind==="conclusion"?"模型结论":entry.kind==="statistic"?"统计记录":"模型观察"} key={entry.entryId}>
        <strong>{entry.status==="stale"?"依据已失效":entry.status==="proposed"?"待核对": "模型已记录，引用可核对"}</strong>
        {entry.status==="stale"?<p>{entry.invalidReason || "来源或目标已变化，请重新核对。"}</p>:<>
          <p className="agent-action-text">{entry.value}</p>
          {entry.metric && <p className="agent-note">{entry.metric.metric} · {entry.metric.unit}；口径：{entry.metric.timeBasis}；覆盖：{entry.metric.coverage}{entry.metric.filters.length?`；条件：${entry.metric.filters.join("、")}`:""}</p>}
          {entry.evidenceRefs.map(ref=><AgentToolResult key={ref.recordId} value={ref} scope={scope}/>)}
        </>}
      </section>)}
      {!!value.pendingTargets.length && <div><strong>关联操作</strong><ul>{value.pendingTargets.map(target=><li key={target.actionId}>{target.kind==="obsidianEdit"?"笔记修改":target.kind==="flashcardDrafts"?"闪卡草稿":target.kind==="archiveCopy"?"归档草稿":"已有关联操作"} · {target.needsRevalidation ? "需重新核对" : ({prepared:"待确认",verified:"结果已核验",executing:"处理中",unknown:"结果待核对",reconciliation_required:"需要核对",unavailable:"暂不可用"} as Record<string,string>)[target.state] || "请查看原操作记录"}{target.reason?`：${target.reason}`:""}</li>)}</ul><p className="agent-note">记录关联不会提交或确认操作。</p></div>}
      {!!value.unresolvedQuestions.length && <div><strong>待核对问题</strong><ul>{value.unresolvedQuestions.map((q,n)=><li key={n}>{q}</li>)}</ul></div>}
      {value.questionsNeedReview && <p className="agent-note">目标已变化，旧问题须重新核对，未继续作为当前问题呈现。</p>}
    </>}
  </details>;
}
