import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Clock3, Link2, Pause, RefreshCw, Settings2, X } from "lucide-react";
import type { CollectionLibraryOperation } from "./CollectionDestination";
import { useDidaReadingLogin } from "./useDidaReadingLogin";
import { openDidaReadingCleanupSettings } from "./CloudSyncEvents";
import { didaRetentionExplanation, didaRetentionKind, type DidaRetentionReason } from "./DidaReadingStatus";
import { DidaReadingResolutions } from "./DidaReadingResolutions";
import { ReadingLegacyReservation } from "./ReadingLegacyReservation";
import "./CollectionSyncPanel.css";

export type CollectionSource = "bookmarks" | "likes" | "telegram" | "dida";
export type DidaCleanup = { mode: "local" | "cloud-preserve" | "cloud-verified"; cleanupEnabled?: boolean; cloudReading?: boolean; pending: number; preserved?: number; verified: number; deleted: number; authRequired: boolean; reasons: DidaRetentionReason[]; lastRun?: {attempted:number;completed:number;deferred:number;blocked:number;authenticationRequired?:boolean} };
export type CollectionSyncSource = { paired?: boolean; botUsername?: string; pairingUrl?: string; id: CollectionSource; count: number; connected: boolean; canResume: boolean; status: string; lastSuccess?: number; lastCheckedAt?: number; nextSyncAt?: number; autoBlocked?: boolean; didaCleanup?: DidaCleanup };
export type CollectionSyncJob = { id: number; running: boolean; phase: string; source: string; processed: number; total: number; downloadedBytes: number; fileBytes: number; fileTotal?: number; message: string; outcome: string };
const sourceName = (source: string) => source === "dida" ? "滴答稍后读" : source === "telegram" ? "Telegram" : source === "likes" ? "X 喜欢" : "X 书签";
const time = (value?: number) => value ? new Date(value * 1000).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}) : "待首次同步";
const timestamp = (value?: number) => value ? new Date(value * 1000).toLocaleString([], {month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const operationLabel = (op: CollectionLibraryOperation) => op.phase === "cancelled" ? "已取消" : op.error && !["partial","unknown","needs_review"].includes(op.phase) ? "待重试" : ({queued:"等待处理",ready:"准备保存",planning:"生成方案中",saving:"保存中",writing:"写入中",cleanup:"记录副本中",needs_review:"待确认",partial:"需要补齐",unknown:"需要核对",failed:"保存失败"} as Record<string,string>)[op.phase] || op.phase;
const operationTitle = (op: CollectionLibraryOperation, titles: Record<string,string>) => op.itemTitle?.trim() || (op.key && titles[op.key]) || op.plan?.title?.trim() || op.plan?.tasks?.find(task=>task.title.trim())?.title || `阅读条目 · ${op.key || "未知条目"}`;

type Props = {
  sources: CollectionSyncSource[]; operations: CollectionLibraryOperation[]; itemTitles: Record<string,string>;
  autoSyncMinutes: number; storageLabel: string; storageStatus: string; pendingCancellations: number;
  job?: CollectionSyncJob; jobRunning: boolean; jobVisible: boolean;
  sourceBusy: (source: CollectionSource) => boolean; sourceActive: (source: CollectionSource) => boolean;
  onClose: () => void; onSettings: () => void; onSync: (source: CollectionSource, restart: boolean) => void;
  onPause: () => void; onStore: () => void; onConnect: (source: CollectionSource) => void; onOpenUrl: (url: string) => void;
  onDidaLogin: () => void | Promise<void>; onReview: (key: string, target: string) => void; onRetry: (op: CollectionLibraryOperation) => void; onContinueCopy: (op: CollectionLibraryOperation) => void;
  children: ReactNode;
};

export function CollectionSyncPanel(props: Props) {
  const {sources,operations,job}=props;
  const dida=sources.find(source=>source.id==="dida");
  const didaRun=dida?.didaCleanup?.lastRun;
  const latestAuthFailure=didaRun?.authenticationRequired===true||(didaRun?.authenticationRequired===undefined&&!!didaRun&&(didaRun.deferred+didaRun.blocked)>0&&/网页登录|\b40[13]\b/.test(dida?.status||""));
  const login=useDidaReadingLogin(!!dida?.didaCleanup?.authRequired,dida?.lastCheckedAt,dida?.status||"",latestAuthFailure,props.onDidaLogin);
  const [activePage,setActivePage]=useState(0),[historyPage,setHistoryPage]=useState(0);
  const [tab,setTab]=useState<"sync"|"operations"|"settings">("sync");
  const bodyRef=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(bodyRef.current)bodyRef.current.scrollTop=0;},[tab]);
  const panelId=useId();
  const active=operations.filter(op=>op.phase!=="cancelled"),history=operations.filter(op=>op.phase==="cancelled");
  const sourceOrder:CollectionSource[]=sources.find(source=>source.id==="dida")?.didaCleanup?.authRequired?["dida","likes","bookmarks","telegram"]:["likes","bookmarks","telegram","dida"];
  const tabs=[{id:"sync",label:"同步"},{id:"operations",label:"处理记录"},{id:"settings",label:"设置"}] as const;
  const onTabKey=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const next=event.key==="ArrowRight"?(index+1)%tabs.length:event.key==="ArrowLeft"?(index+tabs.length-1)%tabs.length:event.key==="Home"?0:event.key==="End"?tabs.length-1:null;
    if(next===null)return;event.preventDefault();setTab(tabs[next].id);event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const pageSize=5;
  const openCleanupSettings=()=>{props.onClose();openDidaReadingCleanupSettings();};
  const renderLoginFeedback=()=>login.feedback.phase!=="idle"&&<div className={`collection-dida-login-feedback ${login.feedback.phase}`} role="status" aria-live="polite" aria-label="滴答网页登录验证结果">
    <strong>{({opening:"正在打开登录窗口",waiting:"等待完成登录",checking:"正在核验登录",verified:login.feedback.status?.accountMatched?"登录验证成功":"网页登录通过 · 账号待核验",failed:login.feedback.status?.state==="service-unavailable"?"登录检查暂不可用":"登录尚未通过"})[login.feedback.phase]}</strong>
    <p>{login.feedback.message}</p>
    {login.latestSyncFailure&&login.feedback.phase!=="failed"&&<p className="collection-dida-latest-failure">最近一次阅读同步仍未通过：{login.latestSyncFailure}</p>}
    {login.feedback.phase==="waiting"&&login.feedback.status&&<small>最近一次检查：{login.feedback.status.message}</small>}
    {login.feedback.status?.checkedAt&&<small>检查时间 {timestamp(login.feedback.status.checkedAt)}</small>}
    <button disabled={login.busy} onClick={login.check}>{login.feedback.phase==="waiting"?"我已登录，立即检查":login.busy?"正在检查…":"再次检查登录"}</button>
  </div>;
  const renderOperations=(records:CollectionLibraryOperation[],requestedPage:number,setPage:(value:number)=>void)=>{
    const pages=Math.ceil(records.length/pageSize),page=Math.min(requestedPage,Math.max(0,pages-1));
    return <><div className="collection-operation-list">{records.slice(page*pageSize,(page+1)*pageSize).map((op,index)=><article key={`${op.key}:${op.target}:${op.parked}:${index}`} className={`collection-library-job${op.phase==="cancelled"?" is-history":""}`}>
      <div className="collection-operation-heading"><strong title={operationTitle(op,props.itemTitles)}>{operationTitle(op,props.itemTitles)}</strong><span className={`collection-operation-state ${op.phase}${op.error&&op.phase!=="cancelled"?" is-blocked":""}`}>{operationLabel(op)}</span></div>
      <div className="collection-operation-meta"><span>{op.action==="delete"?"删除清理":"保存副本"} · {op.targetName || op.plan?.libraryName || op.target || "资料库"}</span>{op.updatedAt ? <time dateTime={new Date(op.updatedAt*1000).toISOString()}>{timestamp(op.updatedAt)}</time> : null}</div>
      {(op.error||op.detail)&&<p className="collection-operation-message">{op.error||op.detail}</p>}
      <div className="collection-operation-actions">{op.phase!=="cancelled"&&op.parked?<button onClick={()=>props.onContinueCopy(op)}>继续处理</button>:op.plan&&op.key?<button onClick={()=>props.onReview(op.key!,op.target)}>查看方案</button>:null}
        {!op.parked&&(!!op.error||["failed","cleanup"].includes(op.phase))&&!["unknown","partial","cancelled"].includes(op.phase)&&<button onClick={()=>props.onRetry(op)}>重试</button>}
        <details><summary>记录详情</summary><p>{op.error||op.detail||operationLabel(op)}</p>{op.plan?.destinationPath&&<p>位置：{op.plan.destinationPath}</p>}<small>条目：{op.key || "—"}</small></details>
      </div>
    </article>)}</div>{pages>1&&<nav className="collection-operation-pages" aria-label={records===history?"已取消记录分页":"待处理记录分页"}><button disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {pages}</span><button disabled={page+1>=pages} onClick={()=>setPage(page+1)}>下一页</button></nav>}</>;
  };
  return <div className="collection-sync-popover" role="dialog" aria-label="阅读同步与连接">
    <header className="collection-sync-panel-header"><div><strong>同步与连接</strong><span className="collection-auto-label"><Clock3 size={13}/>{props.autoSyncMinutes?`每 ${props.autoSyncMinutes} 分钟同步`:"仅手动同步"}</span></div><button aria-label="关闭同步管理" onClick={props.onClose}><X size={18}/></button></header>
    <nav className="collection-sync-tabs" role="tablist" aria-label="同步管理页面">{tabs.map((entry,index)=><button key={entry.id} id={`${panelId}-${entry.id}`} role="tab" aria-label={entry.label} aria-controls={`${panelId}-panel`} aria-selected={tab===entry.id} tabIndex={tab===entry.id?0:-1} onKeyDown={event=>onTabKey(event,index)} onClick={()=>setTab(entry.id)}>{entry.label}{entry.id==="operations"&&active.length>0&&<span>{active.length}</span>}</button>)}</nav>
    <div className="collection-sync-panel-body" ref={bodyRef}>
      <div id={`${panelId}-panel`} role="tabpanel" aria-labelledby={`${panelId}-${tab}`}>
      {tab==="sync"&&<>
      {props.jobVisible&&job&&<section className={`collection-progress ${job.outcome}`} aria-label="后台保存进度" aria-live="polite">
        <div><strong>{job.running?(job.phase==="fetching"?`正在读取${sourceName(job.source)}`:"正在保存到本地"):job.outcome==="paused"?"已暂停":"需要重试"}</strong>{job.running?<button onClick={props.onPause}><Pause size={14}/>暂停</button>:<button onClick={()=>job.source?props.onSync(job.source as CollectionSource,false):props.onStore()}>{job.source?"继续同步":"继续保存"}</button>}</div>
        <span>{job.phase==="saving"?`${job.processed} / ${job.total} 条 · ${Math.max(0,job.total-job.processed)} 条未处理`:job.running?"正在分页读取，已导入内容可继续浏览":job.outcome==="paused"?"读取已暂停，已导入内容可继续浏览":"本轮同步未完成，可继续同步"}</span>
        <progress aria-label="内容保存进度" max={job.total||1} value={job.phase==="saving"&&job.total>0?job.processed:undefined}/>
        <small>本轮下载 {mb(job.downloadedBytes)}{job.running&&job.fileBytes>0&&` · 当前附件 ${mb(job.fileBytes)}${job.fileTotal?` / ${mb(job.fileTotal)}`:""}`}</small>
        <details><summary>查看运行详情</summary><p>{job.message}</p></details>
      </section>}
      <section className="collection-sync-log collection-sync-sources" aria-label="同步来源">
        <div className="collection-sync-section-heading"><strong>来源</strong><small>选择要同步的来源</small></div>
        <div className="collection-source-sync" aria-label="立即同步">{sourceOrder.map(id=>{
          const source=sources.find(s=>s.id===id)!;if(!source)return null;
          const cleanup=source.didaCleanup;
          const needsLogin=cleanup?.authRequired&&!login.currentVerified;
          const authReason=cleanup?.reasons.find(reason=>reason.message.includes("网页登录"))?.message || "滴答网页登录未通过，请重新登录";
          return <article key={id} className={`collection-sync-source-card ${id}`}>
            <div className="collection-sync-source-heading"><strong><i/>{sourceName(id)}</strong><span className={`collection-sync-source-state${source.autoBlocked||needsLogin||(id==="dida"&&login.latestSyncFailure)?" warning":""}`}>{props.sourceActive(id)?"同步中":id==="dida"&&login.feedback.phase==="checking"?"检查登录中":needsLogin?"需要检查登录":id==="dida"&&login.currentVerified?login.latestSyncFailure?"网页登录已验证，最近同步未通过":"网页登录已验证":source.autoBlocked?"登录失效":source.connected?"已连接":"未连接"}</span></div>
            <div className="collection-sync-source-meta"><span>{id==="dida"?`Hub 阅读：${source.count} 条`: `${source.count} 条内容`}</span><small>{source.lastSuccess?`上次成功 ${time(source.lastSuccess)}`:source.lastCheckedAt?`最近检查 ${time(source.lastCheckedAt)}`:"尚无成功记录"}</small></div>
            {cleanup&&<div className="collection-dida-cleanup" aria-label="滴答原内容处理">
              <strong>{cleanup.pending>0?`滴答里的原内容：保留 ${cleanup.pending} 条`:"滴答里的原内容：暂无待删除内容"}</strong>
              <span>{cleanup.mode==="cloud-preserve"?"同步后删除：未开启。原内容会继续保留在滴答里。":cleanup.mode==="cloud-verified"?"同步后删除：已开启。正文和全部附件在本机、云端都检查通过后才删除。":"本机确认正文和全部附件保存完整后，才删除滴答里的原内容。"}</span>
              {login.latestSyncFailure&&<p>最近一次同步未通过，请查看下面的登录检查结果。</p>}
              {needsLogin&&login.feedback.phase==="idle"&&<p role="status">{authReason}</p>}
              <button className="collection-dida-cleanup-settings" onClick={openCleanupSettings}>设置同步后删除</button>
            </div>}
            <div className="collection-sync-source-actions"><button aria-label={`立即同步${sourceName(id)}`} disabled={props.sourceBusy(id)||!source.connected} title={props.sourceBusy(id)?"当前来源正在同步或保存":!source.connected?"请先连接此来源":`立即同步${sourceName(id)}`} onClick={()=>props.onSync(id,true)}><RefreshCw size={14}/>{sourceName(id)}</button>{cleanup?.authRequired&&<button className="collection-sync-login" disabled={login.busy} onClick={()=>void login.openLogin()}>重新登录滴答</button>}{source.canResume&&<button disabled={props.sourceBusy(id)||!source.connected} onClick={()=>props.onSync(id,false)}>继续上次</button>}</div>
            {id==="dida"&&renderLoginFeedback()}
            {cleanup&&<>
              {cleanup.reasons.some(reason=>didaRetentionKind(reason)==="quota-exhausted")&&<ReadingLegacyReservation onRetry={()=>props.onSync("dida",false)}/>}
              <DidaReadingResolutions busy={props.sourceBusy("dida")} onRetry={()=>props.onSync("dida",false)} onOpenUrl={props.onOpenUrl} pendingCount={cleanup.pending} preservedCount={cleanup.preserved}/>
              {cleanup.pending>0&&<div className="collection-dida-retained-reasons" aria-label="滴答原内容保留原因">{cleanup.reasons.map(reason=><p key={reason.message}><strong>{reason.count} 条</strong> · {didaRetentionExplanation(reason,cleanup.mode)}</p>)}</div>}
              <details className="collection-dida-attachment-help"><summary>附件是怎么确认的？</summary><p>Hub 会读取任务正文、说明里的附件引用，以及滴答返回的附件列表，再下载并检查文件。</p><p>“没有附件”和“无法读取附件列表”是两种情况。只有滴答明确返回空列表，且正文和说明里没有附件引用，才能确认没有附件；列表没返回时，会补查一次，仍无法确认就保留原内容。</p><p>如果已经读到附件列表，但文件未下载完成、保存失败或云端检查未通过，也会保留原内容。下次同步会继续尝试，不会为了删除原内容跳过附件检查。</p></details>
            </>}
            <details className="collection-source-detail"><summary aria-label={`${sourceName(id)}同步详情`}>{cleanup?"同步详情与技术记录":"同步详情"}</summary>{source.lastCheckedAt&&<small>最近检查 {timestamp(source.lastCheckedAt)}</small>}{source.connected&&!source.autoBlocked&&props.autoSyncMinutes>0&&<small>下次同步 {source.nextSyncAt?time(source.nextSyncAt):"等待下一轮"}</small>}{cleanup&&<><small>上次检查：本机已确认保存完整 {cleanup.verified} 条 · 之前已从滴答删除 {cleanup.deleted} 条</small><details className="collection-source-technical"><summary>技术记录</summary><p>{source.status||"还没有同步记录"}</p>{cleanup.reasons.map(reason=><p key={reason.message}>{reason.count} 条 · {reason.message}</p>)}</details></>}{!cleanup&&<p>{source.status||"还没有同步记录"}</p>}</details>
          </article>;
        })}</div>
      </section>
      {!!props.pendingCancellations&&<p className="collection-sync-inline-note">待取消 {props.pendingCancellations} 条 · 下次定时或手动同步时处理</p>}
      {sources.find(s=>s.id==="telegram")?.pairingUrl&&<div className="collection-pairing"><span>Telegram 已连接，确认你的账号后开始收集。</span><button onClick={()=>props.onOpenUrl(sources.find(s=>s.id==="telegram")!.pairingUrl!)}>打开机器人确认</button></div>}
      </>}
      {tab==="operations"&&<section className="collection-sync-operations" aria-label="资料库处理记录"><div className="collection-sync-section-heading"><strong>资料库处理记录</strong><small>{active.length} 项待处理</small></div>{active.length?renderOperations(active,activePage,setActivePage):<p className="collection-sync-inline-note">暂无待处理的资料库副本。</p>}{!!history.length&&<details className="collection-operation-history"><summary>已取消记录 <span>{history.length}</span></summary><p className="collection-sync-inline-note">已写入的副本和附件保留；取消后不再自动补齐。</p>{renderOperations(history,historyPage,setHistoryPage)}</details>}</section>}
      {tab==="settings"&&<div className="collection-sync-advanced-content"><button className="collection-storage-settings" aria-label="保存位置与同步频率" onClick={props.onSettings}><Settings2 size={16}/><span>保存位置与同步频率</span></button><p className="collection-sync-inline-note">{props.storageLabel}</p>
        <details className="collection-sync-connections"><summary>连接管理</summary>{sources.map(source=><div key={source.id}><strong>{sourceName(source.id)}</strong>{source.id==="dida"?<><small>{source.connected?"已连接滴答资料库；网页登录状态可单独检查":"请在设置的资料库中连接滴答清单"}</small>{source.connected&&<><button disabled={login.busy} onClick={login.check}>检查滴答网页登录</button><button disabled={login.busy} onClick={()=>void login.openLogin()}>打开滴答登录窗口</button>{renderLoginFeedback()}</>}</>:<button disabled={props.sourceBusy(source.id)} onClick={()=>props.onConnect(source.id)}><Link2 size={13}/>{source.connected?"更新连接":source.id==="telegram"?"连接 Telegram":"连接 X"}</button>}{source.id==="telegram"&&source.pairingUrl&&<button onClick={()=>props.onOpenUrl(source.pairingUrl!)}>打开机器人确认</button>}</div>)}</details>
        {props.children}
        <details className="collection-storage-log"><summary>{job?.outcome==="completed"&&!props.jobRunning?"最近保存结果":"上次保存记录"}</summary><p>{job?.outcome==="completed"&&!props.jobRunning?job.message:props.storageStatus||"暂无保存记录"}</p></details>
        <div className="collection-sync-repair"><div><strong>补写本地内容与附件</strong><small>对已导入内容补写或重试。</small></div><button disabled={props.jobRunning} onClick={props.onStore}>补写 / 重试</button></div>
      </div>}
      </div>
    </div>
  </div>;
}
