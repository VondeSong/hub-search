import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {ArrowLeft,Check,ChevronRight,Circle,Pin,PinOff,Trash2,X} from "lucide-react";
export type WorkSummary={id:string;goal:string;state:string;messageCount?:number;updatedAt?:number;pinned?:boolean};
export function AgentConversationHistory({works,currentId,disabled,more,loading,error,states,onOpen,onChange,onMore,onClose,onRetry,expanded,onExpand,onBack}:{works:WorkSummary[];currentId?:string;disabled:boolean;more:boolean;loading:boolean;error:string;states:Record<string,string>;onOpen:(work:WorkSummary)=>void;onChange:(work:WorkSummary,change:{pinned?:boolean;deleted?:boolean})=>Promise<void>;onMore:()=>void;onClose:()=>void;onRetry?:()=>void;expanded:boolean;onExpand:()=>void;onBack:()=>void}){
 const [removed,setRemoved]=useState<WorkSummary[]>([]);
 const [changing,setChanging]=useState(false);
 const [actionError,setActionError]=useState("");
 const [menuOpen,setMenuOpen]=useState(false);
 const mutation=useRef(false),undoButton=useRef<HTMLButtonElement>(null),history=useRef<HTMLElement>(null);
 const update=async(work:WorkSummary,change:{pinned?:boolean;deleted?:boolean})=>{
  if(disabled||mutation.current)return false;
  mutation.current=true;setChanging(true);setActionError("");
  try{await onChange(work,change);return true;}
  catch(reason){setActionError(String(reason));return false;}
  finally{mutation.current=false;setChanging(false);}
 };
 const remove=async(work:WorkSummary,button:HTMLButtonElement)=>{
  const row=button.closest(".agent-history-row");
  const next=(row?.nextElementSibling||row?.previousElementSibling)?.querySelector<HTMLButtonElement>(".agent-history-open");
  if(await update(work,{deleted:true})){
   setRemoved(previous=>[...previous.filter(item=>item.id!==work.id),work]);
   setTimeout(()=>{
    const section=history.current,menu=section?.closest("details");
    if(menu&&!menu.open)return;
    const target=menu?(next?.isConnected?next:section?.querySelector<HTMLButtonElement>(".agent-history-heading button")):undoButton.current;
    target?.focus({preventScroll:true});
   },0);
  }
 };
 const restore=async()=>{
  const work=removed[removed.length-1];if(!work)return;
  const section=history.current;
  if(await update(work,{deleted:false})){
   setRemoved(previous=>previous.filter(item=>item.id!==work.id));
   setTimeout(()=>(undoButton.current||section?.closest("details")?.querySelector<HTMLElement>("summary")||section?.querySelector<HTMLButtonElement>(".agent-history-heading button"))?.focus(),0);
  }
 };
 useEffect(()=>{
  const menu=history.current?.closest("details");
  if(!menu)return;
  const sync=()=>setMenuOpen(menu.open);
  sync();menu.addEventListener("toggle",sync);
  return ()=>menu.removeEventListener("toggle",sync);
 },[]);
 const ordered=[...works].sort((a,b)=>Number(!!b.pinned)-Number(!!a.pinned));
 const back=useRef<HTMLButtonElement>(null),expand=useRef<HTMLButtonElement>(null),previousPage=useRef(expanded);
 useEffect(()=>{
  if(previousPage.current!==expanded)(expanded?back.current:expand.current)?.focus();
  previousPage.current=expanded;
 },[expanded]);
 const visible=expanded?ordered:ordered.slice(0,4);
 const undoTarget=menuOpen?null:history.current?.closest(".agent-panel");
 const undo=removed.length>0?<div className={`agent-history-undo${undoTarget?" agent-history-toast":""}`}><span role="status">{removed.length===1?"已删除对话":`已删除 ${removed.length} 段对话`}</span><button ref={undoButton} type="button" disabled={disabled||changing} onClick={()=>void restore()}>撤销</button></div>:null;
 return <section ref={history} className={`agent-conversations${expanded?" agent-history-page":""}`} aria-label={expanded?"全部对话":"对话历史"}><div className="agent-history-heading">{expanded&&<button ref={back} type="button" aria-label="返回对话菜单" onClick={()=>{onBack();}}><ArrowLeft size={16}/></button>}<strong>{expanded?"全部对话":"对话历史"}</strong><button type="button" aria-label="关闭对话详情" onClick={onClose}><X size={16}/></button></div>{loading&&!works.length&&<p role="status">正在读取历史对话…</p>}{!loading&&!error&&!works.length&&<p className="agent-note">还没有历史对话，发送第一条消息后会显示在这里。</p>}<div className="agent-history-list">{visible.map(work=><div className="agent-history-row" key={work.id}><button type="button" className="agent-history-open" aria-current={currentId===work.id?"true":undefined} disabled={disabled||changing} onClick={()=>onOpen(work)}>{work.pinned?<Pin size={16}/>:<Circle size={16}/>}<span><span className="agent-history-title" title={work.goal}>{work.goal.replace(/\s+/g," ").trim()}</span><small>{work.updatedAt?new Date(work.updatedAt).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})+" · ":""}{work.messageCount!==undefined?`${work.messageCount} 条消息`:states[work.state]||work.state}</small></span>{currentId===work.id&&<Check size={16}/>}</button><span className="agent-history-actions"><button type="button" disabled={disabled||changing} aria-label={`${work.pinned?"取消置顶":"置顶对话"} ${work.goal}`} title={work.pinned?"取消置顶":"置顶"} onClick={event=>{const button=event.currentTarget,section=button.closest(".agent-conversations");void update(work,{pinned:!work.pinned}).then(()=>setTimeout(()=>{if(button.isConnected)button.focus();else (section?.querySelector<HTMLButtonElement>(".agent-history-more")||section?.querySelector<HTMLButtonElement>(".agent-history-heading button"))?.focus();},0));}}>{work.pinned?<PinOff size={15}/>:<Pin size={15}/>}</button><button type="button" disabled={disabled||changing} aria-label={`删除对话 ${work.goal}`} title="删除对话" onClick={event=>void remove(work,event.currentTarget)}><Trash2 size={15}/></button></span></div>)}</div>{undoTarget&&undo?createPortal(undo,undoTarget):undo}{actionError&&!error&&<p role="alert">{actionError}</p>}{!expanded&&(ordered.length>4||more)&&<button ref={expand} className="agent-history-more" type="button" onClick={()=>{onExpand();}}>更多…<ChevronRight size={16}/></button>}{expanded&&more&&<button className="agent-history-more" type="button" disabled={disabled||changing||loading} onClick={onMore}>{loading?"正在加载…":error?"重试加载更早对话":"加载更早对话"}</button>}{error&&<div><p role="alert">{error}</p>{onRetry&&(!expanded||!works.length)&&<button type="button" disabled={disabled||changing||loading} onClick={onRetry}>重新读取历史</button>}</div>}</section>;
}
