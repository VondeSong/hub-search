import {invoke} from "@tauri-apps/api/core";
import {useEffect,useRef,useState} from "react";

export type Transcript={id:string;recordId:string;source:string;provider:string;binding:string;state:string;text:string;offset:number;replay?:boolean;error?:string;edited?:string;applied?:boolean;audioHash?:string;cancelPending?:boolean;model?:string;mode?:"file"|"realtime"};
type Provider={id:string;configured:boolean;model:string;fileModel?:string;fileMaxSeconds?:number};
export const speech=<T,>(request:Record<string,unknown>)=>invoke<T>("cloud_agents",{action:{op:"voice",request}});
export const transcriptEnded=(value:Transcript)=>["completed","failed","cancelled"].includes(value.state);
export const providerName=(id:string)=>id==="openai"?"OpenAI":"阿里";
export const queuedFile=(recordId:string,source:string,provider:string,binding:string):Transcript=>({
 id:crypto.randomUUID(),recordId,source,provider,binding,state:"queued",text:"",offset:0,replay:true,mode:"file",
});

export function useJournalTranscription({ready,recordId,sessions,onChange}:{ready:boolean;recordId:string;sessions:Transcript[];onChange:(value:Transcript)=>Promise<void>}) {
 const [providers,setProviders]=useState<Provider[]>([]),[connectionError,setConnectionError]=useState("");
 const [binding,setBinding]=useState("");
 const [connectionState,setConnectionState]=useState<"checking"|"missing"|"offline"|"ready">("checking"),[endpoint,setEndpoint]=useState("");
 const connectionGeneration=useRef(0);
 const latest=useRef({sessions,onChange,binding,recordId});latest.current={sessions,onChange,binding,recordId};
 const alive=useRef(true),working=useRef(new Set<string>()),halted=useRef(new Set<string>()),cancelled=useRef(new Set<string>()),cancelling=useRef(new Set<string>());
 const accepting=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const recheck=async()=>{
  const generation=++connectionGeneration.current;setConnectionState("checking");setConnectionError("");setProviders([]);
  try{
   const config=await invoke<{binding:string;endpoint?:string}|null>("cloud_agents",{action:{op:"config"}});
   if(!alive.current||generation!==connectionGeneration.current)return;
   setEndpoint(config?.endpoint||"");setBinding(config?.binding||"");
   if(!config){setConnectionState("missing");return;}
   const value=await speech<{providers:Provider[]}>({action:"providers"});
   if(!alive.current||generation!==connectionGeneration.current)return;
   setProviders(value.providers);setConnectionState("ready");
  }catch(e){if(alive.current&&generation===connectionGeneration.current){setConnectionState("offline");setConnectionError(String(e).replace(/^(?:Error:\s*)+/i,""));}}
 };
 useEffect(()=>{if(ready)void recheck();return()=>{connectionGeneration.current++;};},[ready]);
 const change=async(value:Transcript)=>{
  if(!alive.current||!accepting.current||value.recordId!==latest.current.recordId)return;
  const current=latest.current;
  latest.current={...current,sessions:current.sessions.some(s=>s.id===value.id)?current.sessions.map(s=>s.id===value.id?value:s):[...current.sessions,value]};
  await current.onChange(value);
 };
 const canContinue=(session:Transcript)=>alive.current&&accepting.current&&
  session.recordId===latest.current.recordId&&session.binding===latest.current.binding&&!cancelled.current.has(session.id);
 const requestCreation=(session:Transcript)=>{
   // The native action name is retained for installed Android clients.
   return speech<Transcript>({action:session.replay?"replay":"start",job:session.id,provider:session.provider,
    ...(session.replay?{hash:session.source}:{source:session.source})});
 };
 const create=async(session:Transcript)=>{
   if(session.replay&&!providers.some(p=>p.id===session.provider&&p.configured&&p.fileModel)){
    throw new Error("所选服务的文件转写尚未启用，请检查个人云端。");
   }
   const result=await requestCreation(session);
   if(canContinue(session))await change({...session,...result,error:undefined});
 };
 const syncCancel=async(session:Transcript)=>{
   if(session.binding!==latest.current.binding||cancelling.current.has(session.id))return;
   cancelling.current.add(session.id);
   try{
    await speech<Transcript>({action:"cancel",job:session.id});
    await change({...session,cancelPending:false});
    if(!session.replay)void invoke("quick_journal_voice",{action:"releaseChunks",token:session.source}).catch(()=>{});
   }catch{
    halted.current.add(session.id);
    await change({...session,error:"已停止本机转写，云端尚未确认。",cancelPending:true});
   }finally{cancelling.current.delete(session.id);}
 };
 const step=async(session:Transcript)=>{
   if(session.binding!==latest.current.binding){halted.current.add(session.id);await change({...session,error:"VPS 连接已改变。请切回原连接核对，或对保留的原音重新选择转写。"});return;}
   try {
    if(session.state==="queued"){await create(session);return;}
    // Always read the durable receipt before retrying an uncertain upload or creation.
    let current=await speech<Transcript>({action:"read",job:session.id});
    if(!canContinue(session))return;
    current={...session,...current};
    if(!current.replay&&current.state==="running"){
     const chunk=await invoke<{audio:string;next:number;total:number;closed:boolean}>("quick_journal_voice",{action:"chunk",token:session.source,offset:current.offset});
     if(!canContinue(session))return;
     if(chunk.audio)current={...current,...await speech<Transcript>({action:"append",job:session.id,offset:current.offset,audio:chunk.audio})};
     if(!canContinue(session))return;
     if(chunk.closed&&chunk.next===chunk.total&&!transcriptEnded(current))current={...current,...await speech<Transcript>({action:"finish",job:session.id,bytes:chunk.total})};
    }
    if(!canContinue(session))return;
    await change({...current,error:current.state==="failed"?current.error:undefined});
    if(!current.replay&&["finishing","completed","failed","cancelled"].includes(current.state))void invoke("quick_journal_voice",{action:"releaseChunks",token:session.source}).catch(()=>{});
   } catch(e) {
    if(!canContinue(session))return;
    halted.current.add(session.id);
    await change({...session,error:`${String(e)}。请先核对本轮结果，避免重复转写。`});
   }
 };
 const work=async(id:string,action:()=>Promise<void>)=>{
   if(working.current.has(id))return;
   working.current.add(id);
   try{await action();}finally{working.current.delete(id);}
 };
 const poll=async()=>{
   if(!accepting.current)return;
   await Promise.all(latest.current.sessions.filter(s=>!halted.current.has(s.id)).map(session=>{
    if(session.cancelPending)return syncCancel(session);
    if(!transcriptEnded(session)&&!cancelled.current.has(session.id))return work(session.id,()=>step(session));
   }));
 };
 useEffect(()=>{if(!ready||connectionState!=="ready"||!binding)return;const timer=setInterval(()=>{void poll().catch(e=>setConnectionError(String(e)));},600);return()=>clearInterval(timer);},[ready,binding,connectionState,providers]);
 const begin=async(provider:string,source:string,replay=false)=>{
   const target=binding;
   if(!target||!providers.some(p=>p.id===provider&&p.configured&&(!replay||p.fileModel)))throw new Error(connectionError||"所选转写服务尚未启用，原音仍保留。");
   const completed=latest.current.sessions.find(s=>(s.source===source||s.audioHash===source)&&s.provider===provider&&s.binding===target&&s.state==="completed");
   if(completed)return;
   const old=latest.current.sessions.find(s=>s.source===source&&s.provider===provider&&s.binding===target&&!transcriptEnded(s));
   if(old){await retry(old);return;}
   const session:Transcript=replay?queuedFile(latest.current.recordId,source,provider,target):{id:crypto.randomUUID(),recordId:latest.current.recordId,source,provider,binding:target,state:"connecting",text:"",offset:0,mode:"realtime"};
   await work(session.id,async()=>{
    await change(session);
    // A file request may finish on the VPS after the recording dialog closes.
    if(cancelled.current.has(session.id))return;
    try{await create(session);}
    catch(e){if(canContinue(session)){halted.current.add(session.id);await change({...session,error:`${String(e)}。请先核对本轮结果，避免重复转写。`});}}
   });
 };
 const retry=async(session:Transcript)=>{
  if(session.binding!==binding)throw new Error("请切回这段录音原来使用的 VPS 连接后核对。");
  halted.current.delete(session.id);
  if(session.cancelPending){await syncCancel(session);return;}
  if(transcriptEnded(session)||cancelled.current.has(session.id))return;
  await work(session.id,async()=>{
   await create(session);
   const current=latest.current.sessions.find(s=>s.id===session.id);
   if(current&&canContinue(current)&&!transcriptEnded(current))await step(current);
  });
 };
 const cancel=async(session:Transcript)=>{
   const current=latest.current.sessions.find(s=>s.id===session.id);
   if(!current||transcriptEnded(current))return;
   cancelled.current.add(current.id);
   halted.current.delete(current.id);
   const stopped={...current,state:"cancelled",error:undefined,cancelPending:true};
   await change(stopped);
   await syncCancel(stopped);
 };
 const submitQueued=(session:Transcript)=>{
  if(connectionState==="ready"&&canContinue(session))return work(session.id,()=>step(session));
 };
 return {providers,connectionError,connectionState,endpoint,recheck,binding,begin,retry,cancel,poll,submitQueued,suspend:()=>{accepting.current=false;},resume:()=>{accepting.current=true;}};
}

export function JournalTranscript({value,onChange,onApply,onRetry,onCancel}:{value:Transcript;onChange:(value:Transcript)=>void;onApply:()=>void;onRetry:()=>void;onCancel:()=>void}) {
 const done=transcriptEnded(value),text=value.edited??value.text;
 return <section className="journal-transcript" aria-label={`${providerName(value.provider)}识别文字`}>
  <header><strong>{providerName(value.provider)} · {value.mode==="file"||value.replay?"文件转写":"实时转写"}</strong><span role="status">{value.state==="completed"?"已完成":value.state==="failed"?"未完成":value.state==="cancelled"?"已停止":value.state==="queued"?"等待提交…":value.state==="finishing"?"正在整理文字…":value.state==="connecting"?"正在连接…":"正在识别…"}</span></header>
  {value.error&&<p role="alert">{value.error}</p>}
  <textarea aria-label={`${providerName(value.provider)}转写结果`} value={text} placeholder="识别文字会出现在这里；原音始终保留。" readOnly={!done||value.applied} onChange={e=>onChange({...value,edited:e.target.value})}/>
  <div className="journal-transcript-actions">{done?<>{value.cancelPending&&value.error&&<button type="button" onClick={onRetry}>重试云端停止</button>}<button type="button" disabled={!text.trim()||value.applied} onClick={onApply}>{value.applied?"已加入文字":"加入补充文字"}</button></>:<>{value.error&&<button type="button" onClick={onRetry}>核对并继续</button>}<button type="button" onClick={onCancel}>停止转写</button></>}</div>
 </section>;
}
