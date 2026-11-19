import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {AgentMaterial} from "./AgentMaterials";
type DataFile={source:{libraryId:string;sourceItemId:string};title:string;parentTitle:string};
export function AgentAnalysisInputs({disabled,onSelect}:{disabled:boolean;onSelect:(item:AgentMaterial)=>void}){
 const [query,setQuery]=useState(""),[items,setItems]=useState<DataFile[]>([]),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const alive=useRef(true),ticket=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 async function load(){const n=++ticket.current;setBusy(true);setError("");try{const value=await invoke<{files:DataFile[];hasMore:boolean}>("agent_investigation",{args:{action:"analysisMaterials",query}});if(alive.current&&n===ticket.current){setItems(value.files);setMore(value.hasMore);}}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current&&n===ticket.current)setBusy(false);}}
 async function add(item:DataFile){setBusy(true);setError("");try{const value=await invoke<AgentMaterial>("agent_investigation",{args:{action:"stageAnalysisFile",source:item.source}});if(alive.current)onSelect(value);}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current)setBusy(false);}}
 return <details className="agent-add-section"><summary>选择资料库文件</summary><p className="agent-note">选择已下载的文件，每份最多 10 MiB。Codex 可按需打开原件。使用 DeepSeek 时，资料库 PDF 可使用已有的提取文字。</p><label>按笔记或文件标题查找<input type="search" maxLength={200} value={query} disabled={busy||disabled} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();void load();}}}/></label><button type="button" disabled={busy||disabled} onClick={()=>void load()}>查找文件</button>{items.map(item=><p key={item.source.sourceItemId}><button type="button" disabled={busy||disabled} onClick={()=>void add(item)}>{item.title}</button><small> · {item.parentTitle}</small></p>)}{more&&<p className="agent-note">仅显示前40项，请缩小查找范围。</p>}{error&&<p role="alert">{error}</p>}</details>;
}
