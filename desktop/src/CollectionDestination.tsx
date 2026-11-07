import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, LoaderCircle, CircleAlert, Clock3 } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import { publishCodexNotice } from "./CodexSuite";
import type { LibrarySummary } from "./SearchTypes";
import "./CollectionDestination.css";

export type CollectionLibraryOperation = { key?: string; itemTitle?: string; targetName?: string; updatedAt?: number; parked?: boolean; action: string; target: string; phase: string; error: string; detail?: string; attachmentLoginRequired?: boolean; plan?: ConversionPlan };
export type ConversionPlan = {
  provider?: string; status: string; summary: string; reason: string; libraryName: string; destinationPath: string;
  title: string; markdown: string; warnings: string[];
  tasks: {kind?:"action"|"reference";title:string;projectName?:string;content:string;evidence:string;completion:string;checklist:string[]}[];
  attachments: {name:string;bytes:number;readStatus:string;mime?:string}[];
};
export function CollectionLibraryBadge({library}:{library?:LibrarySummary}) {
  return library ? <span className="collection-library-badge"><LibraryIcon provider={library.provider} name={library.name} iconSvg={library.iconSvg} defaultIconUrl={library.defaultIconUrl} compact/><span>{library.name}</span></span> : null;
}
export type CollectionStorageLocation = {kind:string;name:string;path?:string;libraryId?:string;isDefault?:boolean;target?:string;copyState?:string};
const normalizedPath = (path:string) => path.replace(/\\/g,"/").replace(/^\/\/\?\//,"").replace(/\/+$/,"").toLocaleLowerCase();
function defaultLocation(libraries:LibrarySummary[],config?:{mode:string;vaultPath:string}):CollectionStorageLocation {
  if(config?.mode!=="obsidian") return {kind:"hub",name:"Hub 本地数据库",isDefault:true};
  const path=config.vaultPath;
  const library=libraries.find(l=>l.provider==="obsidian"&&normalizedPath(l.location||"")===normalizedPath(path));
  return {kind:"obsidian",name:library?.name||path.replace(/[\\/]+$/,"").split(/[\\/]/).pop()||"Obsidian",path,libraryId:library?.id,isDefault:true};
}
function locationLabel(location:CollectionStorageLocation) {
  return location.kind==="obsidian"&&!location.libraryId?`Obsidian / ${location.name}`:location.name;
}
export function CollectionDestination({libraries,destinationId,storageLocation,storageLocations,defaultConfig,operation,disabled,onChange,onRemove,onReview}:{libraries:LibrarySummary[];destinationId?:string;storageLocation?:CollectionStorageLocation;storageLocations?:CollectionStorageLocation[];defaultConfig?:{mode:string;vaultPath:string};operation?:CollectionLibraryOperation|null;disabled:boolean;onChange:(id:string)=>void;onRemove?:(id:string)=>void;onReview:()=>void}){
  const [open,setOpen]=useState(false);const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};const blur=()=>setOpen(false);document.addEventListener("pointerdown",close);window.addEventListener("blur",blur);return()=>{document.removeEventListener("pointerdown",close);window.removeEventListener("blur",blur);};},[open]);
  const fallback=defaultLocation(libraries,defaultConfig);
  const selectedLibrary=libraries.find(l=>l.id===destinationId);
  const current=storageLocation||(selectedLibrary?{kind:selectedLibrary.provider,name:selectedLibrary.name,path:selectedLibrary.location,libraryId:selectedLibrary.id}:fallback);
  const defaultLibrary=libraries.find(l=>l.id===fallback.libraryId);
  const copies=storageLocations?.length?storageLocations:[current];
  const chosen=(id:string)=>copies.find(l=>(l.libraryId===id||l.target===id)&&!l.isDefault);
  const choose=(id:string)=>{
    const copy=chosen(id);
    if(copy) onRemove?.(copy.target||id);
    else onChange(id);
  };
  const unavailableCopies=copies.filter(copy=>!copy.isDefault&&!!(copy.target||copy.libraryId)&&!libraries.some(l=>l.id===copy.libraryId||l.id===copy.target));
  return <div ref={root} className="collection-destination-row" onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setOpen(false);}} onKeyDown={e=>{if(e.key==="Escape")setOpen(false);}}><dt>保存到</dt><dd>
    <button className="collection-destination-trigger" aria-label="选择保存资料库" title={current.path||locationLabel(current)} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(!open)}>{copies.map((location,i)=>{const lib=libraries.find(l=>l.id===location.libraryId);return <span key={location.libraryId||i}>{lib?<CollectionLibraryBadge library={lib}/>:<span className="collection-property-empty">{locationLabel(location)}</span>}{location.copyState==="running"&&<LoaderCircle size={10} className="spin"/>}{location.copyState==="queued"&&<Clock3 size={10} aria-label="等待保存"/>}{location.copyState==="blocked"&&<CircleAlert size={12} aria-label="需要处理"/>}</span>;})}<ChevronDown size={12}/></button>
    {open&&<div className="collection-property-menu collection-destination-menu" role="listbox" aria-label="保存资料库" aria-multiselectable="true">
      <small>可选择多个资料库；再次点击取消选择</small>
      <button role="option" aria-label="默认保存位置" aria-selected={true} disabled title={fallback.path}>
        <span>本地默认：{defaultLibrary?<CollectionLibraryBadge library={defaultLibrary}/>:locationLabel(fallback)}</span><Check size={14}/>
      </button>
      {libraries.filter(l=>["obsidian","craft","dida365"].includes(l.provider)&&l.id!==fallback.libraryId&&!(l.provider==="obsidian"&&fallback.kind==="obsidian"&&normalizedPath(l.location||"")===normalizedPath(fallback.path||""))).map(l=><button key={l.id} role="option" aria-selected={!!chosen(l.id)} disabled={disabled||(chosen(l.id)?!onRemove:!l.connected)} title={chosen(l.id)?"取消选择，已保存的副本和附件保留":!l.connected?"请先连接或检查资料库路径":undefined} onClick={()=>choose(l.id)}><CollectionLibraryBadge library={l}/>{chosen(l.id)&&<Check size={14}/>}</button>)}
      {unavailableCopies.map((copy,index)=><button key={copy.target||copy.libraryId||index} role="option" aria-selected={true} disabled={disabled||!onRemove} title="取消选择，已保存的副本和附件保留" onClick={()=>onRemove?.(copy.target||copy.libraryId!)}><span>{copy.name||"未连接的资料库"}</span><Check size={14}/></button>)}
      <small>默认本地页面和附件始终保留。取消选择不删除已保存的副本。Craft 超过 5 MB 的附件不上传。</small>
    </div>}
    {operation&&(!!operation.error||!["queued","ready","planning","saving","writing","cleanup"].includes(operation.phase))&&<div className="collection-destination-operation"><button onClick={onReview}>{operation.phase==="cancelled"?"查看已取消记录":operation.phase==="needs_review"?"查看处理方案":"查看处理记录"}</button></div>}
  </dd></div>;
}
export function CollectionConversionPreview({operation,busy,error,onApprove,onCancel,onClose,onAttachmentLogin,onRegenerate,onResolve,onResume}:{operation:CollectionLibraryOperation;busy:boolean;error?:string;onApprove:()=>void;onCancel:()=>void;onClose:()=>void;onAttachmentLogin:()=>void;onRegenerate:(goal:string)=>void;onResolve:(id:string)=>void;onResume?:()=>void}){
  const [goal,setGoal]=useState("");const [remoteId,setRemoteId]=useState("");
  const dialog=useRef<HTMLDialogElement>(null);useEffect(()=>{dialog.current?.showModal();},[]);const plan=operation.plan;const reference=plan?.provider==="dida365"&&plan.tasks?.length===1&&plan.tasks[0].kind==="reference";const running=!operation.error&&["queued","ready","planning","saving","writing","cleanup"].includes(operation.phase);const cancelled=operation.phase==="cancelled";
  const statusMessage=error||operation.error||(running?operation.detail:"");
  useEffect(()=>{const message=error||operation.error;if(message)publishCodexNotice(message,cancelled&&!error?"warning":"error",0);},[error,operation.error,cancelled]);
  return <dialog ref={dialog} className="collections-dialog collection-conversion-dialog" onCancel={e=>{if(busy)e.preventDefault();else onClose();}} onClose={onClose}><header><h2>{cancelled?"已取消的保存记录":reference?"保存为滴答笔记":plan?.tasks?.length?"转换为任务":"保存方案"}</h2><button disabled={busy} aria-label="关闭处理方案" onClick={onClose}>×</button></header>
    {plan&&<><p><strong>{plan.libraryName}</strong> · {plan.destinationPath}</p><p>{plan.summary}</p><p className="collections-note">{plan.reason}</p>{plan.title&&<h3>{plan.title}</h3>}{plan.markdown&&<pre className="collection-conversion-content">{plan.markdown}</pre>}{plan.tasks?.map((task,i)=><section className="collection-task-plan" key={i}><h3>{task.title}</h3>{task.projectName&&<small>清单：{task.projectName}</small>}<pre className="collection-conversion-content">{task.content}</pre>{task.kind!=="reference"&&<><p>完成标准：{task.completion}</p><small>依据：{task.evidence}</small></>}{!!task.checklist?.length&&<ul>{task.checklist.map((step,n)=><li key={n}>{step}</li>)}</ul>}</section>)}{!!plan.attachments?.length&&<section><strong>附件</strong><ul>{plan.attachments.map((a,i)=><li key={i}>{a.name} · {(a.bytes/1_000_000).toFixed(1)} MB{plan.provider==="craft"&&a.bytes>5_000_000?" · 超过 5 MB，跳过上传并保留原链接":a.readStatus==="upload_only"||a.mime?.startsWith("video/")||/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(a.name)?" · 原视频，随正文保存":!["read","image"].includes(a.readStatus)&&" · 尚未识别正文"}</li>)}</ul></section>}{plan.warnings?.map((warning,i)=><p className="collections-note" key={i}>{warning}</p>)}</>}
    {!operation.parked&&(operation.phase==="unknown"?<label>核对目标资料库后，填写实际创建的页面或任务 ID<input aria-label="实际页面或任务 ID" value={remoteId} onChange={e=>setRemoteId(e.target.value)} disabled={busy}/><button disabled={busy||!remoteId.trim()} onClick={()=>onResolve(remoteId.trim())}>核对并关联已有内容</button></label>:!reference&&operation.phase==="needs_review"&&<label>补充目标或修改归档要求<textarea aria-label="补充处理目标" value={goal} onChange={e=>setGoal(e.target.value)} maxLength={2000} disabled={busy}/><button disabled={busy} onClick={()=>onRegenerate(goal)}>重新生成方案</button></label>)}
    {!cancelled&&operation.attachmentLoginRequired&&<><p className="collections-note">正文使用已授权的滴答连接；附件使用同一账号的网页登录会话。已有会话会自动复用，无需另建附件账号。</p><button disabled={busy} onClick={onAttachmentLogin}>检查滴答网页登录</button></>}
    <footer>{statusMessage&&<div className={`collection-conversion-status ${cancelled?"warning":error||operation.error?"error":"working"}`} role={cancelled||(!error&&!operation.error)?"status":"alert"} aria-live="polite">{statusMessage}</div>}<div className="collection-conversion-actions">{operation.parked?<><button onClick={onClose}>关闭记录</button><button className="collections-primary" disabled={busy||!onResume} onClick={onResume}>{busy?"正在恢复…":"恢复此库处理"}</button></>:<>{cancelled?<button onClick={onClose}>关闭记录</button>:<button disabled={busy||running||operation.phase==="unknown"} onClick={onCancel}>取消方案</button>}{plan?.status==="planned"&&(operation.phase==="partial"||(!reference&&operation.phase==="needs_review"))&&<button className="collections-primary" disabled={busy} onClick={onApprove}>{busy?"正在写入…":operation.phase==="partial"?"继续补齐":"按方案保存副本"}</button>}</>}</div></footer>
  </dialog>;
}
