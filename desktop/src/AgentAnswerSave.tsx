import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Ellipsis, FilePlus2, ListPlus, FileInput, X } from "lucide-react";
import { AgentMaterials, type AgentMaterial, type NoteLocator } from "./AgentMaterials";
import { useModalFocus } from "./useModalFocus";

export type AnswerSave={saveId:string;runId:string;libraryId?:string;projectId?:string;projectName?:string;target?:NoteLocator;targetTitle?:string;title:string;text:string;mode:"append"|"note"|"task";targetName:string;targetPath?:string;state:string;confirmationToken:string;error?:string;receipt?:{verified:boolean;objectId?:string;path?:string;indexed?:boolean}};
type Destination={id:string;name:string;provider:string};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
function noteDraft(origin:{title:string;text:string},mode:AnswerSave["mode"]){
  const heading=mode==="note"?/^# ([^\r\n]+)\r?\n(?:\r?\n)?/.exec(origin.text):null;
  return heading?{title:heading[1].trim(),text:origin.text.slice(heading[0].length)}:origin;
}
const saveActions = [
  { mode:"append", title:"插入页面", detail:"选择要追加到的页面", icon:FileInput },
  { mode:"note", title:"新建笔记", detail:"先编辑笔记草稿", icon:FilePlus2 },
  { mode:"task", title:"创建任务", detail:"先编辑待办和目标清单", icon:ListPlus },
] as const;

function AnswerSaveMenu({disabled,onSelect}:{disabled:boolean;onSelect:(mode:AnswerSave["mode"])=>void}) {
  const [open,setOpen]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null);
  const menu=useRef<HTMLDivElement>(null);
  const id=useId();
  const owner=open?trigger.current?.closest<HTMLElement>(".agent-panel"):null;
  function close(restoreFocus=false) {
    setOpen(false);
    if(restoreFocus)trigger.current?.focus({preventScroll:true});
  }
  useLayoutEffect(()=>{
    const button=trigger.current, popup=menu.current;
    if(!open || !button || !popup)return;
    function place(){
      if(!owner || !button || !popup)return;
      const panel=owner.getBoundingClientRect(), anchor=button.getBoundingClientRect();
      const width=Math.min(240,owner.clientWidth-24);
      const above=anchor.top-panel.top-16, below=panel.bottom-anchor.bottom-16;
      const upward=below<popup.scrollHeight&&above>below;
      const maxHeight=Math.max(0,upward?above:below);
      popup.style.width=`${width}px`;
      popup.style.maxHeight=`${maxHeight}px`;
      popup.style.left=`${Math.max(12,Math.min(anchor.left-panel.left,owner.clientWidth-width-12))}px`;
      popup.style.top=`${upward?anchor.top-panel.top-Math.min(popup.scrollHeight,maxHeight)-5:anchor.bottom-panel.top+5}px`;
    }
    place();
    popup.querySelector("button")?.focus({preventScroll:true});
    const observer=typeof ResizeObserver==="undefined"?null:new ResizeObserver(place);
    if(owner)observer?.observe(owner);
    function outside(event:Event){
      const target=event.target;
      if(!(target instanceof Element) || popup?.contains(target) || button?.contains(target))return;
      const other=target.closest(".agent-panel");
      if(owner&&other&&other!==owner)return;
      close();
    }
    const scrolled=(event:Event)=>{if(event.target instanceof Node&&!popup.contains(event.target))close();};
    document.addEventListener("pointerdown",outside,true);
    document.addEventListener("focusin",outside);
    owner?.addEventListener("scroll",scrolled,true);
    return ()=>{
      observer?.disconnect();
      document.removeEventListener("pointerdown",outside,true);
      document.removeEventListener("focusin",outside);
      owner?.removeEventListener("scroll",scrolled,true);
    };
  },[open,owner]);
  useEffect(()=>{if(disabled)setOpen(false);},[disabled]);
  const popup=open&&<div id={id} ref={menu} className="agent-answer-more-menu" role="menu" aria-label="更多回答操作"
    onKeyDown={event=>{
      if(event.nativeEvent.isComposing)return;
      if(event.key==="Escape" || event.key==="Tab"){
        if(event.key==="Escape"){event.preventDefault();event.stopPropagation();}
        close(true);
        return;
      }
      if(!["ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
      const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
      const index=items.indexOf(document.activeElement as HTMLButtonElement);
      const next=event.key==="Home"?0:event.key==="End"?items.length-1:(index+(event.key==="ArrowDown"?1:-1)+items.length)%items.length;
      event.preventDefault();
      items[next]?.focus({preventScroll:true});
    }}>
    {saveActions.map(({mode,title,detail,icon:Icon})=><button key={mode} type="button" role="menuitem" tabIndex={-1} aria-label={title} onClick={()=>{
      if(!trigger.current)return;
      close(true);
      onSelect(mode);
    }}><Icon size={16} aria-hidden="true"/><span><strong>{title}</strong><small>{detail}</small></span></button>)}
  </div>;
  return <>
    <button type="button" ref={trigger} className="agent-answer-more" disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={open?id:undefined} onClick={()=>open?close():setOpen(true)}
      onKeyDown={event=>{if(event.key==="ArrowDown"&&!open){event.preventDefault();setOpen(true);}}}><Ellipsis size={16} aria-hidden="true"/>更多</button>
    {owner?createPortal(popup,owner):popup}
  </>;
}

export function AgentAnswerSave({workId,runId,current,disabled,records=[],onChanged}:{workId:string;runId:string;current?:NoteLocator|null;disabled:boolean;records?:AnswerSave[];onChanged:()=>void}){
  const [open,setOpen]=useState(false),[mode,setMode]=useState<AnswerSave["mode"]>(current?"append":"note"),[libraries,setLibraries]=useState<Destination[]>([]),[target,setTarget]=useState<AgentMaterial|null>(null),[library,setLibrary]=useState(""),[project,setProject]=useState(""),[projects,setProjects]=useState<{id:string;name:string}[]>([]),[title,setTitle]=useState(""),[text,setText]=useState(""),[sourceHash,setSourceHash]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[preview,setPreview]=useState<AnswerSave|null>(null),[search,setSearch]=useState(false),[existingId,setExistingId]=useState("");
  const identity=useRef<{key:string;id:string}|null>(null),epoch=useRef(0);
  const destinations=useRef<HTMLDivElement>(null);
  const dialog=useRef<HTMLElement>(null);
  const restoreProject=useRef("");
  const owner=destinations.current?.closest(".agent-panel") ?? document.body;
  useModalFocus({active:open,containerRef:dialog,onDismiss:close});
  useEffect(()=>()=>{epoch.current++;},[]);
  async function show(selected:AnswerSave["mode"],editing?:AnswerSave){if(busy||disabled)return;identity.current=null;restoreProject.current=editing?.projectId||"";setOpen(true);setMode(selected);setError("");setBusy(true);setPreview(null);setSourceHash("");const ticket=++epoch.current;try{const [origin,targets]=await Promise.all([call<{text:string;title:string;sourceHash:string}>({action:"answerSaveSource",id:workId,runId}),call<{libraries:Destination[]}>({action:"answerDestinations",id:workId})]);if(ticket!==epoch.current)return;const draft=editing||noteDraft(origin,selected);setLibraries(targets.libraries);setText(draft.text);setTitle(draft.title);setSourceHash(origin.sourceHash);if(selected==="append"){const destination=editing?editing.target:current;setTarget(destination?{locator:destination,title:editing?.targetTitle||"当前页面",path:editing?.targetPath||destination.documentId,libraryName:targets.libraries.find(l=>l.id===destination.libraryId)?.name||""}:null);setLibrary(destination?.libraryId||"");}else{setTarget(null);setLibrary(editing?.libraryId||"");}}catch(e){if(ticket===epoch.current)setError(String(e));}finally{if(ticket===epoch.current)setBusy(false);}}
  useEffect(()=>{if(!open||!library)return;const dest=libraries.find(l=>l.id===library);setProjects([]);setProject("");if(dest?.provider!=="dida365")return;let alive=true;void call<{projects:{id:string;name:string}[]}>({action:"answerSaveTarget",id:workId,libraryId:library}).then(v=>{if(alive){setProjects(v.projects);setProject(v.projects.some(p=>p.id===restoreProject.current)?restoreProject.current:"");}},e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[open,library,libraries]);
  function close(){if(busy)return;epoch.current++;setOpen(false);}
  async function prepare(){const ticket=epoch.current;setBusy(true);setError("");try{const args={action:"prepareAnswerSave",id:workId,runId,mode,title,text,sourceHash,libraryId:mode==="append"?target?.locator.libraryId:library,...(mode==="append"?{target:target?.locator}:{}),...(project?{projectId:project}:{})};const key=JSON.stringify(args);if(identity.current?.key!==key)identity.current={key,id:crypto.randomUUID()};const next=await call<AnswerSave>({...args,saveId:identity.current.id});if(ticket===epoch.current){setPreview(next);onChanged();}}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function submit(item:AnswerSave){const ticket=epoch.current;setBusy(true);setError("");try{const next=await call<AnswerSave>({action:"submitAnswerSave",id:workId,saveId:item.saveId,confirmationToken:item.confirmationToken});if(ticket===epoch.current){setPreview(next);onChanged();}}catch(e){setError(String(e));}finally{setBusy(false);}}
  async function inspect(item:AnswerSave){setBusy(true);setError("");try{const next=await call<AnswerSave>({action:"inspectAnswerSave",id:workId,saveId:item.saveId,...(existingId.trim()?{objectId:existingId.trim()}:{})});setPreview(next);onChanged();}catch(e){setError(String(e));}finally{setBusy(false);}}
  const receipt=(item:AnswerSave)=><div key={item.saveId} className="agent-answer-save-receipt"><strong>{item.state==="verified"?"已保存并核验":item.state==="prepared"?"保存预览已准备":"保存结果待核对"} · {item.targetName}</strong><p>{item.receipt?.path||item.targetPath||item.targetTitle||item.projectName||item.receipt?.objectId||item.title}</p>{item.state==="verified"&&<button type="button" disabled={busy||disabled} onClick={()=>{setMode(item.mode);setOpen(true);void inspect(item);}}>查看保存结果</button>}{item.receipt?.indexed===false&&<p>原文件已保存，搜索索引尚待更新。</p>}{item.error&&<p role="alert">{item.error}</p>}{item.state==="unknown"||item.state==="executing"?<><p>可能已有写入，核对只读取结果，不会再次创建。</p>{!item.receipt?.objectId&&!item.receipt?.path&&<input aria-label="已创建页面或任务的 ID" placeholder="远端页面或任务 ID（有保存身份时无需填写）" value={existingId} onChange={e=>setExistingId(e.target.value)}/>}<button type="button" disabled={busy||disabled} onClick={()=>{setMode(item.mode);setOpen(true);void inspect(item);}}>核对保存结果</button></>:item.state==="prepared"&&<button type="button" disabled={busy||disabled} onClick={()=>{setMode(item.mode);setPreview(item);setOpen(true);}}>查看保存预览</button>}</div>;
  return <div ref={destinations} className="agent-answer-destinations"><AnswerSaveMenu disabled={disabled} onSelect={next=>{setSearch(false);void show(next);}}/>
    {records.filter(r=>r.runId===runId).map(receipt)}
    {open&&createPortal(<section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="保存回答" className="agent-answer-save" onKeyDown={e=>{if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close();}}}><header className="agent-popover-header"><strong>{mode==="append"?"插入页面":mode==="task"?"创建任务":"新建笔记"}</strong><button type="button" aria-label="关闭保存回答" disabled={busy} onClick={close}><X size={16}/></button></header>
      <div className="agent-answer-save-body">{preview?<>{receipt(preview)}<h3>{preview.title}</h3><pre>{preview.text}</pre></>:<>
        {mode==="append"?<><button type="button" onClick={()=>setSearch(v=>!v)}>{target?`${target.title} · ${target.libraryName}`:"搜索并选择目标页面"}</button>{current&&<button type="button" onClick={()=>{setTarget({locator:current,title:"当前页面",path:current.documentId,libraryName:libraries.find(l=>l.id===current.libraryId)?.name||""});setSearch(false);}}>使用当前页面</button>}{search&&<AgentMaterials embedded selected={target?[target]:[]} disabled={busy} onChange={items=>{setTarget(items[items.length-1]||null);setSearch(false);}} onDone={()=>setSearch(false)}/>}</>:<><label>保存到<select aria-label="保存资料库" value={library} disabled={busy} onChange={e=>{restoreProject.current="";setLibrary(e.target.value);}}><option value="">选择资料库</option>{libraries.filter(l=>mode!=="task"||l.provider==="dida365").map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>{libraries.find(l=>l.id===library)?.provider==="dida365"&&<label>滴答清单<select aria-label="目标滴答清单" disabled={busy} value={project} onChange={e=>setProject(e.target.value)}><option value="">选择清单</option>{projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}</>}
        <label>{mode==="task"?"任务名称":"标题"}<input aria-label="保存标题" value={title} maxLength={100} disabled={busy} onChange={e=>setTitle(e.target.value)}/></label><label>正文<textarea aria-label="保存正文" rows={10} value={text} maxLength={32000} disabled={busy} onChange={e=>setText(e.target.value)}/></label><p className="agent-note">{mode==="append"?"只向你选定的目标追加；保存前再次核对页面版本。":mode==="task"?"创建可完成的滴答行动任务，不作为资料笔记保存。":"创建新笔记。Obsidian 保存在所选库根目录，Craft 保存在未分类。"}</p>
      </>}{busy&&<p role="status">正在核对保存内容…</p>}{error&&<p role="alert">{error}</p>}</div>
      <footer className="agent-answer-save-footer">{preview ? preview.state==="prepared"&&<><p className="agent-note">保存所选回答的编辑版本；确认后才写入，原有页面内容会保留。</p><button type="button" disabled={busy||disabled} onClick={()=>void submit(preview)}>确认{preview.mode==="task"?"创建任务":"保存"}</button><button type="button" disabled={busy} onClick={()=>void show(preview.mode,preview)}>返回编辑</button></> : <button type="button" disabled={busy||!sourceHash||!title.trim()||!text.trim()||(mode==="append"?!target:!library||libraries.find(l=>l.id===library)?.provider==="dida365"&&!project)} onClick={()=>void prepare()}>预览保存</button>}</footer>
    </section>,owner)}
  </div>;
}
