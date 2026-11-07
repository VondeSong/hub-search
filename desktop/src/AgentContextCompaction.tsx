export type NativeCompaction = {canRequest:boolean;pending:boolean;operationId?:string|null;latestLifecycle?:{state:string;hostRequested?:boolean;completionProven?:boolean}|null};
export function AgentContextCompaction({value,disabled,onRequest,onCancel}:{value?:NativeCompaction;disabled:boolean;onRequest:()=>void;onCancel:()=>void}){
 if(!value || (!value.canRequest && !value.pending && !value.latestLifecycle))return null;
 const lifecycle=value.latestLifecycle;
 const status=lifecycle?.state==="completed" ? lifecycle.hostRequested && lifecycle.completionProven ? "上下文整理已完成" : "提供方报告上下文压缩完成" : ({requested:"已请求整理，等待确认",acknowledged:"请求已接收，等待整理完成",started:"正在整理上下文",itemCompleted:"整理内容已返回，等待本轮确认",failed:"整理未完成，已保存进展"} as Record<string,string>)[lifecycle?.state||""];
 return <details className="agent-progress"><summary>上下文整理{value.pending?"：已安排":status?`：${status}`:""}</summary>
  {status && <p role="status">{status}</p>}
  <p>这里安排下次继续前的手动整理；Codex 自动压缩由提供方负责。当前成果、原始记录和累计用量保留。</p>
  {value.pending?<button type="button" disabled={disabled} onClick={onCancel}>取消整理安排</button>:<button type="button" disabled={disabled || !value.canRequest} onClick={onRequest}>下次继续时整理上下文</button>}
 </details>;
}
