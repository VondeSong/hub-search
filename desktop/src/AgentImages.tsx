import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
export type ImageGrant={libraryId:string;documentId:string;sourceItemId:string;inputVersion:string;blobHash:string};
type Item={grant:ImageGrant;title:string;mime:string};
export type ImageChange={addImages:ImageGrant[];removeImages:ImageGrant[];clientMessageId:string};
const key=(g:ImageGrant)=>JSON.stringify(g);
export function AgentImages({current,disabled,onApply}:{current:ImageGrant[];disabled:boolean;onApply:(change:ImageChange)=>Promise<void>}){
 const [query,setQuery]=useState(""),[items,setItems]=useState<Item[]>([]),[selected,setSelected]=useState(current),[more,setMore]=useState(false),[loading,setLoading]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState("");
 const alive=useRef(true),ticket=useRef(0),identity=useRef<{signature:string;id:string}|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;ticket.current++;};},[]);
 useEffect(()=>{setSelected(current);identity.current=null;},[JSON.stringify(current)]);
 async function load(){const n=++ticket.current;setLoading(true);setError("");try{const v=await invoke<{images:Item[];hasMore:boolean}>("agent_investigation",{args:{action:"imageMaterials",query}});if(alive.current&&n===ticket.current){setItems(v.images);setMore(v.hasMore);}}catch(e){if(alive.current&&n===ticket.current)setError(String(e));}finally{if(alive.current&&n===ticket.current)setLoading(false);}}
 useEffect(()=>{void load();},[]);
 const addImages=selected.filter(g=>!current.some(c=>key(c)===key(g))),removeImages=current.filter(g=>!selected.some(c=>key(c)===key(g)));
 async function save(){const signature=JSON.stringify([addImages,removeImages]);if(identity.current?.signature!==signature)identity.current={signature,id:crypto.randomUUID()};setSaving(true);setError("");try{await onApply({addImages,removeImages,clientMessageId:identity.current.id});}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current)setSaving(false);}}
 const locked=disabled||saving;
 return <div className="agent-add-section">
  <strong>从资料库添加图片</strong><p className="agent-note">选择后显示在输入框上方，发送问题时供模型看图分析。最多 2 张 PNG、JPEG、WebP 缓存图片，每张不超过 256 KiB。较大的本地图片可用“添加图片或文件”自动压缩。</p>
  {selected.map(g=><div className="agent-material-selected" key={key(g)}><span>{items.find(i=>key(i.grant)===key(g))?.title||g.sourceItemId}</span><button type="button" disabled={locked} onClick={()=>setSelected(s=>s.filter(i=>key(i)!==key(g)))}>移除原图</button></div>)}
  <label>按图片标题查找<input type="search" value={query} maxLength={200} disabled={locked||loading} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Enter" && !e.nativeEvent.isComposing){e.preventDefault();e.stopPropagation();void load();}}}/></label>
  <button type="button" disabled={locked||loading} onClick={()=>void load()}>查找缓存图片</button>
  {loading&&<p role="status">正在查找图片…</p>}
  {!loading&&!error&&!items.length&&<p className="agent-note">没有找到缓存图片。可返回并用“添加图片或文件”选择本地图片。</p>}
  {items.map(item=>{const checked=selected.some(g=>key(g)===key(item.grant));return <label key={key(item.grant)} className="agent-material-choice"><input type="checkbox" checked={checked} disabled={locked||(!checked&&selected.length>=2)} onChange={e=>setSelected(s=>e.target.checked?[...s,item.grant]:s.filter(g=>key(g)!==key(item.grant)))}/><span><strong>{item.title}</strong><small>{item.mime} · {item.grant.libraryId}</small></span></label>;})}
  {more&&<p className="agent-note">仅展示前 40 项，请缩小标题范围。</p>}
  {!!removeImages.length&&<p className="agent-note">将撤回 {removeImages.length} 张原图授权，依赖它的旧回答将不可用。</p>}
  <button type="button" disabled={locked||(!addImages.length&&!removeImages.length)} onClick={()=>void save()}>添加到问题</button>
  {error&&<p role="alert">{error}</p>}
 </div>;
}
