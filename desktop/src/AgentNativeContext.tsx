export type NativeContext={state:string;windowTokens:number|null;lastTokens:number|null;threadTotalTokens:number|null;usedPercent:number|null;nearLimit:boolean|null;previousRevision?:boolean;running?:boolean};
export function AgentNativeContext({value}:{value?:NativeContext|null}){
 if(!value)return null;
 const fmt=(n:number|null)=>n===null?"尚未报告":n.toLocaleString("zh-CN");
 return <details className="agent-progress agent-native-context"><summary>对话上下文：{value.previousRevision?"上一版本记录":value.state==="awaitingUsage"?"等待整理后的用量":value.usedPercent===null?"暂未报告占用":`最近报告约 ${value.usedPercent}%`}</summary>
  <dl><div><dt>最近一次报告的用量</dt><dd>{fmt(value.lastTokens)} Token</dd></div><div><dt>模型窗口</dt><dd>{fmt(value.windowTokens)} Token</dd></div><div><dt>当前提供方线程累计用量</dt><dd>{fmt(value.threadTotalTokens)} Token</dd></div></dl>
  {value.nearLimit&&!value.previousRevision&&<p role="status">最近报告已达到窗口的八成以上。Codex 负责自动压缩；也可在本轮结束后安排下次整理。</p>}
  {value.state==="awaitingUsage"&&<p role="status">已观察到整理事件，等待新的用量报告；当前不沿用整理前的占用数字。</p>}
  <p className="agent-note">这里是提供方最近一次报告与窗口的比值，不是实时精确占用，也不是自动压缩阈值。线程累计用量不代表窗口占用；预算按整个 Hub 对话累计。自动压缩由 Codex 决定，Hub 不重复触发整理。</p>
 </details>;
}
