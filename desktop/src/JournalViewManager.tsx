import {useEffect,useRef,useState} from "react";
import {CalendarDays,CalendarRange,Check,ChevronDown,ChevronUp,Copy,Eye,EyeOff,LayoutGrid,List,Table2,Plus,RotateCcw,Trash2} from "lucide-react";
import {journalLayouts,type JournalLayout,type JournalViewStore} from "./JournalViews";

const layoutIcons={stream:CalendarRange,records:LayoutGrid,calendar:CalendarDays,list:List,table:Table2};

export function JournalViewManager({store,onNew}:{store:JournalViewStore;onNew:()=>void}){
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),nameField=useRef<HTMLInputElement>(null);
 const name=store.active?.name||"默认视图";
 const [draft,setDraft]=useState(name),[open,setOpen]=useState(false);
 const ActiveIcon=layoutIcons[store.view.layout];
 function position(){const el=panel.current,button=trigger.current;if(!el||!button)return;const rect=(button.parentElement??button).getBoundingClientRect(),width=Math.min(320,window.innerWidth-24);el.style.width=`${width}px`;el.style.left=`${Math.max(12,Math.min(rect.left,window.innerWidth-width-12))}px`;el.style.top=`${Math.max(12,Math.min(rect.bottom+6,window.innerHeight-el.offsetHeight-12))}px`;}
 function close(){panel.current?.hidePopover?.();requestAnimationFrame(()=>trigger.current?.focus());}
 useEffect(()=>{
  let frame=0;
  const reposition=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;if(panel.current?.matches(":popover-open"))position();});};
  const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(reposition):null;if(panel.current)observer?.observe(panel.current);
  window.addEventListener("resize",reposition);
  return()=>{observer?.disconnect();window.removeEventListener("resize",reposition);if(frame)cancelAnimationFrame(frame);};
 },[]);
 function tab(id:string,label:string){
  const active=store.activeId===id;
  if(!active)return <button key={id} type="button" aria-pressed="false" onClick={()=>{if(open)panel.current?.hidePopover?.();id?store.select(id):store.reset();}}><span>{label}</span></button>;
  return <div className="journal-active-view" key={id}>
   <button type="button" className="journal-view-tab-name" aria-pressed="true" onClick={()=>{if(open)panel.current?.hidePopover?.();}}><ActiveIcon size={15}/><span>{label}</span>{store.modified&&<i className="journal-view-modified-dot" aria-hidden="true"/>}</button>
   <button ref={trigger} type="button" className="journal-view-tab-arrow" aria-expanded={open} aria-label={`${label}，视图设置`} title="视图设置" popoverTarget="journal-view-menu"><ChevronDown size={13}/></button>
  </div>;
 }
 return <div className="journal-db-tabs" role="group" aria-label="日志视图">
  {tab("","默认视图")}{store.saved.filter(v=>!v.hidden).map(v=>tab(v.id,v.name))}
  <button type="button" aria-label="新建日志视图" disabled={store.saved.length>=30} onClick={onNew}><Plus size={14}/><span>添加视图</span></button>
  <div ref={panel} id="journal-view-menu" popover="auto" data-hub-keyboard-scope="journal-view" data-keyboard-open={open} className="journal-db-menu journal-view-popover" aria-label="当前日志视图设置" onToggle={event=>{const shown=event.currentTarget.matches(":popover-open");setOpen(shown);if(!shown)return;setDraft(name);position();requestAnimationFrame(()=>{const field=nameField.current;if(field){field.focus();field.select();}else panel.current?.querySelector<HTMLButtonElement>('.journal-view-layouts [aria-pressed="true"]')?.focus();});}} onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();close();}}}>
   {store.active?<form className="journal-view-name" onSubmit={e=>{e.preventDefault();if(draft.trim())store.rename(store.activeId,draft);close();}}><input ref={nameField} aria-label="视图名称" value={draft} maxLength={60} required onChange={e=>setDraft(e.target.value)}/>{draft.trim()!==name&&<button type="submit" disabled={!draft.trim()}>保存名称</button>}</form>:<strong>默认视图</strong>}
   {store.modified&&<div className="journal-view-actions journal-view-persistence" aria-label="保存当前视图调整"><button type="button" onClick={()=>{store.updateSaved();close();}}><Check size={16}/>更新视图</button><button type="button" onClick={()=>{store.select(store.activeId);close();}}><RotateCcw size={16}/>恢复已保存设置</button></div>}
   <div className="journal-view-layouts" role="group" aria-label="日志布局">{Object.entries(journalLayouts).filter(([id])=>id!=="table").map(([id,label])=>{const Icon=layoutIcons[id as JournalLayout],selected=store.view.layout===id;return <button type="button" key={id} aria-pressed={selected} onClick={()=>store.update({layout:id as JournalLayout})}><Icon size={16}/><span>{label}</span>{selected&&<Check size={15}/>}</button>;})}</div>
   <details className="journal-view-secondary"><summary>显示设置</summary><label>密度<select value={store.view.compact?"compact":"comfortable"} onChange={e=>store.update({compact:e.target.value==="compact"})}><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label><fieldset><legend>显示属性</legend>{([['summary','摘要'],['source','资料库']] as const).map(([key,label])=><label key={key}><input type="checkbox" checked={store.view[key]} onChange={e=>store.update({[key]:e.target.checked})}/>{label}</label>)}</fieldset><label>排序<select value={store.view.ascending?"asc":"desc"} disabled={store.view.layout==="stream"||store.view.layout==="records"} onChange={e=>store.update({ascending:e.target.value==="asc"})}><option value="asc">从早到晚</option><option value="desc">从晚到早</option></select></label></details>
   <div className="journal-view-actions"><button type="button" disabled={store.saved.length>=30} onClick={()=>{store.save(name.slice(0,57)+" 副本");close();}}><Copy size={16}/>复制视图</button><button type="button" disabled={!store.active} onClick={()=>{if(store.active){store.remove(store.activeId);close();}}}><Trash2 size={16}/>删除视图</button></div>
   {!store.active&&<button type="button" className="journal-view-reset" onClick={()=>{store.reset();close();}}>恢复默认设置</button>}
   {store.saved.length>0&&<details className="journal-view-secondary"><summary>管理所有视图</summary>{store.saved.map((saved,index)=><div className="journal-managed-view" key={saved.id}><button type="button" disabled={saved.hidden} onClick={()=>{store.select(saved.id);close();}}><span>{saved.name}</span><small>{journalLayouts[saved.config.layout]}{saved.hidden?" · 已隐藏":""}</small></button><button type="button" aria-label={`上移 ${saved.name}`} disabled={!index} onClick={()=>store.move(saved.id,-1)}><ChevronUp size={14}/></button><button type="button" aria-label={`下移 ${saved.name}`} disabled={index===store.saved.length-1} onClick={()=>store.move(saved.id,1)}><ChevronDown size={14}/></button><button type="button" aria-label={`${saved.hidden?"显示":"隐藏"} ${saved.name}`} onClick={()=>{store.hide(saved.id,!saved.hidden);if(saved.id===store.activeId&&!saved.hidden)close();}}>{saved.hidden?<EyeOff size={14}/>:<Eye size={14}/>}</button></div>)}</details>}
  </div>
 </div>;
}
