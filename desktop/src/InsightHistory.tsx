import {useEffect,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import {invoke} from "@tauri-apps/api/core";
import type {InsightEvent} from "./InsightTypes";
import "./StageReview.css";
type Event=InsightEvent&{insightId:string;text?:string;cursor:number};
export function InsightHistory({onOpen,query,label}:{onOpen:(id:string)=>void;query:string;label:(event:InsightEvent)=>string}){
 const [rows,setRows]=useState<Event[]>([]),[before,setBefore]=useState<number|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");const alive=useRef(true),locked=useRef(false);
 async function load(cursor?:number){if(locked.current)return;locked.current=true;setBusy(true);setError("");try{const result=await invoke<{items:Event[];nextBefore:number|null}>("agent_investigation",{args:{action:"insightHistory",before:cursor}});if(alive.current){setRows(old=>cursor?[...old,...result.items.filter(v=>!old.some(o=>o.id===v.id))]:result.items);setBefore(result.nextBefore);}}catch(e){if(alive.current)setError(String(e));}finally{locked.current=false;if(alive.current)setBusy(false);}}
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[]);
 return <div className="stage-review-scroll"><article className="stage-review-article"><div className="stage-review-eyebrow">每个处理，都有来处</div><h1>处理记录</h1><p className="stage-review-deck">保留内容修订、反馈与处理状态。返回发现后仍按当前权限核对。</p>{error&&<p role="alert">{error}</p>}{rows.filter(e=>!query.trim()||(!e.restricted&&`${e.text??""} ${e.body?.text??""} ${label(e)}`.includes(query.trim()))).map(e=><section className="stage-review-section" key={e.id}><small>{new Date(e.createdAt).toLocaleString("zh-CN")}</small><h2>{e.restricted?"该修订当前不可访问":label(e)}</h2>{!e.restricted&&<p><ReactMarkdown skipHtml allowedElements={["strong","em","code","br"]} unwrapDisallowed>{e.body?.text??e.text}</ReactMarkdown></p>}<button type="button" onClick={()=>onOpen(e.insightId)}>返回发现</button></section>)}{!rows.length&&!busy&&<p>尚无处理记录。</p>}{busy&&<p role="status">正在读取记录…</p>}{before!=null&&<button type="button" disabled={busy} onClick={()=>void load(before)}>更早的处理记录</button>}</article></div>;
}
