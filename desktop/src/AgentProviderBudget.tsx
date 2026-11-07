import {useEffect,useRef,useState} from "react";
export type TokenLimits={inputTokens:number;uncachedInputTokens:number;outputTokens:number};
export type ProviderBudget={state:string;reason?:string;limits?:TokenLimits;perRun?:TokenLimits;chargedOrReserved?:TokenLimits;unmeasuredRunIds?:string[];canAdmitRun?:boolean;legacy?:{measured:TokenLimits;unknownRuns:{runId:string;minimum:TokenLimits}[]}};
export type ExecutionBudget={limits?:Record<string,number>;chargedOrReserved?:Record<string,number>;remaining?:Record<string,number>;canAdmitModes?:Record<string,boolean>;reason?:string};
const fields:[keyof TokenLimits,string][]=[["inputTokens","输入 Token"],["uncachedInputTokens","非缓存输入 Token（输入中的一部分）"],["outputTokens","输出 Token"]];
const defaults:TokenLimits={inputTokens:150000,uncachedInputTokens:150000,outputTokens:12000};
const valid=(v:TokenLimits)=>fields.every(([k])=>Number.isSafeInteger(v[k])&&v[k]>0)&&v.uncachedInputTokens<=v.inputTokens;
const fmt=(n:number)=>n.toLocaleString("zh-CN");
export function AgentProviderBudget({value,execution,disabled,onSave}:{value?:ProviderBudget;execution?:ExecutionBudget;disabled:boolean;onSave:(request:Record<string,unknown>)=>Promise<void>}){
 const [limits,setLimits]=useState<TokenLimits>(value?.limits??{inputTokens:600000,uncachedInputTokens:600000,outputTokens:48000});
 const [perRun,setPerRun]=useState<TokenLimits>(value?.perRun??defaults),[confirmed,setConfirmed]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const retry=useRef<{signature:string;id:string}|null>(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{setLimits(value?.limits??{inputTokens:600000,uncachedInputTokens:600000,outputTokens:48000});setPerRun(value?.perRun??defaults);setConfirmed(false);retry.current=null;},[JSON.stringify([value?.limits,value?.perRun])]);
 if(!value)return null;
 const configured=!!value.limits,locked=disabled||saving||value.state==="unavailable";
 const unknown=value.legacy?.unknownRuns??[];
 const reserves=Object.fromEntries(unknown.map(r=>[r.runId,Object.fromEntries(fields.map(([k])=>[k,Math.max(perRun[k],r.minimum[k])]))]));
 const validLimits=valid(limits)&&valid(perRun)&&fields.every(([k])=>perRun[k]<=limits[k])&&(!configured||fields.every(([k])=>limits[k]>=value.limits![k])&&fields.some(([k])=>limits[k]>value.limits![k]));
 async function save(){
  const request=configured?{action:"extendProviderBudget",limits,expectedLimits:value!.limits,reason:"用户在对话预算入口明确追加累计Token额度"}:{action:"freezeProviderBudget",limits,perRun,unknownReservations:reserves};
  const signature=JSON.stringify(request);if(retry.current?.signature!==signature)retry.current={signature,id:crypto.randomUUID()};setSaving(true);setError("");
  try{await onSave({...request,...(configured?{operationId:retry.current.id}:{})});if(alive.current)setConfirmed(false);}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current)setSaving(false);}
 }
 return <details className="agent-progress agent-provider-budget"><summary>模型用量上限：{configured?value.state==="exhausted"?"额度不足":"已设置":"未设置"}</summary>
  <p className="agent-note">首次设置适用于 Codex 原生 Agent；已有预算保持原提供方范围。累计额度属于本对话，重开、恢复和整理上下文都不会清零。保存预算不启动分析。Token 是用量单位；费用未知，此设置用于启动预留与运行中停止，不能保证提供方账单绝不超出。</p>
  {value.reason&&<p role="status">{value.reason}</p>}
  {configured&&<dl>{fields.map(([k,label])=><div key={k}><dt>{label}</dt><dd>已用或预留 {fmt(value.chargedOrReserved?.[k]??0)} / {fmt(value.limits![k])}；剩余 {fmt(Math.max(0,value.limits![k]-(value.chargedOrReserved?.[k]??0)))}</dd></div>)}</dl>}
  {!!value.unmeasuredRunIds?.length&&<p role="status">{value.unmeasuredRunIds.length} 轮用量不完整，已有预留仍计入消费。</p>}
  {!configured&&value.legacy&&<p>旧记录已确认：输入 {fmt(value.legacy.measured.inputTokens)}、非缓存输入 {fmt(value.legacy.measured.uncachedInputTokens)}、输出 {fmt(value.legacy.measured.outputTokens)} Token；将保留在本对话累计用量中。</p>}
  {!!unknown.length&&<div><p role="status">另有 {unknown.length} 轮用量未知。下面逐轮按“本轮预留”和已知下界的较大值保守计入；不是按零计算。</p>{unknown.map(r=><p key={r.runId}>轮次 {r.runId}：{fields.map(([k,label])=>`${label} ${fmt(Math.max(perRun[k],r.minimum[k]))}`).join("；")}</p>)}</div>}
  {value.state!=="unavailable"&&<fieldset disabled={locked}><legend>{configured?"追加累计上限（保留已有消费）":"设置本对话 Token 预算"}</legend>
   {fields.map(([k,label])=><label key={k}>累计上限 · {label}<input type="number" min={1} step={1} value={limits[k]||""} onChange={e=>{setLimits(v=>({...v,[k]:Number(e.target.value)}));setConfirmed(false);}}/></label>)}
   {configured?<p>单轮预留：输入 {fmt(perRun.inputTokens)}、非缓存输入 {fmt(perRun.uncachedInputTokens)}、输出 {fmt(perRun.outputTokens)} Token；保持原设置。</p>:fields.map(([k,label])=><label key={k}>单轮预留 · {label}<input type="number" min={1} step={1} value={perRun[k]||""} onChange={e=>{setPerRun(v=>({...v,[k]:Number(e.target.value)}));setConfirmed(false);}}/></label>)}
   {!validLimits&&<p className="agent-note">填写正整数，非缓存输入不超过输入，单轮不超过累计上限；追加时只能提高累计上限。</p>}
   <label className="agent-card-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认本次额度，并保留全部已用与未知预留</label>
   <button type="button" disabled={!confirmed||!validLimits} onClick={()=>void save()}>{configured?"确认追加额度":"保存预算（不启动分析）"}</button>
  </fieldset>}
  {execution&&<details><summary>执行额度（独立于 Token）</summary><p>快速模式：{execution.canAdmitModes?.quick?"有剩余额度":"不可启动"}；深入模式：{execution.canAdmitModes?.deep?"有剩余额度":"不可启动"}。</p>{execution.reason&&<p>{execution.reason}</p>}<dl>{[["agentSessions","原生会话"],["toolSteps","工具步骤"],["requestBytes","材料字节"]].map(([k,label])=><div key={k}><dt>{label}</dt><dd>{execution.limits?.[k]===undefined?"未知":`${fmt(execution.chargedOrReserved?.[k]??0)} / ${fmt(execution.limits[k])}`}</dd></div>)}</dl><p className="agent-note">Token 追加不会提高这些既有执行限制。</p></details>}
  {error&&<p role="alert">{error}</p>}
 </details>;
}
