'use client';
import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,Check,ChevronDown,ChevronRight,MessageSquare,RefreshCw,RotateCcw,ShieldCheck,Sparkles,X} from 'lucide-react';
import type { AssistantContext } from './Assistant';
import { taskStates } from './task-data';
import {adoptionError,analysisRevision,buildTaskAdvice,shortRevisionHash,type AnalysisMemory,type AnalysisRequest,type AnalysisTask,type ReadMode,type TaskAdvice,type TaskEvidence} from './task-analysis-model';

const steps=['读取聚合数据','刷新来源','分析建议','选择采纳'];
const modeTitle={today:'安排今天',project:'梳理项目',task:'推进任务'};
type Props={request:AnalysisRequest;tasks:AnalysisTask[];evidence:Record<string,TaskEvidence[]>;memory:AnalysisMemory;day:string;onClose:()=>void;onRefresh:()=>void;onTask:(id:string)=>void;onDiscuss:(context:AssistantContext)=>void;onAdopt:(advice:TaskAdvice,beforeText?:string)=>string;onSource:(id:string,text:string)=>boolean};

export default function TaskAnalysis({request,tasks,evidence,memory,day,onClose,onRefresh,onTask,onDiscuss,onAdopt,onSource}:Props){
 const [phase,setPhase]=useState(-1),[readMode,setReadMode]=useState<ReadMode>('fresh'),[refreshFirst,setRefreshFirst]=useState(true),[advice,setAdvice]=useState<TaskAdvice[]>([]),[readAt,setReadAt]=useState(''),[snapshot,setSnapshot]=useState<AnalysisTask[]>([]),[error,setError]=useState(''),[preview,setPreview]=useState(''),[outcome,setOutcome]=useState('success'),[results,setResults]=useState<Record<string,string>>({});
 const [traceOpen,setTraceOpen]=useState(false);
 const [beforeSnapshots,setBeforeSnapshots]=useState<Record<string,{before:string;after:string}>>({});
 const latest=useRef({tasks,evidence,onRefresh,onClose});latest.current={tasks,evidence,onRefresh,onClose};
 const [runOptions,setRunOptions]=useState({refresh:true,readMode:'fresh' as ReadMode});
 const generation=useRef(0),timers=useRef<ReturnType<typeof setTimeout>[]>([]),heading=useRef<HTMLHeadingElement>(null);
 const content=useRef<HTMLDivElement>(null);
 useEffect(()=>{heading.current?.focus({preventScroll:true});const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!document.querySelector('dialog[open]')){event.preventDefault();event.stopPropagation();latest.current.onClose();}};window.addEventListener('keydown',key);return()=>{generation.current++;timers.current.forEach(clearTimeout);window.removeEventListener('keydown',key);};},[]);
 const working=phase>=0&&phase<3;
 function run(){
  if(Object.values(results).some(r=>r==='unknown'||r==='failed')){setError('请先核对或处理上次模拟保存的结果，再重新分析。');return;}
  const current=++generation.current;timers.current.forEach(clearTimeout);setRunOptions({refresh:refreshFirst,readMode});setError('');setPreview('');setAdvice([]);setResults({});setTraceOpen(false);setPhase(0);
  const after=(ms:number,fn:()=>void)=>timers.current.push(setTimeout(()=>{if(current===generation.current)fn();},ms));
  after(400,()=>{setSnapshot(latest.current.tasks.filter(t=>request.taskIds.includes(t.id)));setPhase(1);if(refreshFirst)latest.current.onRefresh();});
  after(1050,()=>{setPhase(2);setSnapshot(latest.current.tasks.filter(t=>request.taskIds.includes(t.id)));});
  after(1550,()=>{const data=latest.current.tasks.filter(t=>request.taskIds.includes(t.id));setSnapshot(data);setAdvice(buildTaskAdvice(data,request,latest.current.evidence,refreshFirst?readMode:'cached',day));setReadAt(new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}));setPhase(3);requestAnimationFrame(()=>{if(current!==generation.current)return;if(content.current)content.current.scrollTop=0;heading.current?.focus({preventScroll:true});});});
 }
 const effectiveMode=runOptions.refresh?runOptions.readMode:'cached';
 const stale=advice.some(a=>{const t=tasks.find(t=>t.id===a.taskId);return !!t&&analysisRevision(t)!==a.revision&&!memory.receipts.some(r=>r.id===a.id)&&results[a.id]!=='adopted';});
 function adopt(a:TaskAdvice,write=false){
  setError('');const currentTask=latest.current.tasks.find(t=>t.id===a.taskId);
  const problem=adoptionError(currentTask,a,effectiveMode);
  if(problem){setError(problem);return;}
  if(a.kind==='source'&&!write){setPreview(a.id);setOutcome('success');return;}
  const beforeText=currentTask?.description??'';
  if(a.kind==='source'){
   if(outcome==='failure'){setResults(old=>({...old,[a.id]:'failed'}));setPreview('');return;}
   if(outcome==='unknown'){setResults(old=>({...old,[a.id]:'unknown'}));setPreview('');return;}
   if(!onSource(a.taskId,a.text)){setError('模拟任务说明未能保存，请检查浏览器存储后再试。');return;}
   setBeforeSnapshots(old=>({...old,[a.id]:{before:beforeText,after:a.text}}));
  }
  const warning=onAdopt(a,beforeText);if(warning&&a.kind!=='source'){setError(warning);return;}setResults(old=>({...old,[a.id]:'adopted'}));setPreview('');if(warning)setError(warning);
 }
 function undoSourceEdit(a:TaskAdvice){
  const snap=beforeSnapshots[a.id];
  const currentTask=latest.current.tasks.find(t=>t.id===a.taskId);
  if(!snap||!currentTask)return;
  if(currentTask.description!==snap.after){
   setError('该任务正文在写回后已被二次修改，无法直接自动回滚，请打开原任务核对。');
   return;
  }
  if(!onSource(a.taskId,snap.before)){
   setError('撤销写回失败，请检查浏览器存储。');
   return;
  }
  setResults(old=>({...old,[a.id]:'undone'}));
 }
 const focusedTasks=tasks.filter(t=>request.taskIds.includes(t.id));
 const totalEvidenceCount=new Set(focusedTasks.flatMap(t=>(evidence[t.id]||[]).filter(r=>effectiveMode!=='partial'||r.source!=='飞书').map(r=>r.id))).size;
 function discuss(){
  const task=request.mode==='task'?focusedTasks[0]:undefined;
  const sources=new Map(focusedTasks.flatMap(item=>(evidence[item.id]||[]).map(source=>[source.id,source] as const)));
  onDiscuss({
   id:task?.id??'analysis-'+request.id,
   title:request.label,
   path:task?task.source+' · '+task.project:modeTitle[request.mode],
   excerpt:focusedTasks.map(item=>[
    task?'':item.title+' · '+item.source+' / '+item.project,
    '状态：'+taskStates[item.status]+' · 计划日期：'+(item.date||'未安排'),
    item.description,
   ].filter(Boolean).join('\n')).join('\n\n'),
   evidence:[...sources.values()]
    .filter(source=>phase!==3||effectiveMode!=='partial'||source.source!=='飞书')
    .map(source=>({id:source.id,title:source.title,source:source.source,excerpt:source.text})),
  });
 }
 return <aside className="tw-analysis" aria-label="任务分析" data-ready={phase===3}><header><div><small>围绕原任务分析 · Codex 受控模式</small><h2 ref={heading} tabIndex={-1}>{modeTitle[request.mode]}</h2></div><button aria-label="关闭任务分析" onClick={onClose}><X size={17}/></button></header><div ref={content} className="tw-analysis-content">
  <section className="ta-analysis-scope">
   <div className="ta-scope-header"><strong>{request.label}</strong><span className="ta-mono-badge">{request.taskIds.length} 项原任务</span></div>
   <p>本次范围固定，不静默新建或改期。列表仍可继续浏览。</p>
   <div className="ta-scope-footer">
    <details><summary>查看读取范围 ({focusedTasks.length})</summary><ul>{focusedTasks.map(t=><li key={t.id}><button onClick={()=>onTask(t.id)}>{t.title}<ArrowUpRight size={11}/></button><small>{t.source} / {t.project} · <code>{t.id}</code></small></li>)}</ul></details>
    <button className="ta-analysis-return" aria-haspopup="dialog" disabled={working||!focusedTasks.length} onClick={discuss}><MessageSquare size={13}/>在 Agents 中讨论</button>
   </div>
  </section>

  {phase===3 ? (
   <div className="ta-codex-trace">
    <button type="button" className="ta-codex-trace-bar" aria-expanded={traceOpen} onClick={()=>setTraceOpen(v=>!v)}>
     <span className="ta-trace-ok">✓</span>
     <span className="ta-trace-summary">已核对 {snapshot.length||focusedTasks.length} 项原任务与 {totalEvidenceCount} 份关联依据 · {advice.length} 条建议 · 420ms</span>
     <span className="ta-trace-toggle">{traceOpen?<ChevronDown size={13}/>:<ChevronRight size={13}/>}</span>
    </button>
    {traceOpen&&<ol className="ta-analysis-steps" aria-label="读取到采纳的过程">{steps.map((text,index)=><li key={text} className="done"><span><Check size={12}/></span><div><strong>{text}</strong><small>{index===0?`已读取同一列表的 ${snapshot.length||focusedTasks.length} 项示例记录`:index===1?(!runOptions.refresh?'已跳过，使用原缓存':runOptions.readMode==='fresh'?'示例刷新完成':runOptions.readMode==='cached'?'离线，保留旧数据':'任务刷新完成，飞书资料缺失'):index===2?`${advice.length} 条建议 · ${readAt}`:'逐条采用，说明具体影响'}</small></div></li>)}</ol>}
   </div>
  ) : (
   <ol className="ta-analysis-steps" aria-label="读取到采纳的过程">{steps.map((text,index)=><li key={text} aria-current={phase===index?'step':undefined} className={phase>index?'done':''}><span>{phase>index?<Check size={12}/>:index+1}</span><div><strong>{text}</strong><small>{index===0?(phase>0?`已读取同一列表的 ${snapshot.length||focusedTasks.length} 项示例记录`:'使用现有任务身份，不重新导入'):index===1?(phase>1?(!runOptions.refresh?'已跳过，使用原缓存':runOptions.readMode==='fresh'?'示例刷新完成':runOptions.readMode==='cached'?'离线，保留旧数据':'任务刷新完成，飞书资料缺失'):'需要时核对来源变化'):index===2?(phase>2?`${advice.length} 条建议 · ${readAt}`:'只分析所选任务与关联资料'):'逐条采用，说明具体影响'}</small></div></li>)}</ol>
  )}

  <div className="ta-analysis-options"><label><input type="checkbox" checked={refreshFirst} disabled={working} onChange={e=>setRefreshFirst(e.target.checked)}/>分析前刷新示例来源</label><details><summary>体验离线或读取失败边界</summary><label>数据情境<select aria-label="分析数据情境" value={readMode} disabled={working} onChange={e=>setReadMode(e.target.value as ReadMode)}><option value="fresh">示例刷新成功</option><option value="cached">离线，使用旧缓存</option><option value="partial">飞书关联资料读取失败</option></select></label></details><button className="ta-analysis-primary" disabled={working||!focusedTasks.length} onClick={run}><RefreshCw size={14} className={working?'spin':''}/>{working?['正在读取聚合数据…','正在刷新来源…','正在分析示例任务…'][phase]:phase===3?'重新读取并分析':'读取并分析（演示）'}</button></div>
  {error&&<p className="ta-analysis-error" role="alert">{error}</p>}
  {phase===3&&<div className="ta-analysis-results" aria-live="polite">{effectiveMode!=='fresh'&&<p className="ta-analysis-warning">{effectiveMode==='cached'?'使用旧缓存，尚未核实来源变化；可以安排 Hub 计划，修改来源前须重新刷新。':'飞书资料未取得，以下结果不代表已检查全部依据。'}</p>}{stale&&<p className="ta-analysis-warning">有原任务在分析后发生变化，请重新读取后再采用。</p>}{request.mode==='today'&&<p className="ta-analysis-muted">优先列出已到期事项，再建议少量下一步。未连接日历或核实工时，不自动改日期。</p>}
   {!advice.length&&<p className="ta-analysis-muted">这个范围没有可分析的未完成任务，可关闭后换一个项目。</p>}
   {advice.map(a=>{
    const task=tasks.find(t=>t.id===a.taskId);
    const result=results[a.id]||(memory.receipts.some(r=>r.id===a.id)?'adopted':'');
    const revHash=shortRevisionHash(a.revision);
    const currentDesc=task?.description||'';
    const addedLine=a.kind==='source'&&a.text.startsWith(currentDesc)?a.text.slice(currentDesc.length).trim():a.text;
    const canUndo=a.kind==='source'&&result==='adopted'&&beforeSnapshots[a.id]&&task?.description===beforeSnapshots[a.id].after;
    return <article key={a.id} className="ta-advice">
     <div className="ta-advice-head"><small>{a.title}</small><code className="ta-rev-tag" title="任务版本校验指纹">rev#{revHash}</code></div>
     <h3><button onClick={()=>onTask(a.taskId)}>{task?.title||'原任务已不可用'}<ArrowUpRight size={12}/></button></h3>
     <p>{a.reason}</p>
     <div className="ta-advice-text">{a.text}</div>
     <details><summary>查看依据 ({a.evidence.length})</summary><p>原任务：{task?.source} / {task?.project} · <code>{a.taskId}</code></p>{a.evidence.length?a.evidence.map(r=><div className="ta-evidence" key={r.id}><strong>{r.source} · {r.title}</strong><p>{r.text}</p></div>):<p>没有取得额外资料，本条仅依据原任务。</p>}</details>
     <p className="ta-advice-effect">{a.kind==='today'?'只加入 Hub 今日计划，不复制任务或修改原日期':a.kind==='note'?'只保留 Hub 建议笔记，不修改来源状态':'模拟修改原任务说明，先预览结构化 Diff'}</p>
     {(!result||result==='undone')&&preview!==a.id&&<div className="ta-advice-actions"><button className="ta-analysis-primary" onClick={()=>adopt(a)}>{a.kind==='today'?'加入今日计划':a.kind==='note'?'保留建议':'预览任务修改'}</button><button onClick={()=>setResults(old=>({...old,[a.id]:'dismissed'}))}>暂不采用</button>{result==='undone'&&<span className="ta-undo-status">已撤销刚才的写回，恢复原正文</span>}</div>}
     {preview===a.id&&<div className="ta-advice-preview ta-codex-diff-card">
      <div className="ta-diff-header">
       <strong>目标：{task?.source} / {task?.project}</strong>
       <span className="ta-diff-meta"><ShieldCheck size={12}/> 校验 sha:{revHash} · 仅追加说明</span>
      </div>
      <div className="ta-diff-block">
       <div className="ta-diff-line ta-diff-context"><span className="ta-diff-sign"> </span><div><small>保留原说明</small>{currentDesc||'（原说明为空）'}</div></div>
       <div className="ta-diff-line ta-diff-added"><span className="ta-diff-sign">+</span><div><small>新增下一步草稿</small>{addedLine}</div></div>
      </div>
      <div className="ta-diff-sr-inputs">
       <label>修改前<textarea aria-label="修改前任务说明" readOnly value={currentDesc}/></label>
       <label>修改后<textarea aria-label="修改后任务说明" readOnly value={a.text}/></label>
      </div>
      <p>保留同一任务 ID、清单、日期和完成状态。这里只模拟来源保存。</p>
      <label className="ta-diff-outcome-picker"><span>模拟保存回执</span><select aria-label="模拟任务保存结果" value={outcome} onChange={e=>setOutcome(e.target.value)}><option value="success">来源确认成功</option><option value="failure">保存失败，未写入</option><option value="unknown">连接中断，结果未知</option></select></label>
      <div className="ta-advice-actions"><button className="ta-analysis-primary" onClick={()=>adopt(a,true)}>确认模拟修改</button><button onClick={()=>setPreview('')}>取消修改</button></div>
     </div>}
     {result==='adopted'&&<div className="ta-advice-adopted-row"><p className="ta-advice-success"><Check size={14}/>{a.kind==='source'?'模拟任务说明已更新，仍是原任务':a.kind==='today'?'已加入今日计划，左侧原任务已标记':'已保留原任务的 Hub 建议笔记'}</p>{canUndo&&<button type="button" className="ta-undo-btn" onClick={()=>undoSourceEdit(a)} title="来源尚未发生二次修改，可安全回滚到写回前状态"><RotateCcw size={12}/>撤销写回 (Undo)</button>}</div>}
     {result==='dismissed'&&<p className="ta-analysis-muted">未采用，原任务保持原样。</p>}
     {result==='failed'&&<div className="ta-advice-actions"><p role="status" className="ta-status-danger">模拟保存失败，原任务未改。</p><button onClick={()=>{setResults(old=>({...old,[a.id]:''}));setPreview(a.id);setOutcome('success');}}>重新预览同一操作</button><button onClick={()=>setResults(old=>({...old,[a.id]:'dismissed'}))}>取消本次操作</button></div>}
     {result==='unknown'&&<div className="ta-advice-actions"><p role="status" className="ta-status-warn">结果未知，先核对，不能盲目重试。</p><button onClick={()=>{setResults(old=>({...old,[a.id]:'dismissed'}));setError('演示核对：原任务尚未写入，旧操作已结束，可以重新读取并分析。');}}>核对模拟来源结果</button></div>}
    </article>;})}</div>}
  {memory.receipts.some(r=>request.taskIds.includes(r.taskId))&&<details className="ta-analysis-receipts"><summary>本范围的采纳记录 ({memory.receipts.filter(r=>request.taskIds.includes(r.taskId)).length})</summary>{memory.receipts.filter(r=>request.taskIds.includes(r.taskId)).slice(0,8).map(r=><p key={r.id}><strong>{tasks.find(t=>t.id===r.taskId)?.title}</strong><br/>{r.message}</p>)}</details>}
  <p className="ta-analysis-boundary"><Sparkles size={13}/>同一个任务面板 · 数据、刷新、AI 与来源保存均为浏览器示例；不访问正式 Hub 数据库。</p><button className="ta-analysis-return" onClick={onClose}><ArrowLeft size={13}/>返回任务列表</button>
 </div></aside>;
}
