import { FlashcardQualityAI, type QualityAIRecord } from "./FlashcardQualityAI";
import { FlashcardQualityHistory } from "./FlashcardQualityHistory";
import { useVisiblePolling } from "./useVisiblePolling";
import { SerialRefresh } from "./SerialRefresh";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { X, MessageSquare, Download, Plus, Pencil } from "lucide-react";
import type { Flashcard, FlashcardDraft, FlashcardDeckSummary } from "./FlashcardTypes";
import "./FlashcardQuality.css";

const REASONS: Record<string,string> = {"low-value":"不值得记忆","goal-mismatch":"不符合学习目标",incorrect:"错误或过时",ambiguous:"问法不清楚",compound:"一张卡问得太多",duplicate:"重复内容",media:"答案或附件有问题",positive:"这张卡很好"};
type Rule = { id?:string; kind?:string; updatedAt?:number; title:string; text:string; scopeType:"global"|"deck"|"topic"; scopeValue:string; learningGoal:string; exceptions:string; positiveExample:string; negativeExample:string; enabled:boolean; feedbackId?:string };
type Feedback = { id:string; kind:string; updatedAt:number; createdAt?:number; cardId:string; draft:boolean; reason:string; comment:string; action:string; status:string; excludeTarget:boolean; snapshot:Flashcard|FlashcardDraft };
type State = { records:Array<Rule|Feedback|QualityAIRecord>; document:string; revision:string; sync?:{enabled:boolean;pending:boolean;error:string;lastSuccess?:number;running?:boolean} };
export type QualityTarget = { card:Flashcard|FlashcardDraft; draft:boolean };
const blankRule = ():Rule => ({title:"",text:"",scopeType:"global",scopeValue:"",learningGoal:"",exceptions:"",positiveExample:"",negativeExample:"",enabled:true});
function RuleFields({rule,setRule,decks}:{rule:Rule;setRule:(r:Rule)=>void;decks:FlashcardDeckSummary[]}) {
  const field=(key:keyof Rule,value:string)=>setRule({...rule,[key]:value});
  return <div className="quality-rule-fields">
    <label>规则名称<input value={rule.title} maxLength={120} onChange={e=>field("title",e.target.value)} placeholder="例如：学习原理时，配置片段作为参考"/></label>
    <label>以后如何制卡<textarea value={rule.text} maxLength={4000} rows={3} onChange={e=>field("text",e.target.value)} placeholder="说明希望测试什么、排除什么；避免把单个例子扩大成通用禁令"/></label>
    <div className="quality-field-row"><label>适用范围<select value={rule.scopeType} onChange={e=>setRule({...rule,scopeType:e.target.value as Rule["scopeType"],scopeValue:""})}><option value="global">所有制卡任务</option><option value="deck">指定牌组</option><option value="topic">指定主题</option></select></label>{rule.scopeType==="deck" ? <label>牌组<select value={rule.scopeValue} onChange={e=>field("scopeValue",e.target.value)}><option value="">选择牌组</option>{decks.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label> : rule.scopeType==="topic" ? <label>主题<input value={rule.scopeValue} onChange={e=>field("scopeValue",e.target.value)} placeholder="对应制卡时的主题或标签"/></label> : null}</div>
    <label>学习目标关键词（可选）<input value={rule.learningGoal} onChange={e=>field("learningGoal",e.target.value)} placeholder="例如：原理；留空则不限制学习目标"/></label>
    <label>例外条件<textarea value={rule.exceptions} rows={2} onChange={e=>field("exceptions",e.target.value)} placeholder="例如：明确要求记忆操作命令时允许"/></label>
    <div className="quality-field-row"><label>希望出现的例子<textarea value={rule.positiveExample} rows={2} onChange={e=>field("positiveExample",e.target.value)}/></label><label>不希望出现的例子<textarea value={rule.negativeExample} rows={2} onChange={e=>field("negativeExample",e.target.value)}/></label></div>
    <label className="quality-check"><input type="checkbox" checked={rule.enabled} onChange={e=>setRule({...rule,enabled:e.target.checked})}/>启用此规则，供以后制卡参考</label>
  </div>;
}

export function FlashcardQuality({target,decks,onClose,onSaved,onOpenCard,onChanged}:{target?:QualityTarget;decks:FlashcardDeckSummary[];onClose:()=>void;onSaved:(action:string,target:QualityTarget)=>void;onOpenCard:(id:string)=>void;onChanged:(id?:string)=>Promise<void>}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const [data,setData]=useState<State>({records:[],document:"",revision:""});
  const [tab,setTab]=useState<"feedback"|"rules"|"document"|"ai"|"history">("feedback");
  const [reason,setReason]=useState("low-value");const [comment,setComment]=useState("");
  const [exclude,setExclude]=useState(false);const [makeRule,setMakeRule]=useState(false);
  const [rule,setRule]=useState<Rule>(()=>({...blankRule(),...(target && "deckId" in target.card ? {scopeType:"deck",scopeValue:target.card.deckId} : {})}));
  const [impact,setImpact]=useState<{count:number;cards:{id:string;question:string}[];note:string}|null>(null);
  const [editing,setEditing]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState("");const [notice,setNotice]=useState("");const [filter,setFilter]=useState("all");
  const [syncState,setSyncState]=useState("");
  const syncing=useRef(false);
  const mounted=useRef(true), refreshQueue=useRef(new SerialRefresh());
  const [syncBusy,setSyncBusy]=useState(false);
  const syncQuality=async()=>{if(syncing.current)return;syncing.current=true;setSyncBusy(true);setSyncState("正在同步…");try{await invoke("sync_flashcards");if(mounted.current)setSyncState("质量记录已同步");}catch{if(mounted.current)setSyncState("暂未同步，记录已保存在本机；联网后会重试，也可从闪卡云同步手动同步");}finally{await refresh().catch(()=>{});syncing.current=false;if(mounted.current)setSyncBusy(false);}};
  const refresh=(fresh=true)=>refreshQueue.current.run("quality",async()=>{if(!mounted.current)return;const next=await invoke<State>("get_flashcard_quality");if(mounted.current)setData(next);},fresh);
  useEffect(()=>{mounted.current=true;dialog.current?.showModal();if(!target)void refresh().catch(e=>setError(String(e)));return()=>{mounted.current=false;};},[]);
  useVisiblePolling(()=>refresh(false),!target,5000,{initialDelayMs:5000});
  const close=()=>{if(busy)return;if((target&&(comment||makeRule))||editing){if(!window.confirm("放弃尚未保存的质量反馈或规则？"))return;}onClose();};
  const run=async(job:()=>Promise<void>)=>{setBusy(true);setError("");try{await job();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const submit=(action:string)=>void run(async()=>{
    if(!target)return;
    await invoke("submit_flashcard_feedback",{input:{cardId:target.card.id,draft:target.draft,reason,comment,action,excludeTarget:reason==="positive"?false:exclude,...(makeRule?{rule}: {})}});
    onSaved(action,target);onClose();
  });
  const saveRule=()=>void run(async()=>{await invoke("save_flashcard_quality_rule",{rule});setEditing(false);await refresh();setNotice("规则已保存，下次制卡读取后生效");});
  const updateFeedback=(f:Feedback,status=f.status,excludeTarget=f.excludeTarget)=>void run(async()=>{await invoke("update_flashcard_feedback",{id:f.id,expectedUpdatedAt:f.updatedAt,status,excludeTarget});await refresh();});
  const rules=data.records.filter(r=>r.kind==="rule") as Rule[];
  const feedback=(data.records.filter(r=>r.kind==="feedback") as Feedback[]).sort((a,b)=>b.updatedAt-a.updatedAt);
  return <dialog ref={dialog} className="flashcard-quality" aria-labelledby="quality-title" onCancel={e=>{e.preventDefault();close();}} onKeyDown={e=>e.stopPropagation()}>
    <header><div><h2 id="quality-title"><MessageSquare size={20}/>{target?"反馈这张卡片":"质量与制卡偏好"}</h2><p>{target?"记录卡片问题或优点，不会改变你的复习评分":"保存个人标准，让下次制卡参考你的反馈"}</p></div><button onClick={close} disabled={busy} aria-label="关闭质量反馈"><X size={20}/></button></header>
    {error&&<p className="quality-error" role="alert">{error}</p>}{notice&&<p className="quality-notice" role="status">{notice}</p>}{!target&&<div className="quality-toolbar"><p className="quality-notice" role="status">{syncBusy||data.sync?.running ? "正在同步…" : data.sync ? !data.sync.enabled ? "记录保存在本机；开启闪卡云同步后可同步到其他设备" : data.sync.error ? "同步失败，记录已保存在本机；请检查网络或云同步设置后重试" : data.sync.pending ? "有本机更改等待同步" : data.sync.lastSuccess ? "已同步至云端，其他设备将在同步后收到" : "记录已保存在本机，尚未完成云同步" : syncState}{!!data.sync?.lastSuccess&&<small> · 上次成功：{new Date(data.sync.lastSuccess*1000).toLocaleString()}</small>}</p>{data.sync?.enabled&&<button disabled={syncBusy||data.sync.running} onClick={()=>void syncQuality()}>立即同步</button>}</div>}
    {target?<>
      <blockquote className="quality-card-title">{target.card.question}</blockquote>
      <label>反馈类型<select value={reason} onChange={e=>setReason(e.target.value)}>{Object.entries(REASONS).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label>我的反馈<textarea autoFocus rows={4} value={comment} maxLength={4000} onChange={e=>setComment(e.target.value)} placeholder="例如：这段配置随环境变化，应该学习背后的原理，不必背具体值。"/></label>
      {reason!=="positive"&&<label className="quality-check"><input type="checkbox" checked={exclude} onChange={e=>setExclude(e.target.checked)}/>避免再次生成这个记忆目标（可在反馈记录中取消）</label>}
      <label className="quality-check"><input type="checkbox" checked={makeRule} onChange={e=>setMakeRule(e.target.checked)}/>将这条反馈用于以后制卡</label>
      {makeRule&&<RuleFields rule={rule} setRule={setRule} decks={decks}/>}
      <footer><button disabled={busy} onClick={()=>submit("record")}>记录并继续</button>{!target.draft&&<><button disabled={busy} onClick={()=>submit("pause")}>记录并暂停此卡</button><button disabled={busy} onClick={()=>submit("edit")}><Pencil size={14}/>记录后编辑</button></>}</footer>
    </>:<>
      <nav className="quality-tabs">{([['feedback',`反馈记录 ${feedback.length}`],['rules',`制卡规则 ${rules.filter(r=>r.enabled).length}`],['ai','AI 改进'],['history','修改历史'],['document','质量文档']] as const).map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>{if(editing&&!window.confirm("放弃未保存的规则？"))return;setEditing(false);setTab(id);}}>{label}</button>)}</nav>
      {tab==="history"&&<FlashcardQualityHistory records={data.records as unknown as Record<string,unknown>[]} decks={decks}/>}
      {tab==="ai"&&<FlashcardQualityAI records={data.records as QualityAIRecord[]} decks={decks} refresh={refresh} onChanged={onChanged}/>}
      {tab==="feedback"&&<><details className="quality-trends"><summary>反馈变化 · 最近 30 天与之前 30 天</summary><p>按反馈创建时间计数；数量受复习量影响，无反馈不代表质量更好。</p>{Object.entries(REASONS).map(([key,label])=>{const count=(start:number,end:number)=>feedback.filter(f=>f.reason===key&&Date.now()-(f.createdAt??f.updatedAt)>=start*86400000&&Date.now()-(f.createdAt??f.updatedAt)<end*86400000).length;return <div key={key}><span>{label}</span><span>{count(30,60)} → {count(0,30)}</span></div>;})}</details><div className="quality-toolbar"><select aria-label="筛选反馈状态" value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部反馈</option><option value="open">待处理</option><option value="resolved">已处理</option></select><small>待处理 {feedback.filter(f=>f.status==="open").length} · 正向反馈 {feedback.filter(f=>f.reason==="positive").length}</small></div>{feedback.length===0&&<p className="quality-empty">复习或查看收件箱时，点击“反馈”记录你的想法。</p>}{feedback.filter(f=>filter==="all"||f.status===filter).map(f=><article key={f.id} className="quality-entry"><header><strong>{REASONS[f.reason]??f.reason}</strong><small>{new Date(f.updatedAt).toLocaleString()} · {f.status==="open"?"待处理":"已处理"}</small></header><p>{f.comment||"未填写补充说明"}</p><details><summary>{f.snapshot.question}</summary><div data-selectable="true"><p>答案：{f.snapshot.answer}</p><p>解释：{f.snapshot.explanation}</p><p>来源：{f.snapshot.sourceTitle||f.snapshot.sourcePath||"未提供"}</p><p>处理：{f.action==="pause"?"暂停此卡":f.action==="edit"?"进入编辑":"仅记录"}</p></div></details><footer><button disabled={busy} onClick={()=>updateFeedback(f,f.status==="open"?"resolved":"open")}>{f.status==="open"?"标记已处理":"重新打开"}</button><button disabled={busy} onClick={()=>updateFeedback(f,f.status,!f.excludeTarget)}>{f.excludeTarget?"取消避免重复":"避免重复生成"}</button><button onClick={()=>{setRule({...blankRule(),feedbackId:f.id,negativeExample:f.reason==="positive"?"":f.snapshot.question,positiveExample:f.reason==="positive"?f.snapshot.question:""});setTab("rules");setEditing(true);}}>整理为规则</button>{!f.draft&&<button onClick={()=>onOpenCard(f.cardId)}>查看原卡</button>}</footer></article>)}</>}
      {tab==="rules"&&<>{editing?<><RuleFields rule={rule} setRule={setRule} decks={decks}/><footer><button disabled={busy} onClick={saveRule}>保存规则</button><button disabled={busy} onClick={()=>{if(window.confirm("放弃未保存的规则？"))setEditing(false);}}>取消</button></footer></>:<><div className="quality-toolbar"><span>具体牌组和主题的规则优先于通用规则</span><button onClick={()=>{setRule(blankRule());setEditing(true);}}><Plus size={14}/>新建规则</button></div>{rules.length===0&&<p className="quality-empty">暂无长期规则。可以从反馈整理，也可以直接新建。</p>}{rules.map(r=><article key={r.id} className="quality-entry"><header><strong>{r.title||"制卡规则"}</strong><small>{r.enabled?"生效":"已停用"} · {r.scopeType==="global"?"全部任务":r.scopeType==="deck"?decks.find(d=>d.id===r.scopeValue)?.name??"原牌组":r.scopeValue}</small></header><p>{r.text}</p>{r.exceptions&&<p>例外：{r.exceptions}</p>}<footer><button onClick={()=>{setRule(r);setEditing(true);}}>编辑</button><button disabled={busy} onClick={()=>void run(async()=>setImpact(await invoke("preview_flashcard_quality_impact",{ruleId:r.id,deckId:null})))}>查看影响范围</button><button disabled={busy} onClick={()=>void run(async()=>{await invoke("save_flashcard_quality_rule",{rule:{...r,enabled:!r.enabled}});await refresh();})}>{r.enabled?"停用":"启用"}</button></footer></article>)}</>}</>}
      {tab==="rules"&&impact&&<aside className="quality-entry"><strong>范围内共 {impact.count} 张卡片</strong><p>{impact.note}</p><p>前 30 张预览；可在“AI 改进”中选择牌组检查。</p>{impact.cards.map(c=><p key={c.id}>{c.question}</p>)}<button onClick={()=>setImpact(null)}>收起</button></aside>}
      {tab==="document"&&<><div className="quality-toolbar"><span>根据当前记录生成，修改后自动更新</span><button disabled={busy} onClick={()=>void run(async()=>{if(document.documentElement.dataset.runtimePlatform==="android"){await invoke("export_flashcard_quality",{destination:""});setNotice("请在系统对话框中完成保存");return;}const destination=await save({defaultPath:"闪卡质量与制卡偏好.md",filters:[{name:"Markdown",extensions:["md"]}]});if(destination){await invoke("export_flashcard_quality",{destination});setNotice("质量文档已导出");}})}><Download size={14}/>导出文档</button></div><pre data-selectable="true">{data.document}</pre></>}
    </>}
  </dialog>;
}
