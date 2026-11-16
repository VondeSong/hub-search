import {invoke} from "@tauri-apps/api/core";
import {useEffect,useRef,useState} from "react";

export type Transcript={id:string;recordId:string;source:string;provider:string;binding:string;state:string;text:string;offset:number;replay?:boolean;error?:string;edited?:string;applied?:boolean;audioHash?:string};
type Provider={id:string;configured:boolean;model:string};
export const speech=<T,>(request:Record<string,unknown>)=>invoke<T>("cloud_agents",{action:{op:"voice",request}});
const ended=(value:Transcript)=>["completed","failed","cancelled"].includes(value.state);
export const providerName=(id:string)=>id==="openai"?"OpenAI":"阿里";

export function useJournalTranscription({ready,recordId,sessions,onChange}:{ready:boolean;recordId:string;sessions:Transcript[];onChange:(value:Transcript)=>Promise<void>}) {
 const [providers,setProviders]=useState<Provider[]>([]),[connectionError,setConnectionError]=useState("");
 const [binding,setBinding]=useState("");
 const latest=useRef({sessions,onChange,binding,recordId});latest.current={sessions,onChange,binding,recordId};
 const alive=useRef(true),working=useRef<Promise<void>|null>(null),halted=useRef(new Set<string>()),creating=useRef(new Set<string>());
 const accepting=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 useEffect(()=>{if(!ready)return;let cancelled=false;void (async()=>{
   const config=await invoke<{binding:string}|null>("cloud_agents",{action:{op:"config"}});
   if(!config)throw new Error("在 Agents 连接你的 VPS 后即可转写；现在仍可录音和回听。");
   const value=await speech<{providers:Provider[]}>({action:"providers"});
   if(!cancelled){setBinding(config.binding);setProviders(value.providers);setConnectionError("");}
  })().catch(e=>{if(!cancelled)setConnectionError(String(e));});return()=>{cancelled=true;};},[ready]);
 const change=async(value:Transcript)=>{
  if(!alive.current||!accepting.current||value.recordId!==latest.current.recordId)return;
  const current=latest.current;
  latest.current={...current,sessions:current.sessions.some(s=>s.id===value.id)?current.sessions.map(s=>s.id===value.id?value:s):[...current.sessions,value]};
  await current.onChange(value);
 };
 const step=async(session:Transcript)=>{
   if(session.binding!==latest.current.binding){halted.current.add(session.id);await change({...session,error:"VPS 连接已改变。请切回原连接核对，或对保留的原音重新选择转写。"});return;}
   try {
    // Always read the durable receipt before retrying an uncertain upload or creation.
    let current=await speech<Transcript>({action:"read",job:session.id});
    current={...session,...current};
    if(!current.replay&&current.state==="running"){
     const chunk=await invoke<{audio:string;next:number;total:number;closed:boolean}>("quick_journal_voice",{action:"chunk",token:session.source,offset:current.offset});
     if(chunk.audio)current={...current,...await speech<Transcript>({action:"append",job:session.id,offset:current.offset,audio:chunk.audio})};
     if(chunk.closed&&chunk.next===chunk.total&&!ended(current))current={...current,...await speech<Transcript>({action:"finish",job:session.id,bytes:chunk.total})};
    }
    await change({...current,error:current.state==="failed"?current.error:undefined});
    if(!current.replay&&["finishing","completed","failed","cancelled"].includes(current.state))void invoke("quick_journal_voice",{action:"releaseChunks",token:session.source}).catch(()=>{});
   } catch(e) {halted.current.add(session.id);await change({...session,error:String(e)});}
 };
 const pump=async()=>{
   if(!accepting.current)return;
   if(working.current){await working.current;return;}
   const job=(async()=>{for(const session of latest.current.sessions){if(!ended(session)&&!halted.current.has(session.id)&&!creating.current.has(session.id))await step(session);}})();
   working.current=job;try{await job;}finally{working.current=null;}
 };
 useEffect(()=>{if(!ready||!binding)return;const timer=setInterval(()=>{void pump().catch(e=>setConnectionError(String(e)));},600);return()=>clearInterval(timer);},[ready,binding]);
 const begin=async(provider:string,source:string,replay=false)=>{
   if(!binding||!providers.some(p=>p.id===provider&&p.configured))throw new Error(connectionError||"所选转写服务尚未配置；原音仍可保留。");
   const completed=latest.current.sessions.find(s=>(s.source===source||s.audioHash===source)&&s.provider===provider&&s.binding===binding&&s.state==="completed");
   if(completed)return;
   const old=latest.current.sessions.find(s=>s.source===source&&s.provider===provider&&s.binding===binding&&!ended(s));
   if(old){halted.current.delete(old.id);await pump();return;}
   const session:Transcript={id:crypto.randomUUID(),recordId:latest.current.recordId,source,provider,binding,state:"connecting",text:"",offset:0,replay};
   creating.current.add(session.id);
   await change(session);
   try{const current=await speech<Transcript>({action:replay?"replay":"start",job:session.id,provider,...(replay?{hash:source}:{source})});await change({...session,...current});}
   catch(e){halted.current.add(session.id);await change({...session,error:`${String(e)}。请先核对本轮结果，避免重复转写。`});}
   finally{creating.current.delete(session.id);}
 };
 const retry=async(session:Transcript)=>{
  if(session.binding!==binding)throw new Error("请切回这段录音原来使用的 VPS 连接后核对。");
  const current=await speech<Transcript>({action:session.replay?"replay":"start",job:session.id,provider:session.provider,...(session.replay?{hash:session.source}:{source:session.source})});
  await change({...session,...current});halted.current.delete(session.id);await step({...session,...current});
 };
 const cancel=async(session:Transcript)=>{const result=await speech<Transcript>({action:"cancel",job:session.id});await change({...session,...result});halted.current.delete(session.id);};
 const flush=async()=>{
   await pump();
   const deadline=Date.now()+10000;
   while(Date.now()<deadline&&latest.current.sessions.some(s=>!s.replay&&["running","connecting"].includes(s.state)&&!halted.current.has(s.id))){await new Promise(resolve=>setTimeout(resolve,150));await pump();}
 };
 return {providers,connectionError,binding,begin,retry,cancel,flush,suspend:()=>{accepting.current=false;},resume:()=>{accepting.current=true;}};
}

export function JournalTranscript({value,onChange,onApply,onRetry,onCancel}:{value:Transcript;onChange:(value:Transcript)=>void;onApply:()=>void;onRetry:()=>void;onCancel:()=>void}) {
 const done=ended(value),text=value.edited??value.text;
 return <section className="journal-transcript" aria-label={`${providerName(value.provider)}识别文字`}>
  <header><strong>{providerName(value.provider)} · 识别文字</strong><span role="status">{value.state==="completed"?"已完成":value.state==="failed"?"未完成":value.state==="cancelled"?"已停止":value.state==="finishing"?"正在整理文字…":value.state==="connecting"?"正在连接…":"正在识别…"}</span></header>
  {value.error&&<p role="alert">{value.error}</p>}
  <textarea aria-label={`${providerName(value.provider)}转写结果`} value={text} placeholder="识别文字会出现在这里；原音始终保留。" readOnly={!done||value.applied} onChange={e=>onChange({...value,edited:e.target.value})}/>
  <div className="journal-transcript-actions">{done?<button type="button" disabled={!text.trim()||value.applied} onClick={onApply}>{value.applied?"已加入文字":"加入补充文字"}</button>:<><button type="button" onClick={onRetry}>核对并继续</button><button type="button" onClick={onCancel}>停止转写</button></>}</div>
 </section>;
}
