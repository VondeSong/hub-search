import type {InsightMethodDependency} from "./InsightTypes";

export function InsightMethods({entries}:{entries?:InsightMethodDependency[]}){
 if(!entries?.length)return null;
 return <details className="insights-methods"><summary>分析方法与工作约定 · {entries.length} 项</summary><p className="insights-muted">这些是本轮使用的处理方法，已记录版本，不计为资料事实依据。</p><ul>{entries.map((entry,index)=><li key={index}>{entry.title}{entry.kind==="skillReference"?" · 配套方法":""}</li>)}</ul></details>;
}
