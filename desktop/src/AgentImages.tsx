import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
export type ImageGrant={libraryId:string;documentId:string;sourceItemId:string;inputVersion:string;blobHash:string};
type Item={grant:ImageGrant;title:string;mime:string};
const key=(g:ImageGrant)=>JSON.stringify(g);
export function AgentImages({current,selected,disabled,onChange}:{current:ImageGrant[];selected:ImageGrant[];disabled:boolean;onChange:(images:ImageGrant[])=>void}){
 const [query,setQuery]=useState(""),[page,setPage]=useState(1),[items,setItems]=useState<Item[]>([]),[more,setMore]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState("");
 const alive=useRef(true),ticket=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 async function load(){const n=++ticket.current;setLoading(true);setError("");try{const v=await invoke<{images:Item[];hasMore:boolean}>("agent_investigation",{args:{action:"imageMaterials",query,page}});if(alive.current&&n===ticket.current){setItems(v.images);setMore(v.hasMore);}}catch(e){if(alive.current&&n===ticket.current)setError(String(e));}finally{if(alive.current&&n===ticket.current)setLoading(false);}}
 useEffect(()=>{void load();},[]);
 const removeImages=current.filter(g=>!selected.some(c=>key(c)===key(g)));
 return <div className="agent-add-section" data-material-focus>
  <p className="agent-note">按所属笔记或附件标题查找，最多选 8 项，每项不超过 4 MiB。发送后才授权模型读取。</p>
  <label>按笔记或附件标题查找<input type="search" value={query} maxLength={200} disabled={disabled} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter" && !e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();void load();}}}/></label>
  <label>PDF 页码<input type="number" min={1} max={10000} value={page} disabled={disabled||loading} onChange={e=>setPage(Math.max(1,Math.min(10000,Number(e.target.value)||1)))}/></label>
  <button type="button" disabled={disabled||loading} onClick={()=>void load()}>查找缓存图片</button>
  {selected.filter(grant=>!items.some(item=>key(item.grant)===key(grant))).map(grant=><div className="agent-material-selected" key={key(grant)}><span>{grant.sourceItemId}</span><button type="button" disabled={disabled} onClick={()=>onChange(selected.filter(item=>key(item)!==key(grant)))}>移除原图</button></div>)}
  {loading&&<p role="status">正在查找图片…</p>}
  {!loading&&!error&&!items.length&&<p className="agent-note">没有找到缓存图片。可返回并用“添加图片或文件”选择本地图片。</p>}
  {items.map(item=>{
    const itemKey=key(item.grant);
    const checked=selected.some(grant=>key(grant)===itemKey);
    const status=current.some(grant=>key(grant)===itemKey)?"已在本对话使用":"已缓存 · 可加入材料";
    return <label key={itemKey} className="agent-material-choice"><input type="checkbox" checked={checked} disabled={disabled||(!checked&&selected.length>=8)} onChange={event=>onChange(event.target.checked?[...selected,item.grant]:selected.filter(grant=>key(grant)!==itemKey))}/><span><strong>{item.title}</strong><small>{status}</small></span></label>;
  })}
  {more&&<p className="agent-note">仅展示前 40 项，请缩小标题范围。</p>}
  {!!removeImages.length&&<p className="agent-note">将撤回 {removeImages.length} 张原图授权，依赖它的旧回答将不可用。</p>}
  {error&&<p role="alert">{error}</p>}
 </div>;
}
