import {useEffect,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import type {LibrarySummary} from "./SearchTypes";

export type AgentLibrary = {id:string;name:string};
export const libraryDragType = "application/x-hub-agent-libraries";
export function readLibraryDrop(raw:string):AgentLibrary[] {
  if(raw.length>65536)throw Error("资料库范围过大");
  const values:unknown=JSON.parse(raw);
  if(!Array.isArray(values)||!values.length||values.length>256||values.some(v=>!v||typeof v.id!=="string"||!v.id.trim()||v.id!==v.id.trim()||v.id.length>1024||typeof v.name!=="string"||v.name.length>200))throw Error("无法识别资料库范围");
  return [...new Map(values.map(v=>[v.id,{id:v.id,name:v.name}])).values()];
}
export function AgentLibraryScope({selected,disabled,onChange}:{selected:AgentLibrary[];disabled:boolean;onChange:(items:AgentLibrary[])=>void}) {
  const [libraries,setLibraries]=useState<AgentLibrary[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  useEffect(()=>{let alive=true;void invoke<LibrarySummary[]>("list_libraries").then(items=>{if(!Array.isArray(items))throw Error("资料库列表不可用");if(alive)setLibraries(items);}).catch(e=>{if(alive)setError(String(e));}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};},[]);
  return <section className="agent-library-scope" aria-label="资料库授权范围">
    <strong>允许查找的资料库</strong>
    <p className="agent-note">可多选，也可拖入侧栏的库。随下一条问题生效，助手按需检索；不会一次读取整库。单独添加的页面继续保留。</p>
    {loading&&<p role="status">正在读取资料库…</p>}{error&&<p role="alert">{error}</p>}
    {!!libraries.length&&<label><input type="checkbox" disabled={disabled} checked={libraries.every(l=>selected.some(s=>s.id===l.id))} onChange={e=>onChange(e.target.checked?libraries:[])}/>全部资料库 · 当前 {libraries.length} 个</label>}
    <div>{libraries.map(l=><label key={l.id}><input type="checkbox" disabled={disabled} checked={selected.some(s=>s.id===l.id)} onChange={e=>onChange(e.target.checked?[...selected,l]:selected.filter(s=>s.id!==l.id))}/>{l.name}</label>)}</div>
    {!!selected.length&&<button type="button" disabled={disabled} onClick={()=>onChange([])}>清除库范围</button>}
    <small>仅包含当前选择的库；以后新增的库不会自动加入。附件仅包含已提取的文字，原图需单独添加。</small>
  </section>;
}
