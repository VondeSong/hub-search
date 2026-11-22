import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Brain, Check, ChevronRight, Plus, ShieldCheck, X } from "lucide-react";
import type { AssistantOptions } from "./AgentAssistantOptions";
import { useAgentPopover } from "./useAgentPopover";
import { readMemoryHistory, type MemoryContent, type MemoryEntry, type MemoryKind, type MemoryProposal, type MemoryUse, type MemoryVersion, type SharedMemoryModel } from "./useSharedMemory";
import "./SharedMemory.css";

const usageLabel = (kind: string) => kind === "rule" ? "每次使用" : "相关时参考";
const labels: Record<string,string> = {pending:"等待核验", inactive:"已停用", review:"待重新确认", deleting:"清理未完成"};
const date = (time?:number) => time ? new Date(time).toLocaleString("zh-CN",{dateStyle:"short",timeStyle:"short"}) : "";

export function wrapDialogTab(event:React.KeyboardEvent<HTMLElement>) {
  if(event.key!=="Tab")return;
  const fields=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary')).filter(item=>item.getClientRects().length>0);
  if(!fields.length)return;
  const first=fields[0],last=fields[fields.length-1];
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
}

export function MemoryToolbarButton({model,materialsOnly}:{model:SharedMemoryModel;materialsOnly:boolean}) {
  const enabled=!model.scopePending&&model.selection.enabled&&!materialsOnly;
  const label=model.scopePending&&!materialsOnly?"记忆":enabled?model.projectLabel(model.selection.projectId):"记忆关";
  return <button type="button" className="agent-memory-toolbar" data-enabled={enabled} aria-label="记忆与保存"
    aria-description={model.scopePending?"尚未读取记忆范围":enabled?`记忆范围：${label}`:"本轮记忆关闭"} aria-haspopup="dialog" title={enabled?`记忆：${label}`:label}
    onClick={event=>model.openManager(event.currentTarget)}>
    <span className="agent-memory-toolbar-icon"><Brain size={14} aria-hidden="true"/></span>
    <span className="agent-memory-toolbar-label">{label}</span>
  </button>;
}

function MemoryStatus({model, showNotice=true}: {model:SharedMemoryModel;showNotice?:boolean}) {
  if (model.error) return <div className="agent-memory-feedback" role="alert"><span>{model.error}</span><button type="button" disabled={model.busy} onClick={()=>void model.retryRead()}>重试读取</button></div>;
  if (model.busy || model.loading || showNotice && model.notice) return <p className="agent-memory-feedback" role="status" tabIndex={-1}>{model.busy?"正在更新记忆…":model.loading?"正在读取记忆设置…":model.notice}</p>;
  return null;
}

function ManageLink({model,onClick}: {model:SharedMemoryModel;onClick:()=>void}) {
  const pending = model.view?.proposals?.length ?? 0;
  return <button type="button" className="agent-memory-manage-link" onClick={onClick}>
    <span>管理记忆{pending>0 && <small>此范围 {pending} 条待确认</small>}</span><ChevronRight size={15} aria-hidden="true"/>
  </button>;
}

export function MemoryAndSavePopover({model,value,canAuto,materialsOnly,disabled,onSave,inManager=false}: {
  model:SharedMemoryModel;value:AssistantOptions;canAuto:boolean;materialsOnly:boolean;disabled:boolean;onSave:(value:AssistantOptions)=>Promise<void>;inManager?:boolean;
}) {
  const popover=useAgentPopover({aboveComposer:true});
  const trigger=useRef<HTMLElement|null>(null);
  const closeButton=useRef<HTMLButtonElement>(null);
  const [auto,setAuto]=useState(value.autoFlashcardInbox);
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState("");
  const options=model.view?.projects ?? [];
  const unavailable = model.view && !model.view.configured;
  const canSwitch = !disabled && !model.blocked && !model.loading && !!model.view && !materialsOnly;
  const activeProject = model.selection.projectId;
  async function commit() {
    if (saving || disabled) return;
    setSaving(true); setSaveError("");
    try { await onSave({...value,autoFlashcardInbox:auto}); popover.close(true); }
    catch(reason) { setSaveError(String(reason)); }
    finally { setSaving(false); }
  }
  return <details ref={popover.ref} className={inManager?"agent-memory-inline-settings":"agent-assistant-options agent-popover agent-memory-disclosure"} data-hub-keyboard-scope="memory-settings" onToggle={event=>{
    if(event.target!==event.currentTarget)return;
    const open=event.currentTarget.open;
    model.setSettingsOpen(open);
    if(open){setAuto(value.autoFlashcardInbox);setSaveError("");closeButton.current?.focus({preventScroll:true});}
  }}>
    {inManager?<summary ref={trigger}>记忆与保存设置</summary>:<summary ref={trigger} className="agent-memory-trigger" data-memory-enabled={model.selection.enabled&&!materialsOnly} aria-label="记忆与保存" title="记忆与保存">
      <ShieldCheck size={18} aria-hidden="true"/><span className="agent-memory-trigger-full">{model.selection.enabled&&!materialsOnly ? model.projectLabel(activeProject) : "记忆与保存"}</span><span className="agent-memory-trigger-short">记忆</span>
    </summary>}
    <section className="agent-assistant-settings agent-memory-permissions" role={inManager?undefined:"dialog"} aria-modal={inManager?undefined:true} aria-label="记忆与保存" onKeyDown={inManager?undefined:wrapDialogTab}>
      {!inManager&&<header className="agent-popover-header"><strong>记忆与保存</strong><button ref={closeButton} type="button" aria-label="关闭记忆与保存" onClick={()=>popover.close(true)}><X size={16}/></button></header>}
      <div className="agent-memory-permissions-body">
      <section className="agent-memory-settings-section" aria-label="记忆">
        <h3>记忆</h3>
        <label className="agent-memory-switch"><span>使用已保存记忆</span><input type="checkbox" role="switch" checked={model.selection.enabled&&!materialsOnly} disabled={!canSwitch} onChange={event=>model.select({...model.selection,enabled:event.target.checked})}/></label>
        <label className="agent-memory-scope-setting"><span>范围</span><select aria-label="本对话的记忆范围" value={activeProject} disabled={!canSwitch} onChange={event=>model.select({...model.selection,projectId:event.target.value})}>
          <option value="">个人通用</option>
          {activeProject && !options.some(p=>p.id===activeProject) && <option value={activeProject}>{model.view?"原项目不可用":"正在读取项目"}</option>}
          {options.map(project=><option key={project.id} value={project.id}>{project.name}＋个人通用</option>)}
        </select></label>
        <p>{materialsOnly?"当前只用所选资料，本轮不使用记忆。":disabled?"回答结束后可更改。":unavailable && model.selection.enabled?"本地记忆暂时不可用，请在「管理记忆」中准备或检查。":model.selection.enabled?"新增记忆仍需确认。":"开启后使用此范围。新增记忆仍需确认。"}</p>
        <MemoryStatus model={model}/>
      </section>
      <section className="agent-memory-saving" aria-label="保存成果">
        <h3>保存成果</h3>
        {canAuto || value.autoFlashcardInbox ? <>
          <button type="button" className="agent-menu-choice" aria-pressed={!auto} disabled={disabled||saving} onClick={()=>setAuto(false)}><span><strong>保存前确认</strong><small>先查看草稿，再确认保存。</small></span>{!auto&&<Check size={16}/>}</button>
          {canAuto&&<button type="button" className="agent-menu-choice" aria-pressed={auto} disabled={disabled||saving} onClick={()=>setAuto(true)}><span><strong>自动导入闪卡收件箱</strong><small>仅限本对话，仍需审核后才能复习。</small></span>{auto&&<Check size={16}/>}</button>}
          {auto!==value.autoFlashcardInbox&&<button type="button" className="agent-memory-auto-confirm" disabled={disabled||saving} onClick={()=>void commit()}>{saving?"正在应用…":auto?"确认本对话的自动导入授权":"应用到本对话"}</button>}
        </> : <><div className="agent-memory-save-status"><span>保存前确认</span><Check size={16} aria-hidden="true"/></div><p>先查看草稿，再确认保存。</p></>}
        {saveError&&<p role="alert">{saveError}</p>}
      </section>
      </div>
      {!inManager&&<footer className="agent-memory-permissions-footer"><ManageLink model={model} onClick={()=>{popover.close();if(trigger.current) model.openManager(trigger.current);}}/></footer>}
    </section>
  </details>;
}

function MemoryEditor({initial,scope,projects,onCancel,onSave,action,disabled,fixed}: {
  initial:MemoryContent;scope:string;projects:{id:string;name:string}[];onCancel:()=>void;onSave:(content:MemoryContent,scope:string)=>Promise<boolean>;
  action:string;disabled:boolean;fixed:boolean;
}) {
  const [draft,setDraft]=useState(initial);
  const [project,setProject]=useState(scope);
  const field=useRef<HTMLTextAreaElement>(null);
  const saving=useRef(false);
  useEffect(()=>{field.current?.focus({preventScroll:true});},[]);
  async function submit(event:FormEvent) {
    event.preventDefault();
    if(disabled || saving.current || !draft.title.trim() || !draft.body.trim())return;
    saving.current=true;
    try { if(await onSave({...draft,title:draft.title.trim(),body:draft.body.trim()},project)) onCancel(); }
    finally { saving.current=false; }
  }
  return <form className="agent-memory-editor" onSubmit={event=>void submit(event)} onKeyDown={event=>{
    if(event.key==="Escape"&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();if(!disabled)onCancel();}
  }}>
    <label>标题<input required maxLength={90} disabled={disabled} value={draft.title} onChange={event=>setDraft({...draft,title:event.target.value})}/></label>
    <label>记忆内容<textarea ref={field} rows={3} required maxLength={1800} disabled={disabled} value={draft.body} onChange={event=>setDraft({...draft,body:event.target.value})}/></label>
    <label>使用方式<select disabled={disabled} value={draft.kind} onChange={event=>setDraft({...draft,kind:event.target.value as MemoryKind})}><option value="decision">相关时参考</option><option value="rule">每次使用</option></select></label>
    {fixed ? <p>保存到：{projects.find(item=>item.id===project)?.name || (project?"原记忆项目":"个人通用")}</p> :
      <label>保存到<select disabled={disabled} value={project} onChange={event=>setProject(event.target.value)}><option value="">个人通用</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    <div className="agent-memory-actions"><button type="submit" className="agent-memory-primary" disabled={disabled||!draft.title.trim()||!draft.body.trim()}>{action}</button><button type="button" disabled={disabled} onClick={onCancel}>取消</button></div>
  </form>;
}

export function MemoryProposalCard({model,item,editing,onEdit,onCancel,onResult}: {
  model:SharedMemoryModel;item:MemoryProposal;editing:boolean;onEdit:()=>void;onCancel:()=>void;onResult?:(message:string)=>void;
}) {
  const editButton=useRef<HTMLButtonElement>(null);
  const cancel=()=>{onCancel();requestAnimationFrame(()=>editButton.current?.focus({preventScroll:true}));};
  const scope=item.projectName||model.projectLabel(item.projectId);
  const save=async ({title,body,kind}:MemoryContent)=>{
    const message="已记住 · "+scope;
    const ok=await model.save({title,body,kind},{projectId:item.projectId,topicKey:item.candidate.topicKey,expectedVersion:item.expectedVersion,proposalId:item.id},message);
    if(ok)onResult?.(message);
    return ok;
  };
  const dismiss=async()=>{
    const message="已忽略这条建议";
    if(await model.perform({action:"dismissProposal",proposalId:item.id},message))onResult?.(message);
  };
  return <section className="agent-memory-proposal" aria-label="建议记住">
    <div className="agent-memory-eyebrow"><Brain size={13} aria-hidden="true"/><span>建议记住</span></div>
    {editing ? <MemoryEditor initial={item.candidate} fixed scope={item.projectId} projects={item.projectId?[{id:item.projectId,name:scope}]:[]} disabled={model.blocked} action="确认并记住" onSave={save} onCancel={cancel}/> : <>
      <p className="agent-memory-content">{item.candidate.body}</p>
      <p className="agent-memory-meta">保存到 {scope} · {usageLabel(item.candidate.kind)}</p>
      <p className="agent-memory-source">{item.candidate.reason}</p>
      <details className="agent-memory-origin"><summary>查看建议来源</summary><p>{item.source.proposedBy||"助手"} · {date(item.source.proposedAt)}{item.source.sourceRecordId&&" · 消息 "+item.source.sourceRecordId}</p></details>
      <div className="agent-memory-actions">
        <button type="button" className="agent-memory-primary" disabled={model.blocked} onClick={()=>void save(item.candidate)}>记住</button>
        <button ref={editButton} type="button" disabled={model.blocked} onClick={onEdit}>编辑</button>
        <button type="button" disabled={model.blocked} onClick={()=>void dismiss()}>忽略</button>
      </div>
    </>}
    {onResult && <MemoryStatus model={model} showNotice={false}/>}
  </section>;
}

function changedMemoryText(before:string,after:string) {
  const split=(text:string)=>text.match(/[^。！？\n]+[。！？]?|[。！？\n]/g)??[];
  const old=split(before),next=split(after);
  let start=0,oldEnd=old.length,nextEnd=next.length;
  while(start<oldEnd&&start<nextEnd&&old[start]===next[start])start++;
  while(oldEnd>start&&nextEnd>start&&old[oldEnd-1]===next[nextEnd-1]){oldEnd--;nextEnd--;}
  return {before:old.slice(start,oldEnd).join("").trim(),after:next.slice(start,nextEnd).join("").trim()};
}

function VersionBody({item,previous,includeKind=true}: {item:MemoryVersion;previous:boolean;includeKind?:boolean}) {
  return <div data-version-side={previous?"before":"after"}>
    <span className="agent-memory-version-sign" aria-hidden="true">{previous?"−":"+"}</span>
    <small>{previous?"修改前":"修改后"} · 第 {item.version} 版{includeKind&&item.kind&&" · "+usageLabel(item.kind)}</small>{item.title&&<strong>{item.title}</strong>}
    {item.body!==""&&<p>{item.body??"此版本的正文不可核验"}</p>}</div>;
}

function MemoryHistory({entry}: {entry:MemoryEntry}) {
  const [versions,setVersions]=useState<MemoryVersion[]|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function load() {
    setError("");setLoading(true);
    try {const data=await readMemoryHistory(entry.id);if(alive.current)setVersions(data.versions);}
    catch(reason){if(alive.current)setError(String(reason));}
    finally{if(alive.current)setLoading(false);}
  }
  return <details className="agent-memory-history" onToggle={event=>{if(event.target===event.currentTarget&&event.currentTarget.open&&!versions&&!loading)void load();}}>
    <summary><ChevronRight size={14} aria-hidden="true"/><span>版本变更对比{entry.updatedAt?`（${date(entry.updatedAt)}）`:""}</span></summary>
    {loading&&<p role="status">正在读取修改记录…</p>}
    {error&&<p role="alert">{error} <button type="button" onClick={()=>void load()}>重试</button></p>}
    {versions&&<ol>{versions.slice(0,-1).map((after,index)=>{
      const before=versions[index+1];
      const verifiedBodies=before.body!==null&&after.body!==null;
      const changes=verifiedBodies?changedMemoryText(before.body??"",after.body??""):null;
      const titleChanged=before.title!==after.title;
      const kindChanged=before.kind!==after.kind;
      return <li key={after.version}><time>{date(after.source?.confirmedAt)} {after.source?.changeReason}</time>
        {changes&&(changes.before||changes.after||titleChanged||kindChanged)?<div className="agent-memory-version-pair">
          {(changes.before||titleChanged||kindChanged)&&<VersionBody previous includeKind={kindChanged} item={{...before,title:titleChanged?before.title:null,body:changes.before}}/>}
          {(changes.after||titleChanged||kindChanged)&&<VersionBody previous={false} includeKind={kindChanged} item={{...after,title:titleChanged?after.title:null,body:changes.after}}/>}
        </div>:<p className="agent-note">{verifiedBodies?"正文与标题无变化。":"部分版本正文暂不可核验。"}</p>}
        <details className="agent-memory-versions-full"><summary>完整版本</summary><div className="agent-memory-version-pair">
          <VersionBody previous item={before}/><VersionBody previous={false} item={after}/>
        </div></details>
      </li>;
    })}</ol>}
    {versions?.length===21&&<p>显示最近 20 次修改。</p>}
  </details>;
}

function EntryCard({model,entry,editing,onEdit,onCancel}: {
  model:SharedMemoryModel;entry:MemoryEntry;editing:boolean;onEdit:()=>void;onCancel:()=>void;
}) {
  const [forgetting,setForgetting]=useState(false);
  const editButton=useRef<HTMLButtonElement>(null);
  const cancelButton=useRef<HTMLButtonElement>(null);
  const forgetButton=useRef<HTMLButtonElement>(null);
  const action=entry.state==="inactive"||entry.state==="review"?"重新确认":"保存修改";
  const identity={id:entry.id,expectedVersion:entry.version};
  const cancel=()=>{onCancel();requestAnimationFrame(()=>editButton.current?.focus({preventScroll:true}));};
  useEffect(()=>{if(forgetting)cancelButton.current?.focus({preventScroll:true});},[forgetting]);
  return <article className="agent-memory-entry" data-memory-state={entry.state}>
    <header className="agent-memory-entry-heading"><strong>{entry.title}</strong>
      <span>{labels[entry.state]&&<small>{labels[entry.state]}</small>}<small className="agent-memory-version-badge">第 {entry.version} 版</small></span>
    </header>
    <div className="agent-memory-entry-body">
      {editing ? <MemoryEditor key={entry.id} initial={{title:entry.title,body:entry.body??"",kind:entry.kind}} scope={entry.projectId} fixed projects={model.view?.projects??[]} action={action} disabled={model.blocked}
        onCancel={cancel} onSave={content=>model.save(content,{projectId:entry.projectId,topicKey:entry.topicKey,expectedVersion:entry.version},"已保存新版本")}/> : <>
        <p className="agent-memory-content">{entry.body??entry.detail??"正文暂不可用"}</p>
        {(entry.history?.length??0)>1&&entry.state!=="deleting"&&<MemoryHistory key={entry.version} entry={entry}/>}
        <footer className="agent-memory-entry-footer">
          <details className="agent-memory-origin">
            <summary>查看来源</summary>
            <dl>
              <div><dt>确认</dt><dd>{entry.source?.origin==="modelProposal"?"模型建议，经用户确认":entry.source?"用户确认":"暂无来源记录"}</dd></div>
              <div><dt>使用方式</dt><dd>{model.projectLabel(entry.projectId)} · {usageLabel(entry.kind)}</dd></div>
              {entry.updatedAt&&<div><dt>更新时间</dt><dd>{date(entry.updatedAt)}</dd></div>}
              {entry.source?.workId&&<div><dt>事项</dt><dd>{entry.source.workId}</dd></div>}
              {entry.source?.sourceRecordId&&<div><dt>消息</dt><dd>{entry.source.sourceRecordId}</dd></div>}
            </dl>
          </details>
        {forgetting ? <div className="agent-memory-forget" onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();setForgetting(false);requestAnimationFrame(()=>forgetButton.current?.focus());}}}>
          <p>遗忘这条记忆及其历史正文？清理后无法从这里恢复，已有备份仍保留。</p>
          <div className="agent-memory-actions"><button type="button" className="agent-memory-danger" disabled={model.blocked} onClick={()=>void model.perform({action:"forget",...identity,confirmed:true},"已遗忘这条记忆").then(()=>setForgetting(false))}>确认遗忘</button><button ref={cancelButton} type="button" onClick={()=>{setForgetting(false);requestAnimationFrame(()=>forgetButton.current?.focus());}}>取消</button></div>
        </div> : <div className="agent-memory-actions">
          {["active","inactive","review"].includes(entry.state)&&<button ref={editButton} type="button" disabled={model.blocked} onClick={onEdit}>{action==="保存修改"?"编辑":action}</button>}
          {entry.state==="active"&&<button type="button" disabled={model.blocked} onClick={()=>void model.perform({action:"deactivate",...identity},"已停用这条记忆")}>停用</button>}
          {entry.state==="pending"&&<button type="button" disabled={model.blocked} onClick={()=>void model.perform({action:"retry",id:entry.id},"已完成索引核验")}>重试核验</button>}
          <button className="agent-memory-forget-trigger" ref={forgetButton} type="button" disabled={model.blocked} onClick={()=>setForgetting(true)}>{entry.state==="deleting"?"重试遗忘":"遗忘"}</button>
        </div>}
        </footer>
      </>}
    </div>
  </article>;
}

function Audit({usage,model}: {usage:MemoryUse;model:SharedMemoryModel}) {
  return <details className="agent-memory-origin"><summary>本轮提供 {usage.items.length} 条记忆</summary>
    <ul>{usage.items.map(item=><li key={item.id}>{model.view?.entries.find(entry=>entry.id===item.id)?.title??item.id} · 第 {item.version} 版 · {usageLabel(item.kind)}</li>)}</ul>
    {usage.omissions&&<p>检索未选中 {usage.omissions.notRetrieved} 条；受容量限制未提供 {usage.omissions.budget} 条。</p>}
    {usage.notice&&<p>{usage.notice}</p>}{!!usage.items.length&&<p>是否采纳可结合回答核对。</p>}
  </details>;
}

export function MemoryManager({model,materialsOnly,usage,onBack,onClose=model.closeManager,settings,centered=false}: {
  model:SharedMemoryModel;materialsOnly:boolean;usage?:MemoryUse|null;onBack?:()=>void;onClose?:()=>void;settings?:React.ReactNode;centered?:boolean;
}) {
  const scopeId=useId();
  const [tab,setTab]=useState<"saved"|"pending">("saved");
  const [editing,setEditing]=useState<{id:string,entry?:MemoryEntry}|null>(null);
  const [utility,setUtility]=useState(false);
  const [query,setQuery]=useState("");
  const [projectName,setProjectName]=useState("");
  const [inactive,setInactive]=useState(false);
  const dialog=useRef<HTMLElement>(null);
  const closeButton=useRef<HTMLButtonElement>(null);
  const projects=model.view?.projects??[];
  const loaded=model.view?.entries??[];
  const entries=loaded.filter(item=>item.projectId===model.browseScope && (!inactive||item.state==="inactive") &&
    (!query.trim()||(item.title+" "+(item.body??"")).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const proposals=(model.browseProposals??[]).filter(item=>!query.trim()||(item.candidate.title+" "+item.candidate.body).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  useEffect(()=>{closeButton.current?.focus({preventScroll:true});},[]);
  useEffect(()=>{
    if (model.notice && !model.busy && !editing && !dialog.current?.contains(document.activeElement)) {
      dialog.current?.querySelector<HTMLElement>(".agent-memory-feedback")?.focus({preventScroll:true});
    }
  },[model.notice,model.busy,editing]);
  function keys(event:React.KeyboardEvent<HTMLElement>) {
    if(event.key==="Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();event.stopPropagation();
      if(!editing&&!model.busy)(onBack??onClose)();
    }
    wrapDialogTab(event);
  }
  const switchBlocked=!!editing||model.busy;
  const content=<section ref={dialog} className={`agent-memory-manager${centered?" agent-reference-modal":""}`} role="dialog" aria-modal="true" aria-label="管理记忆" onKeyDown={keys}>
    <header className="agent-popover-header">
      {onBack&&<button type="button" className="agent-memory-back" aria-label="返回对话详情" title="返回对话详情" disabled={switchBlocked} onClick={onBack}><ArrowLeft size={17} aria-hidden="true"/></button>}
      <strong>{centered?"记忆管理":"管理记忆"}</strong>{centered&&<span className="agent-memory-current">本对话生效：{model.selection.enabled&&!materialsOnly?model.projectLabel(model.selection.projectId):"已关闭"}</span>}
      <div className="agent-memory-actions">
      <button type="button" title="新增记忆" aria-label="新增记忆" disabled={switchBlocked||model.blocked||!model.view} onClick={()=>{setTab("saved");setEditing({id:"new"});}}><Plus size={15}/>{centered&&<span>新建</span>}</button>
      {centered&&<label className="agent-memory-switch" title="启用或关闭本对话记忆"><input type="checkbox" role="switch" aria-label="启用或关闭本对话记忆"
        checked={model.selection.enabled&&!materialsOnly} disabled={switchBlocked||model.blocked||model.loading||!model.view||materialsOnly}
        onChange={event=>model.select({...model.selection,enabled:event.target.checked})}/></label>}
      <button ref={closeButton} type="button" aria-label="关闭记忆管理" disabled={switchBlocked} onClick={onClose}><X size={17}/></button>
    </div></header>
    <div className="agent-memory-manager-filters"><div className="agent-memory-manager-controls">
      <label className={centered?"agent-visually-hidden":undefined} htmlFor={scopeId}>查看范围</label><select id={scopeId} value={model.browseScope} disabled={switchBlocked||!model.view} onChange={event=>model.browseProject(event.target.value)}>
        <option value="">个人通用</option>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
    </div>
    <div className="agent-memory-tabs" aria-label="记忆列表">
      <button type="button" aria-pressed={tab==="saved"} disabled={switchBlocked} onClick={()=>setTab("saved")}>已保存{model.view&&<small>({entries.length})</small>}</button>
      <button type="button" aria-pressed={tab==="pending"} disabled={switchBlocked} onClick={()=>setTab("pending")}>待确认{model.browseProposals&&<small>({proposals.length})</small>}</button>
      {!centered&&<button className="agent-memory-more" type="button" aria-expanded={utility} disabled={switchBlocked} onClick={()=>setUtility(!utility)}>更多</button>}
    </div></div>
    {editing&&<p className="agent-memory-edit-notice" role="status">先保存或取消当前编辑，再切换范围或关闭。</p>}
    <div className="agent-memory-list">
      {utility&&<section className="agent-memory-tools" aria-label="记忆管理选项">
        <label>搜索记忆<input type="search" disabled={switchBlocked} value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {tab==="saved"&&<label><input type="checkbox" checked={inactive} disabled={switchBlocked} onChange={event=>setInactive(event.target.checked)}/>仅显示已停用</label>}
        <form onSubmit={event=>{event.preventDefault();if(projectName.trim())void model.perform({action:"createProject",name:projectName.trim()},"已创建项目").then(ok=>{if(ok)setProjectName("");});}}>
          <label>新建记忆项目<input maxLength={60} disabled={model.blocked||switchBlocked} value={projectName} onChange={event=>setProjectName(event.target.value)}/></label><button type="submit" disabled={model.blocked||switchBlocked||!projectName.trim()}>创建项目</button>
        </form>
        <details className="agent-memory-origin"><summary>诊断</summary><p>{model.view?.configured?"本地记忆已就绪":model.view?.runtimeDetail||"需要准备本地记忆"}</p>
          <button type="button" disabled={model.blocked||switchBlocked} onClick={()=>void model.perform(model.view?.configured?{action:"repair"}:{action:"status",prepareRuntime:true},"已完成本地记忆检查")}>{model.view?.configured?"修复本地记忆":"准备本地记忆"}</button>
        </details>
      </section>}
      {editing?.id==="new"&&<MemoryEditor initial={{title:"",body:"",kind:"decision"}} scope={model.browseScope} projects={projects} fixed={false} disabled={model.blocked} action="确认并记住" onCancel={()=>setEditing(null)}
        onSave={(content,projectId)=>model.save(content,{projectId,topicKey:content.title,expectedVersion:0},"已记住 · "+model.projectLabel(projectId))}/>}
      {!model.view ? <p className="agent-memory-empty">{model.loading?"正在读取记忆…":model.error?"暂时无法读取记忆。":"正在读取记忆…"}</p> :
        tab==="saved" ? entries.length ? entries.map(entry=><EntryCard key={entry.id} entry={editing?.entry?.id===entry.id?editing.entry:entry} model={model}
          editing={editing?.id===entry.id} onEdit={()=>{if(!editing)setEditing({id:entry.id,entry});}} onCancel={()=>setEditing(null)}/>) : !editing&&<p className="agent-memory-empty">{query?"没有匹配的记忆。":"此范围还没有已保存的记忆。"}</p>
        : !model.browseProposals ? <p className="agent-memory-empty">正在读取建议…</p> : proposals.length ? proposals.map(item=><MemoryProposalCard key={item.id} item={item} model={model} editing={editing?.id===item.id}
          onEdit={()=>{if(!editing)setEditing({id:item.id});}} onCancel={()=>setEditing(null)}/>) : <p className="agent-memory-empty">此范围没有待确认的建议。</p>}
      {loaded.length>=200 && <p className="agent-memory-meta">当前显示最近加载的 200 条记忆中的匹配项。</p>}
    </div>
    <MemoryStatus model={model}/>
    <footer className="agent-memory-manager-footer">
      <div className="agent-memory-footer-context">
      <span>{materialsOnly?"本轮不使用记忆（只用所选资料）":"本对话记忆："+(model.selection.enabled?model.projectLabel(model.selection.projectId)+(model.selection.projectId?"＋个人通用":""):"关闭")}</span>
      {centered&&<button className="agent-memory-more" type="button" aria-expanded={utility} disabled={switchBlocked} onClick={()=>{setUtility(!utility);if(!utility)requestAnimationFrame(()=>dialog.current?.querySelector<HTMLElement>(".agent-memory-tools input")?.focus());}}>更多</button>}
      </div>
      <small>查看其他范围不会更改本对话。</small>
      {usage&&<Audit usage={usage} model={model}/>}
      {settings}
    </footer>
  </section>;
  return centered?<div className="agent-reference-overlay agent-memory-overlay" onClick={event=>{if(event.target===event.currentTarget&&!switchBlocked)onClose();}}>{content}</div>:content;
}

export function InlineMemoryProposals({model,items}: {model:SharedMemoryModel;items:MemoryProposal[]}) {
  const [editing,setEditing]=useState<string|null>(null);
  const [result,setResult]=useState("");
  const resultRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(result&&document.activeElement===document.body)resultRef.current?.focus({preventScroll:true});},[result]);
  return <>{items.map(item=><MemoryProposalCard key={item.id} model={model} item={item} editing={editing===item.id} onEdit={()=>setEditing(item.id)} onCancel={()=>setEditing(null)} onResult={setResult}/>)}{result&&<p ref={resultRef} className="agent-memory-feedback" role="status" tabIndex={-1}>{result}</p>}</>;
}
