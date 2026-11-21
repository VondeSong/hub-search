import { publicWebHref } from "./AgentWebSources";
import { invoke } from "@tauri-apps/api/core";
import { createContext, memo, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis, TriangleAlert } from "lucide-react";
import { ActivityIcon, ActivityIdentity, WebsiteIcon, activityLabel, activityOperation, activityServiceTitle, operationLabels, type ActivityOperation } from "./AgentActivityIdentity";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentToolResult, type ToolResultRef, type ToolResultScope } from "./AgentToolResult";
import { AgentImagePreview } from "./AgentFileInputs";

type ActivitySource = {url:string;title?:string|null;query?:string|null};
type PatchPreview = {patch?:string|null;truncated?:boolean; added?:number|null; removed?:number|null};
type FileChange = PatchPreview & {path:string};
export type ActivityEvent = { id: string; sequence?:number; updatedAt?:number; operation?:string|null; serviceId?:string|null; serviceTitle?:string|null; toolName?:string|null; agentIds?:string[]|null; agentStates?:Record<string,{status:string}>|null; origin?:string; truncated?:boolean; kind: "answer" | "context" | "message" | "reasoning" | "plan" | "unpublishedAnswer" | "webSearch" | "skill" | "tool" | "status"; state: string; label: string; detail?: string | null; url?:string|null; actionId?: string; resultRef?: ToolResultRef; readSpan?: {title:string;start:number;end:number;total:number}; createdAt: number; finishedAt?: number; exitCode?:number|null; commandOutput?:string|null; outputTruncated?:boolean; fileChanges?:FileChange[]|null; imageCount?:number; action?:string|null; queries?:string[]|null; pattern?:string|null; sourceRefs?:ActivitySource[]|null; resultCount?:number|null; errorCount?:number|null; errors?:{refId:string;url?:string|null;reason?:string|null}[]|null; omittedSourceCount?:number|null };
export type ActivityRun = { workId?:string;currentWorkRevision?:number;authorizationVersion?:number;runId: string; revision: number; state: string; running: boolean; native?:boolean; capabilities?:{externalTools?:{server:string;tools:string[];writeRepository?:string|null}[];webSearch?:string;nativeCapabilities?:{workspace:boolean;multiAgent:boolean}}|null; measurement?:{turnTokens?:{inputTokens?:number|null;cachedInputTokens?:number|null;uncachedInputTokens?:number|null;outputTokens?:number|null}}; canSteer?:boolean; startedAt: number; finishedAt?: number | null; steps: number; events: ActivityEvent[]; workspaceChanges?: (PatchPreview & {files:number})|null; validity?: string };

const DisclosureContext=createContext<{
  expanded:Map<string,boolean>;
  phaseRows:Map<string,number>;
}|null>(null);
const FollowConversationContext = createContext<(() => boolean) | undefined>(undefined);
// Keep disclosure choices across remounts within the active chat.
export function ActivityDisclosureProvider({children, isFollowing}:{children:ReactNode;isFollowing?:()=>boolean}) {
  const [choices]=useState(()=>({expanded:new Map<string,boolean>(),phaseRows:new Map<string,number>()}));
  return <FollowConversationContext.Provider value={isFollowing}>
    <DisclosureContext.Provider value={choices}>{children}</DisclosureContext.Provider>
  </FollowConversationContext.Provider>;
}
function rememberActivityChoice<T>(choices:Map<string,T>|undefined,key:string,value:T) {
  if(!choices)return;
  choices.delete(key);
  choices.set(key,value);
  if(choices.size>256)choices.delete(choices.keys().next().value!);
}
function useActivityDisclosure(key:string,initial:boolean):[boolean,(value:boolean)=>void] {
  const choices=useContext(DisclosureContext)?.expanded;
  const [open,setOpen]=useState(()=>choices?.get(key)??initial);
  useEffect(()=>{setOpen(choices?.get(key)??initial);},[key,choices]);
  return [open,value=>{
    rememberActivityChoice(choices,key,value);
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
function webQueries(event:ActivityEvent) {
  return [...new Set((event.queries ?? []).map(query=>query.trim()).filter(Boolean))];
}
function webLabel(event:ActivityEvent) {
  const operation = activityOperation(event);
  const legacyLabel = !event.action && event.label.trim();
  const label = operation === "webUnknown" ? (legacyLabel && legacyLabel !== "查阅网页资料" ? legacyLabel : "网页操作") : operationLabels[operation];
  const subject = operation === "webSearch" ? webQueries(event)[0]
    : operation === "webFind" ? event.pattern : operation === "webOpen" && publicWebHref(event.url) ? new URL(event.url!).hostname : undefined;
  return subject ? `${label} · ${subject.replace(/\s+/g," ")}` : label;
}

function SourceChips({sources, workId, label}: {sources:ActivitySource[];workId?:string;label:string}) {
  return <ul className="agent-source-chips" aria-label={label}>{sources.map((source,index)=>{
    const domain = new URL(source.url).hostname;
    const title = source.title?.trim();
    const display = title && !/^(?:<|&lt;|https?:\/\/)/i.test(title) ? title : domain;
    return <li key={index}><a href={source.url} title={display} target="_blank" rel="noreferrer">
      <WebsiteIcon url={source.url} title={display} hosts={[domain]} workId={workId}/><span>{display}</span>
    </a></li>;
  })}</ul>;
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
  const queries = operation === "webSearch" ? webQueries(event) : [];
  const sourcesByQuery = new Map<string,ActivitySource[]>();
  const batchSources = sources.filter(source=>{
    const query = queries.length === 1 ? queries[0] : source.query?.trim();
    if (!query || !queries.includes(query)) return true;
    const matches = sourcesByQuery.get(query) ?? [];
    matches.push(source);
    sourcesByQuery.set(query,matches);
    return false;
  });
  const label = webLabel(event);
  const metadata = [queries.length>1 ? `另 ${queries.length-1} 条查询` : "",eventStateLabel(event)].filter(Boolean).join(" · ");
  const choices=useContext(DisclosureContext)?.expanded;
  const sourcesKey=`web-sources:${runId}:${event.id}`;
  const [sourcesOpen,setSourcesOpen]=useActivityDisclosure(sourcesKey,operation==="webSearch" && !event.errorCount);
  useEffect(()=>{
    if(open && batchSources.length && !choices?.has(sourcesKey))rememberActivityChoice(choices,sourcesKey,sourcesOpen);
  },[batchSources.length,choices,open,sourcesKey,sourcesOpen]);
  const emptyFind=operation==="webFind" && event.state==="completed" && event.resultCount===0 && !event.errorCount;
  const resultLabel=emptyFind ? "本次未返回页内匹配结果。" : event.resultCount != null
    ? `本批返回 ${event.resultCount} 项${operation==="webSearch" ? "搜索结果" : "结果"}`
    : "这条记录未提供逐项返回结果";
  return <div className="agent-activity-step">
    <details className="agent-reasoning agent-web-activity" open={open} onToggle={change=>setOpen(change.currentTarget.open)}>
      <summary title={[label,metadata].filter(Boolean).join(" · ")}><ActivityIcon event={{...event,errorCount:0}}/><span>{label}</span>{metadata&&<small>{metadata}</small>}<ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
      <div className="agent-web-details">
      <p className="agent-note">{resultLabel}</p>
      {legacy && original!==webLabel(event) && original!=="搜索网页" && <p>{original}</p>}
      {href && <p><a href={href} target="_blank" rel="noreferrer">打开网页</a></p>}
      {event.detail && <p>{event.detail}</p>}
      {!!event.errorCount && <div className="agent-process-failure"><div><p>本批 {event.errorCount} 项未能获取。</p>{!!event.errors?.length && <ul aria-label="网页访问失败详情">{event.errors.map((error,index)=>{const link=publicWebHref(error.url);return <li key={index}>{link ? <a href={link} target="_blank" rel="noreferrer">{new URL(link).hostname}</a> : "网页访问"} · {error.reason || "当前展示记录未包含具体原因"}</li>;})}</ul>}{(!event.errors?.length || event.errors.length<event.errorCount!) && <p>当前展示记录未包含{event.errors?.length ? "其余错误的" : ""}具体原因。</p>}</div></div>}
      {!!queries.length && <ul className="agent-web-queries" aria-label="本批搜索词">{queries.map(query=>{
        const matches = sourcesByQuery.get(query);
        return <li key={query}>{query}{matches && <SourceChips sources={matches} workId={open ? workId : undefined} label={`查询来源 · ${query}`}/>}</li>;
      })}</ul>}
      {event.pattern && <p>查找内容：{event.pattern}</p>}
      {!!batchSources.length && <details open={sourcesOpen} onToggle={change=>setSourcesOpen(change.currentTarget.open)}><summary>{operation==="webSearch" ? "本批来源" : "返回来源"} · {batchSources.length}</summary><SourceChips sources={batchSources} workId={open ? workId : undefined} label="本批返回的来源"/></details>}
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

function RecordedToolActivity({event, resultRef, scope, runId}: {event:ActivityEvent;resultRef:ToolResultRef;scope:ToolResultScope;runId:string}) {
  const [open,setOpen]=useActivityDisclosure(`tool:${runId}:${event.id}`,false);
  const [technicalOpen,setTechnicalOpen]=useActivityDisclosure(`technical:${runId}:${event.id}`,false);
  const [scriptOpen,setScriptOpen]=useActivityDisclosure(`script:${runId}:${event.id}`,false);
  const duration=eventDuration(event);
  return <div className={`agent-activity-step agent-step-${event.state}`}>
    <details className="agent-tool-activity agent-script-step" open={open} onToggle={change=>setOpen(change.currentTarget.open)}>
      <summary title={event.label}>
        <ActivityIcon event={event}/>
        <span className="agent-script-label">{event.label}</span>
        {eventStateLabel(event) && <span className="agent-step-state">{eventStateLabel(event)}</span>}
        <ChevronDown size={12} className="agent-reasoning-chevron" aria-hidden="true"/>
      </summary>
      {open && <>
        {event.detail && event.detail!=="脚本执行成功" && <p>{event.detail}</p>}
        {event.toolName && event.toolName!==event.label && <p className="agent-note">工具 · {event.toolName}</p>}
        <AgentToolResult value={resultRef} scope={scope} embedded scriptState={["analyzeFiles","compute"].includes(event.operation??"") ? event.state : undefined}
          disclosure={{technicalOpen,setTechnicalOpen,scriptOpen,setScriptOpen}}/>
        {duration && <p className="agent-note">耗时 {duration}</p>}
      </>}
    </details>
  </div>;
}

function PatchDetails({stateKey,title,path,value,children}: {stateKey:string;title:string;path?:string;value:PatchPreview;children?:ReactNode}) {
  const [open,setOpen]=useActivityDisclosure(stateKey,false);
  const [pathOpen,setPathOpen]=useActivityDisclosure(`${stateKey}:path`,false);
  let previous=0, next=0, inHunk=false;
  return <details className="agent-technical-record agent-patch-details" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary title={path}>{title}{value.added!=null && value.removed!=null && <small className="agent-patch-counts"><span>+{value.added}</span> <span>−{value.removed}</span></small>}</summary>
    {open && <>
      {value.patch ? <pre className="agent-receipt-text agent-patch" aria-label="文件差异" tabIndex={0}><code>{value.patch.replace(/\r?\n$/,"").split(/\r?\n/).map((line,index)=>{
        const head=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (head) [previous,next,inHunk]=[Number(head[1]),Number(head[2]),true];
        if (line.startsWith("diff --git ")) inHunk=false;
        const added=inHunk && line.startsWith("+"), removed=inHunk && line.startsWith("-"), context=inHunk && line.startsWith(" ");
        return <span key={index} className={added ? "agent-patch-added" : removed ? "agent-patch-removed" : undefined}>
          <span className="agent-patch-number" aria-hidden="true">{removed || context ? previous++ : ""}</span><span className="agent-patch-number" aria-hidden="true">{added || context ? next++ : ""}</span>{line}{"\n"}
        </span>;
      })}</code></pre> : <p className="agent-note">这条回执未保留可显示的差异。</p>}
      {value.truncated && <p className="agent-note">仅显示差异预览，完整内容超出保留范围。</p>}
      {children}
      {path && path!==title && <details className="agent-technical-record" open={pathOpen} onToggle={event=>setPathOpen(event.currentTarget.open)}><summary>完整路径</summary><pre>{path}</pre></details>}
    </>}
  </details>;
}

function ReceiptFile({sequence,index,runId,scope}: {sequence:number;index:number;runId:string;scope:ToolResultScope}) {
  const [file,setFile]=useState<{title:string;content:string;truncated:boolean}|null>(null);
  const [status,setStatus]=useState("");
  const opener=useRef<HTMLButtonElement>(null);
  const dialog=useRef<HTMLDialogElement>(null);
  const request=useRef(0);
  const {workId,currentWorkRevision,authorizationVersion}=scope;
  useEffect(()=>()=>{request.current++;if(dialog.current?.open)dialog.current.close();},[workId,currentWorkRevision,authorizationVersion,runId,sequence,index]);
  async function openFile() {
    const job=++request.current;
    setFile(null);setStatus("正在读取当前工作区文件…");dialog.current?.showModal();
    try {
      const preview=await invoke<NonNullable<typeof file>>("agent_investigation",{args:{action:"activityFilePreview",id:workId,runId,sequence,index,
        expectedWorkRevision:currentWorkRevision,expectedAuthorizationVersion:authorizationVersion}});
      if (request.current===job) {setFile(preview);setStatus("");}
    } catch {
      if (request.current===job) setStatus("当前文件无法预览，历史差异仍可回看。");
    }
  }
  return <>
    <button ref={opener} type="button" className="agent-receipt-open-file" onClick={()=>void openFile()}>查看当前文件</button>
    <dialog ref={dialog} className="agent-receipt-dialog agent-file-receipt" aria-label="当前工作区文件"
      onKeyDown={event=>{if(event.key==="Escape")event.stopPropagation();}}
      onClose={()=>{request.current++;opener.current?.focus();}}>
      <form method="dialog"><button type="submit">关闭文件</button></form>
      {status && <p role="status">{status}</p>}
      {file && <><p><strong>{file.title}</strong>{file.truncated && " · 文本预览"}</p><pre className="agent-receipt-text" tabIndex={0} aria-label="当前工作区文件内容">{file.content}</pre></>}
    </dialog>
  </>;
}

function ReceiptImage({sequence,index,runId,scope}: {sequence:number;index:number;runId:string;scope:ToolResultScope}) {
  const [image,setImage]=useState<{title:string;url:string}|null>(null);
  const [error,setError]=useState(false);
  const {workId,currentWorkRevision,authorizationVersion}=scope;
  useEffect(()=>{
    let current=true;
    setImage(null);setError(false);
    void invoke<{title:string;url:string}>("agent_investigation",{args:{action:"activityImagePreview",id:workId,runId,sequence,index,
      expectedWorkRevision:currentWorkRevision,expectedAuthorizationVersion:authorizationVersion}})
      .then(result=>{if(current)setImage(result);},()=>{if(current)setError(true);});
    return ()=>{current=false;};
  },[workId,runId,sequence,index,currentWorkRevision,authorizationVersion]);
  if (!image) return <p className="agent-note" role="status">{error ? "这张图像暂不可回读，来源或授权可能已变化。" : "正在读取图像预览…"}</p>;
  return <AgentImagePreview image={image}/>;
}

function reasoningPreview(event:ActivityEvent) {
  const text=event.label.replace(/[#*\n]/g," ").trim() || "正在思考";
  const prefix=event.state==="interrupted"?"已中断：":event.state==="failed"?"未完成：":"";
  return prefix+text;
}

function ActivityEventView({ event, scope, runId }: { event: ActivityEvent; scope: ToolResultScope | null; runId:string }) {
  const [detailOpen,setDetailOpen]=useActivityDisclosure(`detail:${runId}:${event.id}`,false);
  const [commandOpen,setCommandOpen]=useActivityDisclosure(`command:${runId}:${event.id}`,false);
  const span=event.readSpan;
  event={
    ...event,
    label:span?.title ? `读取原文 · ${span.title}` : toolActivityLabel(event),
    detail:span && span.end>span.start ? `已读取 ${span.start+1}–${span.end} / ${span.total} 字符` : event.detail,
  };
  if (event.label === "核对任务状态（内部）" && event.state === "completed") return <details className="agent-reasoning"><summary>已核对任务状态</summary><div>{event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}</div></details>;
  if (event.kind === "unpublishedAnswer") return <UnpublishedAnswer text={event.label} truncated={event.truncated}/>;
  if (event.kind === "webSearch") return <WebActivity event={event} runId={runId} workId={scope?.workId}/>;
  if (event.kind==="tool" && (event.operation || event.toolName) && !event.agentIds?.length && event.resultRef && scope) {
    return <RecordedToolActivity event={event} resultRef={event.resultRef} scope={scope} runId={runId}/>;
  }
  if (event.kind === "plan") return <details className="agent-reasoning"><summary>工作计划<ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  if (event.operation==="imageInput" || event.operation==="viewImage") return <div className="agent-activity-step agent-context-event">
    <ActivityIcon event={event}/><details open={detailOpen} onToggle={change=>setDetailOpen(change.currentTarget.open)}>
      <summary>{event.label}<ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary>
      {detailOpen && (scope && event.imageCount && event.sequence!=null ? <div className="agent-receipt-thumbnails">{Array.from({length:event.imageCount},(_,index)=><ReceiptImage key={index} sequence={event.sequence!} index={index} runId={runId} scope={scope}/>)}</div>
        : <p className="agent-note">这条回执没有可回读的图像引用。</p>)}
    </details></div>;
  if (event.kind === "context") return <div className="agent-activity-step agent-context-event"><ActivityIcon event={event}/>{event.detail ? <details open={detailOpen} onToggle={change=>setDetailOpen(change.currentTarget.open)}><summary><span>{event.label}</span><ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/></summary><p>{event.detail}</p></details> : <span>{event.label}</span>}</div>;
  if (event.kind === "message") return <div className="agent-commentary"><PublicText text={event.label}/></div>;
  if(event.kind==="status") {
    const label=(event.state==="failed"?"未完成：":event.state==="interrupted"?"已中断：":"")+event.label;
    return event.detail || (event.resultRef&&scope) ? <details className="agent-reasoning"><summary><span>{label}</span><ChevronDown size={12} aria-hidden="true"/></summary><div>{event.detail&&<p>{event.detail}</p>}{event.resultRef&&scope&&<AgentToolResult value={event.resultRef} scope={scope}/>}</div></details> : <p className="agent-reasoning">{label}</p>;
  }
  if (event.kind === "reasoning") {
    const text=reasoningPreview(event);
    const characters=Array.from(text);
    if(characters.length<=72) return <div className="agent-activity-step agent-reasoning" aria-label="思考摘要"><span>{text}</span></div>;
    return <details className="agent-reasoning"><summary><span>{characters.slice(0,72).join("")}…</span><ChevronDown className="agent-reasoning-chevron" size={13} aria-hidden="true"/></summary><div><PublicText text={event.label}/></div></details>;
  }
  const rawTool = event.toolName && event.toolName!==event.label ? event.toolName : undefined;
  const command = activityOperation(event)==="command" && event.origin==="codex-native";
  const exitLine = command && Number.isInteger(event.exitCode) ? `退出码 ${event.exitCode}` : undefined;
  const duration = eventDuration(event);
  return <div className={"agent-activity-step agent-step-" + event.state}>
    <ActivityIcon event={event}/><ActivityIdentity events={[event]} workId={scope?.workId} primaryIcon={event}/>
    <div>{command || event.fileChanges?.length || event.detail || rawTool || event.agentIds?.length || (event.resultRef && scope) || event.label.length>72 ? <details className="agent-tool-activity" open={detailOpen} onToggle={change=>setDetailOpen(change.currentTarget.open)}>
      <summary title={event.label}><span>{event.label}</span>{eventStateLabel(event)&&<span className="agent-step-state">{eventStateLabel(event)}</span>}<ChevronDown size={12} className="agent-reasoning-chevron" aria-hidden="true"/></summary>
      {event.label.length>72 && <p>{event.label}</p>}
      {rawTool && <p className="agent-note">工具 · {rawTool}</p>}
      {command && <>
        <p className="agent-script-status">{event.state==="completed" ? "执行完成" : eventStateLabel(event)}{exitLine && ` · ${exitLine}`}{duration && ` · 耗时 ${duration}`}</p>
        {event.commandOutput && <pre className="agent-receipt-text" tabIndex={0} aria-label={event.state==="running" ? "当前命令输出" : "命令输出"}><code>{event.commandOutput}</code></pre>}
        {event.outputTruncated || event.truncated && event.commandOutput ? <p className="agent-note">命令输出为截断预览。</p> : !event.commandOutput && event.state!=="running" && <p className="agent-note">这条回执未保留命令输出。</p>}
      </>}
      {event.fileChanges?.length ? event.fileChanges.map((file,index)=><PatchDetails key={index} stateKey={`patch:${runId}:${event.id}:${index}`} title={file.path.split(/[\\/]/).pop()||file.path} path={file.path} value={file}>
        {scope && event.sequence!=null && <ReceiptFile sequence={event.sequence} index={index} runId={runId} scope={scope}/>}
      </PatchDetails>)
        : event.detail && (command ? <details className="agent-technical-record" open={commandOpen} onToggle={change=>setCommandOpen(change.currentTarget.open)}><summary>查看命令</summary><pre>{exitLine && event.detail.endsWith("\n"+exitLine) ? event.detail.slice(0,-exitLine.length).trimEnd() : event.detail}</pre></details> : <p>{event.detail}</p>)}
      {!!event.agentIds?.length&&<ul aria-label="子代理状态">{event.agentIds.map(id=><li key={id}>{id.slice(-6)} · {({running:"进行中",completed:"已结束",failed:"未完成",errored:"未完成",interrupted:"已中断",pendingInit:"正在启动",shutdown:"已关闭"} as Record<string,string>)[event.agentStates?.[id]?.status??""]||"状态待核验"}</li>)}</ul>}
      {event.resultRef && scope && <AgentToolResult value={event.resultRef} scope={scope}/>}
      {!command && duration && <p className="agent-note">耗时 {duration}</p>}
    </details> : <span title={duration ? `耗时 ${duration}` : undefined}>{event.label}{eventStateLabel(event)&&<span className="agent-step-state"> · {eventStateLabel(event)}</span>}</span>}</div>
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
const isMaterialContext=(event:ActivityEvent)=>event.kind==="context" && event.origin==="hub-context" && !event.operation;
const isCodexSummary=(event:ActivityEvent)=>event.kind==="reasoning" && !!event.origin?.startsWith("codex");
const operationFailed=(event:ActivityEvent)=>event.state==="failed" || event.state==="interrupted" || !!event.errorCount;
const phaseToolLabels = new Map([
  ["github.fetch_issue", "读取 GitHub 议题"],
  ["github.add_comment_to_issue", "准备 GitHub 评论草稿"],
  ["github.fetch_issue_comments", "读取 GitHub 评论"],
]);
const browserToolLabels = new Map([
  ["browser_navigate", "打开网页"],
  ["browser_snapshot", "读取网页"],
  ["browser_click", "点击网页元素"],
  ["browser_type", "填写网页字段"],
  ["browser_tabs", "管理浏览器标签"],
]);

function toolActivityLabel(event:ActivityEvent) {
  if (event.kind!=="tool") return activityLabel(event);
  const operation = activityOperation(event);
  const tool = event.toolName ?? "";
  if (operation==="browser") {
    const action = browserToolLabels.get(tool) ?? "操作浏览器";
    const domains = new Set((event.sourceRefs ?? []).flatMap(source=>{
      const url = publicWebHref(source.url);
      return url ? [new URL(url).hostname] : [];
    }));
    const url = publicWebHref(event.url);
    const host = url ? new URL(url).hostname : domains.size===1 ? [...domains][0] : undefined;
    return host ? `${action} · ${host}` : action;
  }
  const known = phaseToolLabels.get(tool);
  if (known) return known;
  if (operation==="command" && event.origin==="codex-native") {
    const command = event.detail?.match(/^\s*((?:git|npm|cargo|pnpm) [\w:-]+|[\w-]+)(?=\s|$)/i)?.[1];
    return command ? `运行工作区命令 · ${command}` : "运行工作区命令";
  }
  if (operation==="edit" && event.origin==="codex-native" && event.detail) {
    const paths = event.detail.split("\n").filter(Boolean);
    const name = paths[0]?.split(/[\\/]/).pop();
    if (name) return `编辑工作区文件 · ${name}${paths.length>1 ? ` · 另 ${paths.length-1} 个文件` : ""}`;
  }
  if (!tool || event.label.trim()!==tool) return activityLabel(event);
  const service = event.serviceId ? activityServiceTitle(event.serviceId,[event]) : undefined;
  return service ? `调用 ${service} 工具` : operationLabels[operation];
}

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

const activityPageSize=8;

function OperationPhase({events,scope,current,live,segmented,settled,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;current?:ActivityEvent;live:boolean;segmented:boolean;settled:boolean;runId:string}) {
  const materialGroup=events.every(isMaterialContext);
  const choices=useContext(DisclosureContext);
  const groupKey=`group:${runId}:${events[0].id}`;
  const phaseRows=choices?.phaseRows;
  const [open,setOpen]=useActivityDisclosure(groupKey,materialGroup && choices?.expanded.get(`detail:${runId}:${events[0].id}`)===true);
  const [visible,setVisible]=useState(()=>phaseRows?.get(groupKey)??activityPageSize);
  const operations=events.filter(isOperation);
  const visibleCount=live && open ? Math.max(visible,events.length) : visible;
  useEffect(()=>{
    if(visibleCount>activityPageSize)rememberActivityChoice(phaseRows,groupKey,visibleCount);
    if(visibleCount>visible)setVisible(visibleCount);
  },[groupKey,phaseRows,visibleCount,visible]);
  const webPhase=operations.length>0 && operations.every(event=>event.kind==="webSearch");
  const failed=operations.some(event=>operationFailed(event) && (event.kind!=="webSearch" || settled));
  const active=current?.state==="running";
  const labels = [...new Set(operations.map(event => operationLabels[activityOperation(event)]))];
  const webOverview = webPhase && (operations.length>1 || live && labels.includes(operationLabels.webSearch));
  const webTitle = labels.every(label=>label===operationLabels.webUnknown) ? "网页操作" : "网页检索";
  const mixed = mixedPhaseOverview(operations);
  const summaryIcon=mixed?.icon ?? (labels.length>1 && !webPhase
    ? {...operations[0],kind:"tool" as const,operation:"mixed"} : operations[0]);
  const readSpan=operations.length===1 ? operations[0].readSpan : undefined;
  const attachmentTitle=operations.length===1 && operations[0].operation==="analyzeFiles"
    ? activityLabel(operations[0]) : undefined;
  const complete=operations.every(event=>event.state==="completed"&&!event.errorCount);
  const commandBatch=operations.length>1 && labels.length===1 && labels[0]===operationLabels.command;
  const summaryOnly=operations.length===0;
  const overview=summaryOnly ? reasoningPreview(events[0]) : materialGroup ? `资料准备 · ${operations.length} 项` : webOverview ? `${webTitle} · ${operations.length} 步`
    : commandBatch ? `${complete?"已运行命令":"运行命令"} · ${operations.length} 条`
    : mixed?.title ?? externalPhaseTitle(operations) ?? (complete?"已":"")+(attachmentTitle ?? labels.join("、"))+(readSpan?.title ? ` · ${readSpan.title}` : "");
  const latest=webOverview || materialGroup ? undefined : current ?? (!commandBatch && live && operations.length>1 ? operations[operations.length-1] : undefined);
  let summary=overview;
  if(latest) {
    const label=latest.kind==="webSearch" ? webLabel(latest) : toolActivityLabel(latest);
    const verb=/^(读取|重命名|搜索|打开|访问|运行|执行|检查|核对|验证|编辑|加载|查找|整理|分析|生成|保存|创建|准备)/.test(label);
    if(latest.state==="running")summary=verb ? "正在"+label : label;
    else if(latest.state==="queued")summary="等待："+label;
    else if(operationFailed(latest))summary=label+" · "+(eventStateLabel(latest)||"部分未完成");
    else summary=latest.state==="completed" && verb ? "已"+label : label;
  }
  const firstInHeading=summaryOnly && Array.from(overview).length<=72;
  const steps=<div className="agent-operation-children">
    {events.slice(firstInHeading ? 1 : 0,visibleCount).map(event=><ActivityEventView key={event.id} event={event} scope={scope} runId={runId}/>)}
    {visibleCount<events.length && <button type="button" className="agent-show-more" onClick={()=>setVisible(count=>count+activityPageSize)}>显示更多 · 另 {events.length-visibleCount} 项</button>}
  </div>;
  if(!segmented && operations.length===events.length && operations.every(event=>event.kind==="tool" && (event.operation || event.toolName)))return steps;
  const headingIcon = latest ?? (summaryIcon && {...summaryIcon,state:"completed",errorCount:0});
  return <details className={`agent-operation-group${active?" agent-operation-active":""}`} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary title={summary}>
      {headingIcon && <ActivityIcon event={headingIcon}/>}
      <span className="agent-phase-label">{summary}</span>
      {summaryOnly && <small>另 {events.length-1} 条</small>}
      <ActivityIdentity events={operations} workId={scope?.workId} primaryIcon={headingIcon} showRemainingSites={!live || !webPhase}/>
      <ChevronDown className="agent-reasoning-chevron" size={12} aria-hidden="true"/>
      {failed&&!open&&<small className="agent-phase-warning" role="status"><TriangleAlert size={12} aria-hidden="true"/>部分未完成</small>}
    </summary>
    {steps}
  </details>;
}
function ActivityTimeline({events,scope,running,segmented,settled,runId}:{events:ActivityEvent[];scope:ToolResultScope|null;running:boolean;segmented:boolean;settled:boolean;runId:string}) {
  const groups:ActivityEvent[][]=[];
  const boundary=(event:ActivityEvent)=>event.operation==="imageInput" || event.operation==="viewImage" || !isOperation(event) && !isCodexSummary(event);
  for(const event of events){
    const previous=groups[groups.length-1];
    if(!boundary(event)&&previous&&!boundary(previous[0])&&isMaterialContext(event)===isMaterialContext(previous[0]))previous.push(event);
    else groups.push([event]);
  }
  const latest=groups[groups.length-1] ?? [];
  const current=running ? [...latest].reverse().find(event=>isOperation(event) && event.state==="running")
    ?? latest.find(event=>isOperation(event) && event.state==="queued") : undefined;
  const reportedStatus=latest.some(event=>boundary(event) && event.state==="running");
  const continuingWebPhase=latest.some(event=>event.kind==="webSearch");
  return <>
    {groups.map(group=>boundary(group[0]) || (group.length===1 && (isMaterialContext(group[0]) || isCodexSummary(group[0])))
      ? <ActivityEventView key={group[0].id} event={group[0]} scope={scope} runId={runId}/>
      : <OperationPhase key={group[0].id} events={group} scope={scope} runId={runId} segmented={segmented} settled={settled} live={running && group===latest} current={group===latest ? current : undefined}/>)}
    {running && !current && !reportedStatus && !continuingWebPhase && <p className="agent-live-status" role="status"><span>正在思考</span></p>}
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
  const [reviewing, setReviewing] = useActivityDisclosure(`reviewing:${value.runId}`,false);
  const isFollowing = useContext(FollowConversationContext);
  const waitingRun = useRef<string | undefined>(undefined);
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
  useLayoutEffect(() => {
    if (!answer) {
      if (value.running) waitingRun.current = value.runId;
      return;
    }
    if (waitingRun.current !== value.runId) return;
    waitingRun.current = undefined;
    if (expanded && !reviewing && isFollowing?.()) setExpanded(false);
  },[answer,value.running,value.runId,expanded,reviewing,isFollowing,setExpanded]);
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
    ?? (failure?.kind==="webSearch" ? {label:[webLabel(failure),eventStateLabel(failure)].filter(Boolean).join(" · "),detail:failure.detail} : undefined));
  const clippedProgress=processEvents.filter(event=>["message","reasoning","plan"].includes(event.kind));
  const clippingInText=clippedProgress.some(event=>event.label.trimEnd().endsWith(progressClippingNotice));
  const clipped=clippingInText || clippedProgress.some(event=>event.truncated);
  const workspace = !value.validity && value.workspaceChanges?.files ? value.workspaceChanges : undefined;
  const timeControl = canDisclose ? <button type="button" className="agent-activity-toggle" title={processOpen ? "收起工作过程" : "展开工作过程"} aria-expanded={processOpen} aria-controls={processOpen ? detailsId : undefined} onClick={()=>{
    if (hasTimeline) {
      setReviewing(true);
      setExpanded(!processOpen);
    } else setEmptyOpen(!processOpen);
  }}>
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
    {processOpen && (hasTimeline || canDisclose) && <div id={detailsId} className="agent-activity-events" aria-label="完整工作过程" onClickCapture={()=>{if(!reviewing)setReviewing(true);}} onFocusCapture={()=>{if(!reviewing)setReviewing(true);}}>
      {hasTimeline ? <ActivityTimeline running={processing} segmented={!!value.native} settled={!value.running} events={processEvents} scope={value.validity ? null : scope} runId={value.runId}/>
        : <p className="agent-activity-empty">本轮暂无可回看的公开过程。</p>}
    </div>}
    {!expanded && lastToolIssue && <p className="agent-process-failure" role="status" aria-label="工具操作未完成"><TriangleAlert size={14} aria-hidden="true"/><span>{toolIssues.length>1&&`${toolIssues.length} 项工具操作未完成 · `}{lastToolIssue.label} · {eventStateLabel(lastToolIssue)}{lastToolIssue.detail ? `：${lastToolIssue.detail}` : ""}</span></p>}
    {!expanded && failure && failure.kind!=="webSearch" && !isOperation(failure) && <p className="agent-process-failure" role="status"><TriangleAlert size={14} aria-hidden="true"/><span>{failure.label} · {failure.state==="failed" ? "未完成" : "已中断"}{failure.detail ? `：${failure.detail}` : ""}</span></p>}
    {clipped && (!expanded || !clippingInText) && <p className="agent-note" role="status" aria-label="过程显示限制">过程消息超过显示上限，后续内容未展示。</p>}
    {!expanded && unpublished && <ActivityEventView event={unpublished} scope={null} runId={value.runId}/>}
    {value.running && answer && <div className="agent-report agent-answer agent-native-answer" aria-label="正在生成回答" aria-busy="true">{answer.origin==="deepseek"&&<p className="agent-note">{answer.truncated?"回答预览已达显示上限，仍在接收；完整回答核验后交付":"回答预览 · 完整接收并核验后交付"}</p>}<PublicText text={answer.label}/></div>}
    {workspace && <PatchDetails stateKey={`workspace:${value.runId}`} title={`本轮文件变更 · ${workspace.files} 个文件`} value={workspace}/>}
  </section>;
}
