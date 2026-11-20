import { publicWebHref } from "./AgentWebSources";
import { createContext, memo, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis, TriangleAlert } from "lucide-react";
import { ActivityIcon, ActivityIdentity, WebsiteIcon, activityLabel, activityOperation, activityServiceTitle, operationLabels, type ActivityOperation } from "./AgentActivityIdentity";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentToolResult, type ToolResultRef, type ToolResultScope } from "./AgentToolResult";

export type ActivityEvent = { id: string; sequence?:number; updatedAt?:number; operation?:string|null; serviceId?:string|null; serviceTitle?:string|null; toolName?:string|null; agentIds?:string[]|null; agentStates?:Record<string,{status:string}>|null; origin?:string; truncated?:boolean; kind: "answer" | "context" | "message" | "reasoning" | "plan" | "unpublishedAnswer" | "webSearch" | "skill" | "tool" | "status"; state: string; label: string; detail?: string | null; url?:string|null; actionId?: string; resultRef?: ToolResultRef; readSpan?: {title:string;start:number;end:number;total:number}; createdAt: number; finishedAt?: number; action?:string|null; queries?:string[]|null; pattern?:string|null; sourceRefs?:{url:string;title?:string|null}[]|null; resultCount?:number|null; errorCount?:number|null; errors?:{refId:string;url?:string|null;reason?:string|null}[]|null; omittedSourceCount?:number|null };
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
  return webLabel(event)+state;
}

function pageHref(value?:string|null) {
  return publicWebHref(value)?.split("#")[0];
}
function specifiedPageIssue(events:ActivityEvent[], requestText?:string) {
  const requested=new Set((requestText?.match(/https:\/\/[^\s<>"'）】。，、)]+/g)??[])
    .map(url=>pageHref(url.replace(/[.,;!?]+$/,""))).filter(Boolean));
  if(requested.size!==1)return;
  const [target]=requested;
  const opened=events.some(event=>event.kind==="webSearch" && activityOperation(event)==="webOpen" && event.state==="completed"
    && event.sourceRefs?.some(source=>pageHref(source.url)===target) && !event.errors?.some(error=>pageHref(error.url)===target));
  if(opened)return;
  for(const event of events) {
    if(event.kind!=="webSearch" || activityOperation(event)!=="webOpen")continue;
    const error=event.errors?.find(item=>pageHref(item.url)===target);
    if(error || event.state==="failed" && pageHref(event.url)===target) {
      return {label:"指定网页无法访问，暂未核对原文",detail:error?.reason || event.detail};
    }
  }
}
// Older native progress records carry this suffix without a truncated flag.
const progressClippingNotice="（过程消息超过显示上限，后续内容未展示。）";
function WebActivity({event,runId,workId}:{event:ActivityEvent;runId:string;workId?:string}) {
  const [open,setOpen]=useActivityDisclosure(`web:${runId}:${event.id}`,false);
  const href=publicWebHref(event.url);
  const original=event.label.replace(/^Codex\s*/,"").replace(/[：:]\s*$/,"").trim();
  const legacy=!event.action || /^Codex\s/.test(event.label);
  const sources=(event.sourceRefs??[]).flatMap(source=>{const url=publicWebHref(source.url);return url?[{...source,url}]:[];});
  const operation=activityOperation(event);
  const [sourcesOpen,setSourcesOpen]=useActivityDisclosure(`web-sources:${runId}:${event.id}`,operation==="webSearch" && !event.errorCount);
  const emptyFind=operation==="webFind" && event.state==="completed" && event.resultCount===0 && !event.errorCount;
  const resultLabel=emptyFind ? "本次未返回页内匹配结果。" : event.resultCount != null
    ? `本批返回 ${event.resultCount} 项${operation==="webSearch" ? "搜索结果" : "结果"}`
    : "这条记录未提供逐项返回结果";
  return <div className="agent-activity-step">
    <details className="agent-reasoning agent-web-activity" open={open} onToggle={change=>setOpen(change.currentTarget.open)}>
      <summary title={webSummary(event)}><ActivityIcon event={{...event,errorCount:0}}/><span>{webSummary(event)}</span><ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
      <div className="agent-web-details">
      <p className="agent-note">{resultLabel}</p>
      {legacy && original!==webLabel(event) && original!=="搜索网页" && <p>{original}</p>}
      {href && <p><a href={href} target="_blank" rel="noreferrer">打开网页</a></p>}
      {event.detail && <p>{event.detail}</p>}
      {!!event.errorCount && <div className="agent-process-failure"><div><p>本批 {event.errorCount} 项未能获取。</p>{!!event.errors?.length && <ul aria-label="网页访问失败详情">{event.errors.map((error,index)=>{const link=publicWebHref(error.url);return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{new URL(link).hostname}</a> : "网页访问"} · {error.reason || "当前展示记录未包含具体原因"}</li>;})}</ul>}{(!event.errors?.length || event.errors.length<event.errorCount!) && <p>当前展示记录未包含{event.errors?.length ? "其余错误的" : ""}具体原因。</p>}</div></div>}
      {!!event.queries?.length && <ul aria-label="本批搜索词">{event.queries.map((query,index)=><li key={index}>{query}</li>)}</ul>}
      {event.pattern && <p>查找内容：{event.pattern}</p>}
      {!!sources.length && <details open={sourcesOpen} onToggle={change=>setSourcesOpen(change.currentTarget.open)}><summary>返回来源 · {sources.length}</summary><ul className="agent-source-chips" aria-label="本批返回的来源">{sources.map((source,index)=><li key={index}><a href={source.url} target="_blank" rel="noreferrer"><WebsiteIcon url={source.url} title={source.title || source.url} hosts={[new URL(source.url).hostname]} workId={open ? workId : undefined}/><span>{source.title || new URL(source.url).hostname}</span></a></li>)}</ul></details>}
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

function RecordedToolActivity({event, resultRef, scope}: {event:ActivityEvent;resultRef:ToolResultRef;scope:ToolResultScope}) {
  const [open,setOpen]=useState(false);
  const duration=eventDuration(event);
  return <div className={`agent-activity-step agent-step-${event.state}`}>
    <details className="agent-tool-activity agent-script-step" onToggle={change=>setOpen(change.currentTarget.open)}>
      <summary title={event.label}>
        <ActivityIcon event={event}/>
        <span className="agent-script-label">{event.label}</span>
        {duration && <small className="agent-operation-duration">{duration}</small>}
        {eventStateLabel(event) && <span className="agent-step-state">{eventStateLabel(event)}</span>}
        <ChevronDown size={12} className="agent-reasoning-chevron" aria-hidden="true"/>
      </summary>
      {open && <>
        {event.detail && event.detail!=="脚本执行成功" && <p>{event.detail}</p>}
        <AgentToolResult value={resultRef} scope={scope} embedded scriptState={["analyzeFiles","compute"].includes(event.operation??"") ? event.state : undefined}/>
      </>}
    </details>
  </div>;
}

function ActivityEventView({ event, scope, runId }: { event: ActivityEvent; scope: ToolResultScope | null; runId:string }) {
  const span=event.readSpan;
  event={
    ...event,
    label:event.toolName && event.kind==="tool" ? event.toolName : span?.title ? `读取原文 · ${span.title}` : activityLabel(event),
    detail:span && span.end>span.start ? `已读取 ${span.start+1}–${span.end} / ${span.total} 字符` : event.detail,
  };
  if (event.label === "核对任务状态（内部）" && event.state === "completed") return <details className="agent-reasoning"><summary>已核对任务状态</summary><div>{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</div></details>;
  if (event.kind === "unpublishedAnswer") return <UnpublishedAnswer text={event.label} truncated={event.truncated}/>;
  if (event.kind === "webSearch") return <WebActivity event={event} runId={runId} workId={scope?.workId}/>;
  if (event.kind==="tool" && (event.operation || event.toolName) && !event.agentIds?.length && event.resultRef && scope) {
    return <RecordedToolActivity event={event} resultRef={event.resultRef} scope={scope}/>;
  }
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
    <ActivityIcon event={event}/><ActivityIdentity events={[event]} workId={scope?.workId} primaryIcon={event}/>
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
const isCodexSummary=(event:ActivityEvent)=>event.kind==="reasoning" && !!event.origin?.startsWith("codex");
const operationFailed=(event:ActivityEvent)=>event.state==="failed" || event.state==="interrupted" || !!event.errorCount;
const phaseToolLabels = new Map([
  ["github.fetch_issue", "读取 GitHub 议题"],
  ["github.add_comment_to_issue", "准备 GitHub 评论草稿"],
  ["github.fetch_issue_comments", "读取 GitHub 评论"],
]);

function externalPhaseTitle(operations:ActivityEvent[]) {
  const actions = [...new Set(operations.flatMap(event => {
    if (event.toolName === "catalog") return [];
    if (activityOperation(event) === "browser") return ["浏览网页"];
    const label=phaseToolLabels.get(event.toolName ?? "");
    if (label) return [label];
    if (activityOperation(event) === "mcp" && event.serviceId) {
      const service = activityServiceTitle(event.serviceId, operations);
      if (service) return [`查询 ${service}`];
    }
    return [];
  }))];
  if (!actions.length) return undefined;
  return actions.length <= 2 ? actions.join(" · ") : `${actions[0]} · ${operations.length} 步`;
}

const mixedPhaseActions = new Map<ActivityOperation,string>([
  ["browser", "浏览了网页"],
  ["command", "运行了命令"],
  ["edit", "编辑了文件"],
  ["readChat", "读取了聊天"],
  ["renameChat", "重命名了聊天"],
]);

function mixedPhaseOverview(operations:ActivityEvent[]) {
  const services = new Map<string,ActivityEvent[]>();
  const actions = new Map<ActivityOperation,ActivityEvent[]>();
  for (const event of operations) {
    if (event.toolName === "catalog") continue;
    const operation = activityOperation(event);
    const service = operation === "mcp" && event.serviceId ? activityServiceTitle(event.serviceId, operations) : undefined;
    if (service) {
      const entries = services.get(service) ?? [];
      entries.push(event);
      services.set(service, entries);
    } else {
      const entries = actions.get(operation) ?? [];
      entries.push(event);
      actions.set(operation, entries);
    }
  }
  if (services.size + actions.size < 2 || (!services.size && ![...actions.keys()].some(key=>mixedPhaseActions.has(key)))) return undefined;
  const completed = (events:ActivityEvent[]) => events.every(event=>event.state === "completed" && !operationFailed(event));
  const parts = [
    ...[...services].map(([service,events])=>completed(events) ? `使用了 ${service}` : `${service} 工具`),
    ...[...actions].map(([action,events])=>(completed(events) ? mixedPhaseActions.get(action) : undefined) ?? operationLabels[action]),
  ];
  return {title:parts.join("、"), icon:([...services.values(),...actions.values()])[0][0]};
}

function OperationPhase({events,scope,current,live,segmented,settled,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;current?:ActivityEvent;live:boolean;segmented:boolean;settled:boolean;runId:string}) {
  const [open,setOpen]=useActivityDisclosure(`group:${runId}:${events[0].id}`,false);
  const [summariesOpen,setSummariesOpen]=useActivityDisclosure(`summaries:${runId}:${events[0].id}`,false);
  const [visible,setVisible]=useState(8);
  const operations=events.filter(isOperation);
  const visibleCount=live && open ? Math.max(visible,operations.length) : visible;
  useEffect(()=>{
    if(visibleCount>visible)setVisible(visibleCount);
  },[visibleCount,visible]);
  const summaries=events.filter(isCodexSummary);
  const failed=operations.some(event=>operationFailed(event) && (event.kind!=="webSearch" || settled));
  const active=current?.state==="running";
  const labels = [...new Set(operations.map(event => operationLabels[activityOperation(event)]))];
  const mixedWeb = labels.length > 1 && operations.every(event=>event.kind==="webSearch");
  const mixed = mixedPhaseOverview(operations);
  const summaryIcon=mixed?.icon ?? (labels.length>1 && !mixedWeb
    ? {...operations[0],kind:"tool" as const,operation:"mixed"} : operations[0]);
  const readSpan=operations.length===1 ? operations[0].readSpan : undefined;
  const attachmentTitle=operations.length===1 && operations[0].operation==="analyzeFiles"
    ? activityLabel(operations[0]) : undefined;
  const overview=!operations.length ? "公开思考摘要" : mixedWeb ? `网页检索 · ${operations.length} 步`
    : mixed?.title ?? externalPhaseTitle(operations) ?? (operations.every(event=>event.state==="completed"&&!event.errorCount)?"已":"")+(attachmentTitle ?? labels.join("、"))+(readSpan?.title ? ` · ${readSpan.title}` : "");
  const latest=current ?? (live && operations.length>1 ? operations[operations.length-1] : undefined);
  let summary=overview;
  if(latest) {
    const label=latest.kind==="webSearch" ? webLabel(latest) : phaseToolLabels.get(latest.toolName ?? "") ?? activityLabel(latest);
    const verb=/^(读取|重命名|搜索|打开|访问|运行|执行|检查|核对|验证|编辑|加载|查找|整理|分析|生成|保存|创建|准备)/.test(label);
    if(latest.state==="running")summary=verb ? "正在"+label : label;
    else if(latest.state==="queued")summary="等待："+label;
    else if(operationFailed(latest))summary=label+" · "+(eventStateLabel(latest)||"部分未完成");
    else summary=latest.state==="completed" && verb ? "已"+label : label;
  }
  const steps=<div className="agent-operation-children">
    {operations.slice(0,visibleCount).map(event=><ActivityEventView key={event.id} event={event} scope={scope} runId={runId}/>)}
    {visibleCount<operations.length && <button type="button" className="agent-show-more" onClick={()=>setVisible(count=>count+8)}>显示更多步骤 · 另 {operations.length-visibleCount} 项</button>}
    {!!summaries.length && (operations.length ? <details className="agent-public-summaries" open={summariesOpen} onToggle={event=>setSummariesOpen(event.currentTarget.open)}>
      <summary>公开思考摘要 · {summaries.length} 条</summary>
      {summariesOpen && summaries.map(event=><ActivityEventView key={event.id} event={event} scope={scope} runId={runId}/>)}
    </details> : summaries.map(event=><ActivityEventView key={event.id} event={event} scope={scope} runId={runId}/>))}
  </div>;
  if(!segmented && !summaries.length && operations.every(event=>event.kind==="tool" && (event.operation || event.toolName)))return steps;
  const headingIcon = latest ?? (summaryIcon && {...summaryIcon,state:"completed",errorCount:0});
  return <details className={`agent-operation-group${active?" agent-operation-active":""}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary title={summary}>
      {headingIcon && <ActivityIcon event={headingIcon}/>}
      <span className="agent-phase-label">{summary}</span>
      <ActivityIdentity events={operations} workId={scope?.workId} primaryIcon={headingIcon}/>
      <ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/>
      {failed&&!open&&<small className="agent-phase-warning" role="status"><TriangleAlert size={12} aria-hidden="true"/>部分未完成</small>}
    </summary>
    {steps}
  </details>;
}
function ActivityTimeline({events,scope,running,segmented,settled,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean;segmented:boolean;settled:boolean;runId:string}) {
  const groups:ActivityEvent[][]=[];
  const boundary=(event:ActivityEvent)=>!isOperation(event) && !isCodexSummary(event);
  for(const event of events){
    const previous=groups[groups.length-1];
    if(!boundary(event)&&previous&&!boundary(previous[0]))previous.push(event);
    else groups.push([event]);
  }
  const latest=groups[groups.length-1] ?? [];
  const current=running ? [...latest].reverse().find(event=>isOperation(event) && event.state==="running")
    ?? latest.find(event=>isOperation(event) && event.state==="queued") : undefined;
  const reportedStatus=latest.some(event=>boundary(event) && event.state==="running");
  return <>
    {groups.map(group=>boundary(group[0])
      ? <ActivityEventView key={group[0].id} event={group[0]} scope={scope} runId={runId}/>
      : <OperationPhase key={group[0].id} events={group} scope={scope} runId={runId} segmented={segmented} settled={settled} live={running && group===latest} current={group===latest ? current : undefined}/>)}
    {running && !current && !reportedStatus && <p className="agent-live-status" role="status"><span>正在思考</span></p>}
  </>;
}

const toolPermissionNames:Record<string,string> = {
  "github.fetch_issue": "读取议题",
  "github.add_comment_to_issue": "准备评论草稿",
  browser_navigate: "打开网页",
  browser_snapshot: "读取页面",
  browser_click: "点击网页元素",
};

function RuntimePermissions({capabilities,events}:{capabilities:NonNullable<ActivityRun["capabilities"]>;events:ActivityEvent[]}) {
  return <div className="agent-runtime-details" aria-label="本轮工具与权限">
    <p>本轮工具与权限</p>
    <ul>
      <li>Hub 工具{capabilities.nativeCapabilities?.workspace && " · 独立工作区（无网络）"}{capabilities.nativeCapabilities?.multiAgent && " · 子任务委派"}</li>
      {capabilities.webSearch && <li>内置网页搜索 · {capabilities.webSearch==="live" ? "实时搜索" : capabilities.webSearch==="cached" ? "缓存搜索" : "关闭"}</li>}
      {capabilities.externalTools?.map(service => {
        const name = service.server.startsWith("browser:") ? "独立浏览器 · "+service.server.slice(8).split("|").join("、")
          : activityServiceTitle(service.server, events) || (service.server.startsWith("app:") ? "已连接应用" : service.server);
        const tools = service.tools.map(tool => toolPermissionNames[tool]);
        return <li key={service.server}>{name} · {tools.length && tools.every(Boolean) ? tools.join("、") : `${service.tools.length} 个已选工具`}
          {service.writeRepository && ` · 评论目标 ${service.writeRepository}`}</li>;
      })}
      {capabilities.nativeCapabilities?.multiAgent && <li>主线程与子代理用量分别记录。缺失用量显示为未知。</li>}
    </ul>
  </div>;
}

export function AgentActivity({ value, onRecheck, requestText }: { value: ActivityRun; onRecheck?: () => void; requestText?:string }) {
  const hasNativeSegments = value.native && !value.validity && value.events.some(event=>event.kind==="message") && value.events.some(event=>event.origin?.startsWith("codex"));
  const [expanded, setExpanded] = useActivityDisclosure(`run:${value.runId}`,value.running || !!hasNativeSegments);
  const [emptyOpen, setEmptyOpen] = useActivityDisclosure(`empty:${value.runId}`,false);
  const [permissionsOpen, setPermissionsOpen] = useActivityDisclosure(`permissions:${value.runId}`,false);
  const detailsId = useId();
  const permissionsId = useId();
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
  const processing=value.running && !answer;
  const timeLabel=processing ? "已处理" : "用时";
  const publicSummaries=value.events.filter(event=>event.kind==="reasoning"&&event.origin==="deepseek");
  const processEvents=value.events.filter(event=>event.kind!=="answer"&&!isThinkingPlaceholder(event)&&!(event.kind==="message"&&publicSummaries.some(summary=>summary.label.trim()===event.label.trim()&&summary.createdAt<=event.createdAt))).sort((a,b)=>a.sequence!=null&&b.sequence!=null?a.sequence-b.sequence:a.createdAt-b.createdAt);
  const stopped = !value.running && ["failed","interrupted","needsDecision"].includes(value.state);
  const failure = stopped ? newest.find(event=>event.state==="failed" || event.state==="interrupted") : undefined;
  const toolIssues=processEvents.filter(event=>isOperation(event)&&event.kind!=="webSearch"&&(event.state==="failed"||event.state==="interrupted"));
  const lastToolIssue=toolIssues[toolIssues.length-1];
  const hasProcess = processEvents.length>0 || !!value.validity && !!value.capabilities;
  const hasTimeline=hasProcess || processing;
  const canDisclose=hasProcess || !!(value.native || value.capabilities);
  const processOpen=hasTimeline ? expanded : emptyOpen;
  const stateLabel = !value.running && (value.state==="needsDecision" ? " · 待确认" : value.state==="interrupted" ? " · 已暂停" : value.state==="failed" ? " · 未完成" : "");
  const webIssue=!value.running && !value.validity && (specifiedPageIssue(newest,requestText)
    ?? (failure?.kind==="webSearch" ? {label:webSummary(failure),detail:failure.detail} : undefined));
  const clippedProgress=processEvents.filter(event=>["message","reasoning","plan"].includes(event.kind));
  const clippingInText=clippedProgress.some(event=>event.label.trimEnd().endsWith(progressClippingNotice));
  const clipped=clippingInText || clippedProgress.some(event=>event.truncated);
  const timeControl = canDisclose ? <button type="button" className="agent-activity-toggle" title={processOpen ? "收起工作过程" : "展开工作过程"} aria-expanded={processOpen} aria-controls={detailsId} onClick={()=>hasTimeline ? setExpanded(!processOpen) : setEmptyOpen(!processOpen)}>
      <span className="agent-run-time">{timeLabel} {duration}{stateLabel}</span><ChevronDown className={processOpen ? "" : "agent-collapsed"} size={13} aria-hidden="true"/>
    </button> : (!processing || value.capabilities) && <p className="agent-elapsed">{timeLabel} {duration}{stateLabel}</p>;
  return <section className="agent-activity" data-live={processing || undefined} aria-label="本轮工作过程">
    {value.capabilities ? <>
      <div className="agent-activity-heading">
        {timeControl}
        <button type="button" className="agent-runtime-toggle" aria-label="本轮工具与权限" title="本轮工具与权限"
          aria-expanded={permissionsOpen} aria-controls={permissionsId} onClick={()=>setPermissionsOpen(!permissionsOpen)}>
          <Ellipsis size={16} aria-hidden="true"/>
        </button>
      </div>
      {permissionsOpen && <div id={permissionsId}><RuntimePermissions capabilities={value.capabilities} events={processEvents}/></div>}
    </> : timeControl}
    {value.validity && <div className="agent-process-failure" role="status">
      <TriangleAlert size={14} aria-hidden="true"/><span>{value.validity}</span>
      {onRecheck && <button type="button" onClick={onRecheck}>准备重新核对</button>}
    </div>}
    {webIssue && <p className="agent-process-failure agent-web-warning" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{webIssue.label}{webIssue.detail ? ` · ${webIssue.detail}` : ""}</span></p>}
    {processOpen && (hasTimeline || canDisclose) && <div id={detailsId} className="agent-activity-events" aria-label="完整工作过程">
      {hasTimeline ? <ActivityTimeline running={processing} segmented={!!value.native} settled={!value.running} events={processEvents} scope={value.validity ? null : scope} runId={value.runId}/>
        : <p className="agent-activity-empty">本轮暂无可回看的公开过程。</p>}
    </div>}
    {!expanded && lastToolIssue && <p className="agent-process-failure" role="status" aria-label="工具操作未完成"><TriangleAlert size={14} aria-hidden="true"/><span>{toolIssues.length>1&&`${toolIssues.length} 项工具操作未完成 · `}{lastToolIssue.label} · {eventStateLabel(lastToolIssue)}{lastToolIssue.detail ? `：${lastToolIssue.detail}` : ""}</span></p>}
    {!expanded && failure && failure.kind!=="webSearch" && !isOperation(failure) && <p className="agent-process-failure" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{failure.label} · {failure.state==="failed" ? "未完成" : "已中断"}{failure.detail ? `：${failure.detail}` : ""}</span></p>}
    {clipped && (!expanded || !clippingInText) && <p className="agent-note" role="status" aria-label="过程显示限制">过程消息超过显示上限，后续内容未展示。</p>}
    {!expanded && unpublished && <ActivityEventView event={unpublished} scope={null} runId={value.runId}/>}
    {value.running && answer && <div className="agent-report agent-answer agent-native-answer" aria-label="正在生成回答" aria-busy="true">{answer.origin==="deepseek"&&<p className="agent-note">{answer.truncated?"回答预览已达显示上限，仍在接收；完整回答核验后交付":"回答预览 · 完整接收并核验后交付"}</p>}<PublicText text={answer.label}/></div>}
  </section>;
}
