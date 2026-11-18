import { publicWebHref } from "./AgentWebSources";
import { createContext, memo, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, TriangleAlert } from "lucide-react";
import { ActivityIcon, ActivityIdentity, activityLabel, activityOperation, operationLabels } from "./AgentActivityIdentity";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentToolResult, type ToolResultRef, type ToolResultScope } from "./AgentToolResult";

export type ActivityEvent = { id: string; sequence?:number; updatedAt?:number; operation?:string|null; serviceId?:string|null; serviceTitle?:string|null; toolName?:string|null; agentIds?:string[]|null; agentStates?:Record<string,{status:string}>|null; origin?:string; truncated?:boolean; kind: "answer" | "context" | "message" | "reasoning" | "plan" | "unpublishedAnswer" | "webSearch" | "skill" | "tool" | "status"; state: string; label: string; detail?: string | null; url?:string|null; actionId?: string; resultRef?: ToolResultRef; createdAt: number; finishedAt?: number; action?:string|null; queries?:string[]|null; pattern?:string|null; sourceRefs?:{url:string;title?:string|null}[]|null; resultCount?:number|null; errorCount?:number|null; errors?:{refId:string;url?:string|null;reason?:string|null}[]|null; omittedSourceCount?:number|null };
export type ActivityRun = { workId?:string;currentWorkRevision?:number;authorizationVersion?:number;runId: string; revision: number; state: string; running: boolean; native?:boolean; capabilities?:{externalTools?:{server:string;tools:string[];writeRepository?:string|null}[];webSearch?:string;nativeCapabilities?:{workspace:boolean;multiAgent:boolean}}|null; measurement?:{turnTokens?:{inputTokens?:number|null;cachedInputTokens?:number|null;uncachedInputTokens?:number|null;outputTokens?:number|null}}; canSteer?:boolean; startedAt: number; finishedAt?: number | null; steps: number; events: ActivityEvent[]; validity?: string };

const DisclosureContext=createContext<Map<string,boolean>|null>(null);
// Cache disclosure choices only while this chat rechecks source access.
export function ActivityDisclosureProvider({children}:{children:ReactNode}) {
  const choices=useRef(new Map<string,boolean>());
  return <DisclosureContext.Provider value={choices.current}>{children}</DisclosureContext.Provider>;
}
function useActivityDisclosure(key:string,initial:boolean):[boolean,(value:boolean)=>void] {
  const choices=useContext(DisclosureContext);
  const [open,setOpen]=useState(()=>choices?.get(key)??initial);
  useEffect(()=>{setOpen(choices?.get(key)??initial);},[key,choices]);
  return [open,value=>{
    if(choices){choices.delete(key);choices.set(key,value);if(choices.size>256)choices.delete(choices.keys().next().value!);}
    setOpen(value);
  }];
}

const PublicText = memo(function PublicText({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({children})=><span>{children}</span>,table:({children})=><div className="agent-table-scroll"><table>{children}</table></div>}}>{text}</ReactMarkdown>;
});

function UnpublishedAnswer({text,truncated}:{text:string;truncated?:boolean}) {
  const [open,setOpen]=useState(false);
  return <details className="agent-reasoning agent-tool-result" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>查看未发布的模型答复<ChevronDown size={13} aria-hidden="true"/></summary>
    {open && <div><p className="agent-note">{truncated?"仅保留了部分回答预览，尚未通过交付核验；其中的表述不代表操作已执行或目标已完成。":"原始答复已保留，但尚未通过交付核验；其中的表述不代表操作已执行或目标已完成。"}</p><pre>{text}</pre></div>}
  </details>;
}
function webLabel(event:ActivityEvent) {
  const operation = activityOperation(event);
  const legacyLabel = !event.action && event.label.trim();
  const label = operation === "webUnknown" ? (legacyLabel && legacyLabel !== "查阅网页资料" ? legacyLabel : "网页操作") : operationLabels[operation];
  return operation === "webSearch" && event.queries?.length ? `${label} · ${event.queries.length} 条查询` : label;
}
function webSummary(event:ActivityEvent) {
  const state=event.state==="running"?" · 进行中":event.state==="interrupted"?" · 已中断":event.state==="failed"?" · 未完成":"";
  return `${webLabel(event)}${state}${event.errorCount ? ` · ${event.errorCount} 项未获取` : ""}`;
}
function webFailureSummary(events:ActivityEvent[]) {
  const issues=events.filter(event=>event.kind==="webSearch" && (event.state==="failed" || event.state==="interrupted" || (event.errorCount ?? 0)>0));
  // Results from separate batches may refer to the same page; do not sum them
  // into a claimed number of unique failed pages.
  return issues.length===1 ? webSummary(issues[0]) : issues.length>1 ? `${issues.length} 批网页操作存在未完成项` : null;
}
// Older native progress records carry this suffix without a truncated flag.
const progressClippingNotice="（过程消息超过显示上限，后续内容未展示。）";
function WebActivity({event,workId}:{event:ActivityEvent;workId?:string}) {
  const href=publicWebHref(event.url);
  const original=event.label.replace(/^Codex\s*/,"").replace(/[：:]\s*$/,"").trim();
  const legacy=!event.action || /^Codex\s/.test(event.label);
  const sources=(event.sourceRefs??[]).flatMap(source=>{const url=publicWebHref(source.url);return url?[{...source,url}]:[];});
  return <div className="agent-activity-step">
    <details className="agent-reasoning agent-web-activity">
      <summary title={webSummary(event)}><ActivityIcon event={event}/><ActivityIdentity events={[event]} workId={workId}/><span>{webSummary(event)}</span><ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
      <div className="agent-web-details">
      <p className="agent-note">{event.resultCount != null
        ? `本批返回 ${event.resultCount} 项${activityOperation(event) === "webSearch" ? "搜索结果" : "结果"}`
        : "这条记录未提供逐项返回结果"}</p>
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
function eventStateLabel(event:ActivityEvent) {
  return ({failed:"未完成",running:"进行中",interrupted:"已中断",queued:"等待执行"} as Record<string,string>)[event.state] ?? "";
}
function ActivityEventView({ event, scope }: { event: ActivityEvent; scope: ToolResultScope | null }) {
  event={...event,label:activityLabel(event)};
  if (event.label === "核对任务状态（内部）" && event.state === "completed") return <details className="agent-reasoning"><summary>已核对任务状态</summary><div>{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</div></details>;
  if (event.kind === "unpublishedAnswer") return <UnpublishedAnswer text={event.label} truncated={event.truncated}/>;
  if (event.kind === "webSearch") return <WebActivity event={event} workId={scope?.workId}/>;
  if (event.kind === "plan") return <details className="agent-reasoning"><summary>工作计划<ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  if (event.kind === "context") return <div className="agent-activity-step agent-context-event"><ActivityIcon event={event}/>{event.detail ? <details><summary>{event.label}</summary><p>{event.detail}</p></details> : <span>{event.label}</span>}</div>;
  if (event.kind === "message") return <div className="agent-commentary"><PublicText text={event.label}/></div>;
  if(event.kind==="status") {
    const label=(event.state==="failed"?"未完成：":event.state==="interrupted"?"已中断：":"")+event.label;
    return event.detail || (event.resultRef&&scope) ? <details className="agent-reasoning"><summary><span>{label}</span><ChevronDown size={12} aria-hidden="true"/></summary><div>{event.detail&&<p>{event.detail}</p>}{event.resultRef&&scope&&<AgentToolResult value={event.resultRef} scope={scope}/>}</div></details> : <p className="agent-reasoning">{label}</p>;
  }
  if (event.kind === "reasoning") {
    const text=event.label.replace(/[#*\n]/g," ").trim();
    const characters=Array.from(text);
    const icon=null;
    const prefix=event.state==="interrupted"?"已中断：":event.state==="failed"?"未完成：":"";
    if(characters.length<=72) return <div className="agent-activity-step agent-reasoning" aria-label="思考摘要">{icon}<span>{prefix}{text || "正在思考"}</span></div>;
    return <details className="agent-reasoning"><summary>{icon}<span>{prefix}{characters.slice(0,72).join("")}…</span><ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  }
  return <div className={"agent-activity-step agent-step-" + event.state}>
    <ActivityIcon event={event}/><ActivityIdentity events={[event]} workId={scope?.workId}/>
    <div>{event.detail || event.agentIds?.length || (event.resultRef && scope) || event.label.length>72 ? <details className="agent-tool-activity"><summary title={event.label}><span>{event.label}</span>{eventDuration(event)&&<small className="agent-operation-duration">{eventDuration(event)}</small>}<span className="agent-step-state">{eventStateLabel(event)}</span><ChevronDown size={12} className="agent-reasoning-chevron" aria-hidden="true"/></summary>{event.label.length>72 && <p>{event.label}</p>}{event.detail && <p>{event.detail}</p>}{!!event.agentIds?.length&&<ul aria-label="子代理状态">{event.agentIds.map(id=><li key={id}>{id.slice(-6)} · {({running:"进行中",completed:"已结束",failed:"未完成",errored:"未完成",interrupted:"已中断",pendingInit:"正在启动",shutdown:"已关闭"} as Record<string,string>)[event.agentStates?.[id]?.status??""]||"状态待核验"}</li>)}</ul>}{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</details> : <span>{event.label}{eventStateLabel(event)&&<span className="agent-step-state"> · {eventStateLabel(event)}</span>}{eventDuration(event)&&<small className="agent-operation-duration">{eventDuration(event)}</small>}</span>}</div>
  </div>;
}

function eventDuration(event:ActivityEvent) {
  return event.finishedAt!=null&&event.finishedAt>=event.createdAt ? elapsed(event.finishedAt-event.createdAt) : null;
}
function elapsed(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + seconds % 60 + " 秒";
}

const isOperation=(event:ActivityEvent)=>["context","tool","skill","webSearch"].includes(event.kind);
function OperationPhase({events,scope,running,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean;runId:string}) {
  const [open,setOpen]=useActivityDisclosure(`group:${runId}:${events[0].id}`,false);
  const operations=events.filter(isOperation);
  if(!operations.length)return <>{events.map(event=><ActivityEventView key={event.id} event={event} scope={scope}/>)}</>;
  const active=running?[...events].reverse().find(event=>event.state==="running"):undefined;
  const failed=operations.some(event=>event.state==="failed"||event.state==="interrupted"||event.errorCount);
  const webFailure=webFailureSummary(operations);
  const otherFailure=operations.some(event=>event.kind!=="webSearch" && (event.state==="failed" || event.state==="interrupted"));
  const webOnly = operations.every(event => event.kind === "webSearch");
  const labels = [...new Set(operations.map(event => operationLabels[activityOperation(event)]))];
  const summaryIcon=operations.every(event=>activityOperation(event)===activityOperation(operations[0]))?operations[0]:{...operations[0],kind:"tool" as const,operation:"mixed"};
  const pending=running?operations.find(event=>event.state==="queued"):undefined;
  const current=active??pending;
  const overview=(operations.every(event=>event.state==="completed"&&!event.errorCount)?"已":"")+labels.join("、");
  const currentTitle=current && (current.kind === "webSearch" ? webLabel(current) : activityLabel(current));
  const currentLabel=currentTitle && (/^(读取|搜索|访问|运行|执行|检查|核对|验证|编辑|加载|查找|整理|分析|生成|保存|创建)/.test(currentTitle)?"正在"+currentTitle:currentTitle);
  const summary=current ? pending&&!active?"等待："+currentTitle:currentLabel! : running && !webOnly ? "正在思考" : overview;
  return <details className={`agent-operation-group${running?" agent-operation-active":""}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary title={summary}>{current ? <ActivityIcon event={current}/> : (!running || webOnly) && <ActivityIcon event={{...summaryIcon,state:"completed",errorCount:0}}/>}<span className="agent-phase-label">{summary}</span><ActivityIdentity events={operations} workId={scope?.workId}/>{failed&&!open&&<small className="agent-phase-warning" role="status"><TriangleAlert size={12} aria-hidden="true"/>{webFailure ? `${otherFailure?"部分未完成 · ":""}${webFailure}` : "部分未完成"}</small>}<ChevronDown size={12} aria-hidden="true"/></summary>
    <div>{events.map(event=><ActivityEventView key={event.id} event={event} scope={scope}/>)}</div>
  </details>;
}
function ActivityTimeline({events,scope,running,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean;runId:string}) {
  const groups:ActivityEvent[][]=[];
  const boundary=(event:ActivityEvent)=>["message","reasoning","status","plan","unpublishedAnswer"].includes(event.kind);
  for(const event of events){
    const previous=groups[groups.length-1];
    if(!boundary(event)&&previous&&!boundary(previous[0]))previous.push(event);
    else groups.push([event]);
  }
  return <>{groups.map(group=>boundary(group[0]) ? <ActivityEventView key={group[0].id} event={group[0]} scope={scope}/> : <OperationPhase key={group[0].id} events={group} scope={scope} runId={runId} running={running && group===groups[groups.length-1]}/>)}</>;
}

export function AgentActivity({ value }: { value: ActivityRun }) {
  const [expanded, setExpanded] = useActivityDisclosure(`run:${value.runId}`,value.running);
  const detailsId = useId();
  const [now, setNow] = useState(Date.now());
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
  const publicSummaries=value.events.filter(event=>event.kind==="reasoning"&&event.origin==="deepseek");
  const processEvents=value.events.filter(event=>event.kind!=="answer"&&!isThinkingPlaceholder(event)&&!(event.kind==="message"&&publicSummaries.some(summary=>summary.label.trim()===event.label.trim()&&summary.createdAt<=event.createdAt))).sort((a,b)=>a.sequence!=null&&b.sequence!=null?a.sequence-b.sequence:a.createdAt-b.createdAt);
  const hasActiveStep=processEvents.some(event=>["tool","skill","webSearch","reasoning","status"].includes(event.kind)&&event.state==="running");
  const stopped = !value.running && ["failed","interrupted","needsDecision"].includes(value.state);
  const failure = stopped && newest.find(event=>event.state==="failed" || event.state==="interrupted");
  const toolIssues=processEvents.filter(event=>isOperation(event)&&event.kind!=="webSearch"&&(event.state==="failed"||event.state==="interrupted"));
  const lastToolIssue=toolIssues[toolIssues.length-1];
  const hasProcess = !!value.validity || processEvents.length>0;
  const phaseShowsStatus=processEvents.length>0&&isOperation(processEvents[processEvents.length-1]);
  const webFailure=webFailureSummary(processEvents);
  const clippedProgress=processEvents.filter(event=>["message","reasoning","plan"].includes(event.kind));
  const clippingInText=clippedProgress.some(event=>event.label.trimEnd().endsWith(progressClippingNotice));
  const clipped=clippingInText || clippedProgress.some(event=>event.truncated);
  return <section className="agent-activity" aria-label="本轮工作过程">
    {hasProcess ? <button type="button" className="agent-activity-toggle" aria-expanded={expanded} aria-controls={detailsId} onClick={()=>setExpanded(!expanded)}>
      <span>{timeLabel} {duration}</span><ChevronDown className={expanded ? "" : "agent-collapsed"} size={12} aria-hidden="true"/>
    </button> : (!value.running || answer) && <p className="agent-elapsed">用时 {duration}</p>}
    {expanded && (hasProcess || (value.running && !answer)) && <div id={detailsId} className="agent-activity-events" aria-label="完整工作过程">
      {value.validity && <p className="agent-note">{value.validity}</p>}
      <ActivityTimeline running={value.running && !answer} events={processEvents} scope={value.validity ? null : scope} runId={value.runId}/>
      {value.running && !answer && !hasActiveStep && !phaseShowsStatus && <p className="agent-live-status" role="status">正在思考</p>}
      {value.capabilities && <details className="agent-reasoning agent-runtime-details">
        <summary>运行详情<ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
        <p>本轮可用 Hub 工具{value.capabilities.nativeCapabilities?.workspace ? "、独立工作区（无网络）" : ""}{value.capabilities.nativeCapabilities?.multiAgent ? "、子任务委派" : ""}。</p>
        {value.capabilities.webSearch && <p>网页搜索 · {value.capabilities.webSearch === "live" ? "实时搜索" : value.capabilities.webSearch === "cached" ? "缓存搜索" : "关闭"}</p>}
        {!!value.capabilities.externalTools?.length && <ul>{value.capabilities.externalTools.map(service => <li key={service.server}>
          {service.server.startsWith("browser:") ? "独立浏览器 · " + service.server.slice(8).split("|").join("、") : service.server.startsWith("app:") ? "已连接应用" : service.server}
          {" · "}{service.tools.length} 个已选工具{service.writeRepository && ` · 评论目标 ${service.writeRepository}`}
        </li>)}</ul>}
        {value.capabilities.nativeCapabilities?.multiAgent && <p>主线程与子代理用量分别记录。缺失用量显示为未知。</p>}
      </details>}
    </div>}
    {!expanded && lastToolIssue && <p className="agent-process-failure" role="status" aria-label="工具操作未完成"><TriangleAlert size={14} aria-hidden="true"/><span>{toolIssues.length>1&&`${toolIssues.length} 项工具操作未完成 · `}{lastToolIssue.label} · {eventStateLabel(lastToolIssue)}{lastToolIssue.detail ? `：${lastToolIssue.detail}` : ""}</span></p>}
    {!expanded && failure && failure.kind!=="webSearch" && !isOperation(failure) && <p className="agent-process-failure" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{failure.label} · {failure.state==="failed" ? "未完成" : "已中断"}{failure.detail ? `：${failure.detail}` : ""}</span></p>}
    {!expanded && webFailure && <p className="agent-process-failure agent-web-warning" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{webFailure}{failure && failure.kind==="webSearch" && failure.detail ? `：${failure.detail}` : ""}</span></p>}
    {clipped && (!expanded || !clippingInText) && <p className="agent-note" role="status" aria-label="过程显示限制">过程消息超过显示上限，后续内容未展示。</p>}
    {!expanded && unpublished && <ActivityEventView event={unpublished} scope={null}/>}
    {value.running && answer && <div className="agent-report agent-answer agent-native-answer" aria-label="正在生成回答" aria-busy="true">{answer.origin==="deepseek"&&<p className="agent-note">{answer.truncated?"回答预览已达显示上限，仍在接收；完整回答核验后交付":"回答预览 · 完整接收并核验后交付"}</p>}<PublicText text={answer.label}/></div>}
  </section>;
}
