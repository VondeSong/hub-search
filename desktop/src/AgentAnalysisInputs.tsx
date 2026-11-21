import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {AgentMaterial} from "./AgentMaterials";
type DataFile={source:{libraryId:string;sourceItemId:string};title:string;parentTitle:string};
export function AgentAnalysisInputs({disabled,limitReached,selected,onSelect,onRemove,onPreparing}:{disabled:boolean;limitReached:boolean;selected:AgentMaterial[];onSelect:(item:AgentMaterial)=>void;onRemove:(item:AgentMaterial)=>void;onPreparing:(busy:boolean)=>void}){
 const [query,setQuery]=useState(""),[items,setItems]=useState<DataFile[]>([]),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const alive=useRef(true),ticket=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 useEffect(()=>()=>onPreparing(false),[onPreparing]);
 async function load(){const n=++ticket.current;setBusy(true);setError("");try{const value=await invoke<{files:DataFile[];hasMore:boolean}>("agent_investigation",{args:{action:"analysisMaterials",query}});if(alive.current&&n===ticket.current){setItems(value.files);setMore(value.hasMore);}}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current&&n===ticket.current)setBusy(false);}}
 async function add(item:DataFile){setBusy(true);setError("");onPreparing(true);try{const value=await invoke<AgentMaterial>("agent_investigation",{args:{action:"stageAnalysisFile",source:item.source}});if(alive.current)onSelect(value);}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current){setBusy(false);onPreparing(false);}}}
 return <section className="agent-add-section" data-material-focus>
  <p className="agent-note">选择已下载的文件，每份最多 10 MiB。Codex 可按需打开原件。DeepSeek 可读取资料库 PDF 已提取的文字。</p>
  <label>按笔记或文件标题查找<input type="search" maxLength={200} value={query} disabled={busy||disabled} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();void load();}}}/></label>
  <button type="button" disabled={busy||disabled} onClick={()=>void load()}>查找文件</button>
  {!!selected.length&&<section aria-label="已选文件"><h4 className="agent-material-group-title">已选文件 {selected.length}</h4>
    {selected.map(item=><div className="agent-material-selected" key={item.locator.documentId}><span>{item.title}</span><button type="button" disabled={busy||disabled} aria-label={`移除文件 ${item.title}`} onClick={()=>onRemove(item)}>移除</button></div>)}
  </section>}
  {items.map(item=><div className="agent-material-selected" key={JSON.stringify(item.source)}><span>{item.title}<small>{item.parentTitle}</small></span><button type="button" disabled={busy||disabled||limitReached} aria-label={`添加文件 ${item.title}`} onClick={()=>void add(item)}>添加</button></div>)}
  {more&&<p className="agent-note">仅显示前 40 项，请缩小查找范围。</p>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
