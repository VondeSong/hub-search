import { publicWebHref } from "./AgentWebSources";
import { memo, useEffect, useId, useState } from "react";
import { BookOpen, ChevronDown, Circle, FileText, Search, TriangleAlert, Wrench, Terminal, Pencil } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentToolResult, type ToolResultRef, type ToolResultScope } from "./AgentToolResult";

export type ActivityEvent = { id: string; origin?:string; kind: "answer" | "context" | "message" | "reasoning" | "plan" | "unpublishedAnswer" | "webSearch" | "skill" | "tool" | "status"; state: string; label: string; detail?: string | null; url?:string|null; actionId?: string; resultRef?: ToolResultRef; createdAt: number; finishedAt?: number; action?:string|null; queries?:string[]|null; pattern?:string|null; sourceRefs?:{url:string;title?:string|null}[]|null; resultCount?:number|null; errorCount?:number|null; errors?:{refId:string;url?:string|null;reason?:string|null}[]|null; omittedSourceCount?:number|null };
export type ActivityRun = { workId?:string;currentWorkRevision?:number;authorizationVersion?:number;runId: string; revision: number; state: string; running: boolean; native?:boolean; measurement?:{turnTokens?:{inputTokens?:number|null;cachedInputTokens?:number|null;uncachedInputTokens?:number|null;outputTokens?:number|null}}; canSteer?:boolean; startedAt: number; finishedAt?: number | null; steps: number; events: ActivityEvent[]; validity?: string };

const PublicText = memo(function PublicText({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({children})=><span>{children}</span>,table:({children})=><div className="agent-table-scroll"><table>{children}</table></div>}}>{text}</ReactMarkdown>;
});

function UnpublishedAnswer({text}:{text:string}) {
  const [open,setOpen]=useState(false);
  return <details className="agent-reasoning agent-tool-result" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>查看未发布的模型答复<ChevronDown size={13} aria-hidden="true"/></summary>
    {open && <div><p className="agent-note">原始答复已保留，但尚未通过交付核验；其中的表述不代表操作已执行或目标已完成。</p><pre>{text}</pre></div>}
  </details>;
}
function webLabel(event:ActivityEvent) {
  const original=event.label.replace(/^Codex\s*/,"").replace(/[：:]\s*$/,"").trim();
  const legacy=!event.action || /^Codex\s/.test(event.label);
  const generic=event.action==="other" || !original || (legacy && original==="搜索网页");
  return generic ? "查阅网页资料" : legacy ? original.split(/[：:]/,1)[0] : original;
}
function webSummary(event:ActivityEvent) {
  const state=event.state==="running"?" · 进行中":event.state==="interrupted"?" · 已中断":event.state==="failed"?" · 未完成":"";
  return `${webLabel(event)}${state}${event.errorCount ? ` · ${event.errorCount} 项未获取` : ""}`;
}
function WebActivity({event}:{event:ActivityEvent}) {
  const href=publicWebHref(event.url);
  const original=event.label.replace(/^Codex\s*/,"").replace(/[：:]\s*$/,"").trim();
  const legacy=!event.action || /^Codex\s/.test(event.label);
  const sources=(event.sourceRefs??[]).flatMap(source=>{const url=publicWebHref(source.url);return url?[{...source,url}]:[];});
  return <div className="agent-activity-step">
    <details className="agent-reasoning agent-web-activity">
      <summary title={webSummary(event)}>{event.errorCount || event.state==="failed"?<TriangleAlert size={14} aria-hidden="true"/>:<Search size={14} aria-hidden="true"/>}<span>{webSummary(event)}</span><ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
      <div className="agent-web-details">
      <p className="agent-note">{event.resultCount!=null ? `本批返回 ${event.resultCount} 项结果` : "这条记录未提供逐项返回结果"} · {event.state==="completed"?"已结束":event.state==="running"?"进行中":event.state==="interrupted"?"已中断":"未完成"}</p>
      {legacy && original!==webLabel(event) && original!=="搜索网页" && <p>{original}</p>}
      {href && <p><a href={href} target="_blank" rel="noreferrer">打开网页</a></p>}
      {!!event.errorCount && <div className="agent-process-failure"><div><p>本批 {event.errorCount} 项未能获取。</p>{!!event.errors?.length && <ul aria-label="网页访问失败详情">{event.errors.map((error,index)=>{const link=publicWebHref(error.url);return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{new URL(link).hostname}</a> : "网页访问"} · {error.reason || "当前展示记录未包含具体原因"}</li>;})}</ul>}{(!event.errors?.length || event.errors.length<event.errorCount!) && <p>当前展示记录未包含{event.errors?.length ? "其余错误的" : ""}具体原因。</p>}</div></div>}
      {!!event.queries?.length && <details><summary>搜索词 · {event.queries.length}</summary><ul aria-label="本批搜索词">{event.queries.map((query,index)=><li key={index}>{query}</li>)}</ul></details>}
      {event.pattern && <details><summary>查找内容</summary><p>{event.pattern}</p></details>}
      {!!sources.length && <details><summary>返回来源 · {sources.length}</summary><ul aria-label="本批返回的来源">{sources.map((source,index)=><li key={index}><a href={source.url} target="_blank" rel="noreferrer">{source.title || source.url}</a></li>)}</ul></details>}
      {!!event.omittedSourceCount && <p className="agent-note">另有 {event.omittedSourceCount} 项来源未在此展开。</p>}
      </div>
    </details>
  </div>;
}
function isThinkingPlaceholder(event:ActivityEvent) {
  return ["status","tool","reasoning"].includes(event.kind) && !["failed","interrupted"].includes(event.state)
    && !event.detail && !event.resultRef && /^(正在思考|思考中|正在处理这次要求)[.。…\s]*$/.test(event.label.trim());
}
function ActivityEventView({ event, scope }: { event: ActivityEvent; scope: ToolResultScope | null }) {
  if (event.label === "核对任务状态（内部）" && event.state === "completed") return <details className="agent-reasoning"><summary>已核对任务状态</summary><div>{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</div></details>;
  if (event.kind === "unpublishedAnswer") return <UnpublishedAnswer text={event.label}/>;
  if (event.kind === "webSearch") return <WebActivity event={event}/>;
  if (event.kind === "plan") return <details className="agent-reasoning"><summary>工作计划<ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  if (event.kind === "context") return <div className="agent-activity-step agent-context-event">{event.state === "failed" ? <TriangleAlert size={14} aria-hidden="true"/> : <FileText size={14} aria-hidden="true"/>}{event.detail ? <details><summary>{event.label}</summary><p>{event.detail}</p></details> : <span>{event.label}</span>}</div>;
  if (event.kind === "message") return <div className="agent-commentary"><PublicText text={event.label}/></div>;
  if(event.kind==="status") {
    const label=(event.state==="failed"?"未完成：":event.state==="interrupted"?"已中断：":"")+event.label;
    return event.detail || (event.resultRef&&scope) ? <details className="agent-reasoning"><summary><span>{label}</span><ChevronDown size={12} aria-hidden="true"/></summary><div>{event.detail&&<p>{event.detail}</p>}{event.resultRef&&scope&&<AgentToolResult value={event.resultRef} scope={scope}/>}</div></details> : <p className="agent-reasoning">{label}</p>;
  }
  if (event.kind === "reasoning") {
    const text=event.label.replace(/[#*\n]/g," ").trim();
    const icon=null;
    const prefix=event.state==="interrupted"?"已中断：":event.state==="failed"?"未完成：":"";
    if(text.length<=72) return <div className="agent-activity-step agent-reasoning" aria-label="思考摘要">{icon}<span>{prefix}{text || "正在思考"}</span></div>;
    return <details className="agent-reasoning"><summary>{icon}<span>{prefix}{text.slice(0,72)}…</span><ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  }
  return <div className={"agent-activity-step agent-step-" + event.state}>
    {event.state === "failed" ? <TriangleAlert size={14} aria-hidden="true" /> : event.state === "interrupted" ? <Circle size={14} aria-hidden="true" /> : event.kind === "skill" ? <BookOpen size={14} aria-hidden="true" /> : event.label.includes("搜索") ? <Search size={14} aria-hidden="true" /> : /命令|运行|执行/.test(event.label) ? <Terminal size={14} aria-hidden="true"/> : /编辑|修改|创建文件/.test(event.label) ? <Pencil size={14} aria-hidden="true"/> : /读取|原文|材料/.test(event.label) ? <FileText size={14} aria-hidden="true"/> : <Wrench size={14} aria-hidden="true"/>}
    <div>{event.detail || (event.resultRef && scope) || event.label.length>72 ? <details className="agent-tool-activity"><summary title={event.label}><span>{event.label}</span>{eventDuration(event)&&<small className="agent-operation-duration">{eventDuration(event)}</small>}<span className="agent-step-state">{event.state === "failed" ? "未完成" : event.state === "running" ? "进行中" : event.state === "interrupted" ? "已中断" : ""}</span><ChevronDown size={12} className="agent-reasoning-chevron" aria-hidden="true"/></summary>{event.label.length>72 && <p>{event.label}</p>}{event.detail && <p>{event.detail}</p>}{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</details> : <span>{event.label}{event.state === "interrupted" ? " · 已中断" : ""}{eventDuration(event)&&<small className="agent-operation-duration">{eventDuration(event)}</small>}</span>}</div>
  </div>;
}

function EventIcon({event}:{event:ActivityEvent}) {
  if(event.kind==="reasoning"||event.kind==="status")return null;
  const Icon=event.state==="failed"||event.errorCount?TriangleAlert:event.kind==="webSearch"?Search:event.kind==="skill"?BookOpen:event.kind==="context"||/读取|原文|材料/.test(event.label)?FileText:/命令|运行|执行/.test(event.label)?Terminal:/编辑|修改|创建文件/.test(event.label)?Pencil:Wrench;
  return <Icon size={14} aria-hidden="true"/>;
}
function eventDuration(event:ActivityEvent) {
  return event.finishedAt!=null&&event.finishedAt>=event.createdAt ? elapsed(event.finishedAt-event.createdAt) : null;
}
function elapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + seconds % 60 + " 秒";
}

const isOperation=(event:ActivityEvent)=>["context","tool","skill","webSearch"].includes(event.kind);
function OperationPhase({events,scope,running}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean}) {
  const [open,setOpen]=useState(false);
  const operations=events.filter(isOperation);
  if(!operations.length)return <>{events.map(event=><ActivityEventView key={event.id} event={event} scope={scope}/>)}</>;
  const active=running?[...events].reverse().find(event=>event.state==="running"):undefined;
  const failed=operations.some(event=>event.state==="failed"||event.state==="interrupted"||event.errorCount);
  const labels=[...new Set(operations.map(event=>
    event.kind==="webSearch"?"查阅网页":event.kind==="context"?"读取资料":event.kind==="skill"?"使用技能":
    /命令|运行|执行/.test(event.label)?"运行命令":/编辑|修改|创建文件/.test(event.label)?"编辑文件":
    /读取|原文|材料/.test(event.label)?"读取资料":"调用工具"))];
  const pending=running?operations.find(event=>event.state==="queued"):undefined;
  const current=active??pending;
  const overview=(operations.every(event=>event.state==="completed"&&!event.errorCount)?"已":"")+labels.join("、");
  const currentLabel=current && (/^(读取|搜索|访问|运行|执行|检查|核对|验证|编辑|加载|查找|整理|分析|生成|保存|创建)/.test(current.label)?"正在"+current.label:current.label);
  const summary=current ? pending&&!active?"等待："+current.label:currentLabel! : running?"正在思考":overview;
  return <details className={`agent-operation-group${running?" agent-operation-active":""}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary title={summary}>{current?<EventIcon event={current}/>:!running&&<EventIcon event={{...operations[0],state:"completed",errorCount:0}}/>}<span className={running?"agent-current-action":undefined}>{summary}</span>{failed&&!open&&<small className="agent-phase-warning">部分未完成</small>}<ChevronDown size={12} aria-hidden="true"/></summary>
    <div>{events.map(event=><ActivityEventView key={event.id} event={event} scope={scope}/>)}</div>
  </details>;
}
function ActivityTimeline({events,scope,running}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean}) {
  const groups:ActivityEvent[][]=[];
  const boundary=(event:ActivityEvent)=>["message","reasoning","status","plan","unpublishedAnswer"].includes(event.kind);
  for(const event of events){
    const previous=groups[groups.length-1];
    if(!boundary(event)&&previous&&!boundary(previous[0]))previous.push(event);
    else groups.push([event]);
  }
  return <>{groups.map(group=>boundary(group[0]) ? <ActivityEventView key={group[0].id} event={group[0]} scope={scope}/> : <OperationPhase key={group[0].id} events={group} scope={scope} running={running && group===groups[groups.length-1]}/>)}</>;
}

export function AgentActivity({ value }: { value: ActivityRun }) {
  const [expanded, setExpanded] = useState(value.running);
  const detailsId = useId();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { setExpanded(value.running); }, [value.runId]);
  useEffect(() => {
    if (!value.running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [value.runId, value.running]);
  const scope:ToolResultScope|null=value.workId && value.currentWorkRevision!==undefined && value.authorizationVersion!==undefined ? {workId:value.workId,currentWorkRevision:value.currentWorkRevision,authorizationVersion:value.authorizationVersion}:null;
  const newest = [...value.events].reverse();
  const answer = newest.find(event=>event.kind==="answer" && event.label.trim());
  const unpublished = newest.find(event=>event.kind==="unpublishedAnswer");
  const answerStartedAt=value.events.find(event=>event.kind==="answer"&&event.label.trim())?.createdAt;
  const duration=elapsed((value.finishedAt ?? answerStartedAt ?? now)-value.startedAt);
  const timeLabel=value.running&&!answer?"已处理":"用时";
  const processEvents=value.events.filter(event=>event.kind!=="answer"&&!isThinkingPlaceholder(event)).sort((a,b)=>a.createdAt-b.createdAt);
  const hasActiveStep=processEvents.some(event=>["tool","skill","webSearch","reasoning","status"].includes(event.kind)&&event.state==="running");
  const stopped = !value.running && ["failed","interrupted","needsDecision"].includes(value.state);
  const failure = stopped && newest.find(event=>event.state==="failed" || event.state==="interrupted");
  const hasProcess = !!value.validity || processEvents.length>0;
  const phaseShowsStatus=processEvents.length>0&&isOperation(processEvents[processEvents.length-1]);
  return <section className="agent-activity" aria-label="本轮工作过程">
    {hasProcess ? <button type="button" className="agent-activity-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={()=>setExpanded(current=>!current)}>
      <span>{timeLabel} {duration}</span><ChevronDown className={expanded ? "" : "agent-collapsed"} size={12} aria-hidden="true"/>
    </button> : (!value.running || answer) && <p className="agent-elapsed">用时 {duration}</p>}
    {expanded && (hasProcess || (value.running && !answer)) && <div id={detailsId} className="agent-activity-events" aria-label="完整工作过程">
      {value.validity && <p className="agent-note">{value.validity}</p>}
      <ActivityTimeline running={value.running && !answer} events={processEvents} scope={value.validity ? null : scope}/>
      {value.running && !answer && !hasActiveStep && !phaseShowsStatus && <p className="agent-live-status" role="status">正在思考</p>}
    </div>}
    {!expanded && failure && <p className="agent-process-failure" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{failure.label} · {failure.state==="failed" ? "未完成" : "已中断"}{failure.detail ? `：${failure.detail}` : ""}</span></p>}
    {!expanded && unpublished && <ActivityEventView event={unpublished} scope={null}/>}
    {value.running && answer && <div className="agent-report agent-answer agent-native-answer" aria-label="正在生成回答" aria-busy="true">{answer.origin==="deepseek"&&<p className="agent-note">回答预览 · 完整接收并核验后交付</p>}<PublicText text={answer.label}/></div>}
  </section>;
}
