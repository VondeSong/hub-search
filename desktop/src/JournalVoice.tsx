import { invoke } from "@tauri-apps/api/core";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, Pause, Play, Plus, Square, X, Check } from "lucide-react";
import type { QuickJournalItem } from "./JournalRecords";
import { localJournalDate } from "./JournalViews";
import { QUICK_JOURNAL_UPDATED, openQuickJournalCapture } from "./QuickJournalEvents";
import { userProfileStorage } from "./UserProfileStorage";
import "./JournalVoice.css";
import {JournalTranscript,useJournalTranscription,type Transcript} from "./JournalTranscription";

const ConnectionSettings=lazy(()=>import("./CloudAgents"));
function VoiceConnectionSettings({onClose}:{onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);
 return createPortal(<dialog ref={ref} className="journal-voice-connection" aria-label="个人云端连接设置" onCancel={e=>{e.preventDefault();onClose();}}><Suspense fallback={<p role="status">正在打开连接设置…</p>}><ConnectionSettings initialSettings onClose={onClose}/></Suspense></dialog>,document.body);
}

type Record = QuickJournalItem["record"];
type Attachment = Record["attachments"][number];
export type VoiceRequest = { record?: Record; revision?: string; sourceDraft?: boolean };
type Draft = { record: Record; revision?: string; sourceDraft?: boolean; stagedTokens: string[]; transcripts?:Transcript[]; originalAudioHashes?:string[]; originalTranscriptIds?:string[]; dirty?:boolean };
type Status = {state:"idle"|"recording"|"paused"|"ready";elapsed:number;token:string;error?:string};
const eventName="hub:journal-voice";
export function openJournalVoice(request: VoiceRequest = {}) { window.dispatchEvent(new CustomEvent(eventName,{detail:request})); }
export const isJournalAudio=(name:string)=>/\.(m4a|mp3|wav|ogg|webm|aac)$/i.test(name);
export const audioTime=(seconds:number)=>`${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(Math.floor(seconds%60)).padStart(2,"0")}`;
const emptyDraft=():Draft=>({record:{version:1,id:crypto.randomUUID().replace(/-/g,""),date:localJournalDate(),text:"",attachments:[]},stagedTokens:[]});
const native=(action:string,token?:string)=>invoke<Status>("quick_journal_voice",{action,token});
let draftWrites:Promise<unknown>=Promise.resolve();

export function JournalCaptureButton({label="记一条",size=30}:{label?:string;size?:number}) {
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),origin=useRef({x:0,y:0}),fired=useRef(false);
  const cancel=()=>{clearTimeout(timer.current);timer.current=undefined;};
  useEffect(()=>cancel,[]);
  return <button type="button" aria-label={label} title="轻点写文字，长按进入录音" onPointerDown={e=>{
    if(e.button!==0)return;cancel();fired.current=false;origin.current={x:e.clientX,y:e.clientY};
    timer.current=setTimeout(()=>{fired.current=true;openJournalVoice();},500);
  }} onPointerMove={e=>{if(Math.hypot(e.clientX-origin.current.x,e.clientY-origin.current.y)>12)cancel();}} onPointerUp={cancel} onPointerCancel={cancel} onPointerLeave={cancel}
    onContextMenu={e=>e.preventDefault()} onKeyDown={e=>{if(e.key==="Enter"&&e.shiftKey){e.preventDefault();openJournalVoice();}}}
    onClick={()=>{if(fired.current){fired.current=false;return;}openQuickJournalCapture();}}><Plus size={size}/></button>;
}

export function JournalAudio({attachment,onContinue,label="语音记录"}:{attachment:Attachment;onContinue?:()=>void;label?:string}) {
  const ref=useRef<HTMLAudioElement>(null),objectUrl=useRef(""),mounted=useRef(true),[url,setUrl]=useState(""),[busy,setBusy]=useState(false),[playing,setPlaying]=useState(false),[error,setError]=useState("");
  const [duration,setDuration]=useState(Number(attachment.name.match(/语音-(\d+)秒/)?.[1]||0)),[position,setPosition]=useState(0);
  useEffect(()=>{
    mounted.current=true;const audio=ref.current;
    const hide=()=>{if(document.hidden)audio?.pause();};
    document.addEventListener("visibilitychange",hide);
    return()=>{mounted.current=false;document.removeEventListener("visibilitychange",hide);audio?.pause();audio?.removeAttribute("src");audio?.load();if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);};
  },[]);
  // Release media CSP allows blob URLs for local audio, but excludes data URLs.
  async function play(){try{setError("");if(!url){setBusy(true);const data=await invoke<string>("quick_journal_audio",{hash:attachment.hash});if(!mounted.current)return;const match=/^data:((?:audio\/[\w.+-]+|video\/(?:mp4|webm)));base64,([A-Za-z0-9+/=\r\n]+)$/.exec(data);if(!match)throw new Error("原音格式暂不支持");const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));objectUrl.current=URL.createObjectURL(new Blob([bytes],{type:match[1]}));setUrl(objectUrl.current);}else if(ref.current?.paused)await ref.current.play();else ref.current?.pause();}catch(e){setError(String(e));}finally{setBusy(false);}}
  useEffect(()=>{if(url)void ref.current?.play().catch(e=>setError(String(e)));},[url]);
  return <div className="journal-audio"><div className="journal-audio-row"><button type="button" className="journal-audio-play" aria-label={playing?"暂停原音":"播放原音"} disabled={busy} onClick={()=>void play()}>{playing?<Pause size={20}/>:<Play size={20}/>}</button><div className="journal-audio-track"><strong>{label}</strong><input aria-label="播放进度" type="range" min={0} max={duration||1} step={0.1} value={position} disabled={!url} onChange={e=>{if(ref.current){ref.current.currentTime=Number(e.target.value);setPosition(Number(e.target.value));}}}/><small>{busy?"读取原音…":`${audioTime(position)} / ${audioTime(duration)}`}</small></div>{onContinue&&<button type="button" className="journal-audio-continue" onClick={onContinue}><Mic size={16}/><span>继续录入</span></button>}</div><audio ref={ref} src={url||undefined} preload="none" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onDurationChange={()=>{if(Number.isFinite(ref.current?.duration))setDuration(ref.current!.duration);}} onTimeUpdate={()=>setPosition(ref.current?.currentTime||0)}/>{error&&<p role="alert">{error}</p>}</div>;
}

export function JournalVoiceHost({onOpen}:{onOpen:()=>void}) {
  const [request,setRequest]=useState<VoiceRequest|null>(null),callback=useRef(onOpen);callback.current=onOpen;
  useEffect(()=>{const open=(e:Event)=>{callback.current();setRequest((e as CustomEvent<VoiceRequest>).detail||{});};window.addEventListener(eventName,open);return()=>window.removeEventListener(eventName,open);},[]);
  return request&&<JournalVoiceCapture request={request} onClose={()=>setRequest(null)}/>;
}

export function JournalVoiceCapture({request,onClose}:{request:VoiceRequest;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null),latest=useRef<Draft>(emptyDraft()),busyRef=useRef(false),alive=useRef(true);
  const [draft,setDraft]=useState(latest.current),[status,setStatus]=useState<Status>({state:"idle",elapsed:0,token:""}),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [connectionOpen,setConnectionOpen]=useState(false),[restored,setRestored]=useState(false);
  const [provider,setProvider]=useState(()=>userProfileStorage.getItem("hub.voice.provider")||"aliyun");
  const persist=async(value:Draft)=>{
    latest.current=value;setDraft(value);
    draftWrites=draftWrites.catch(()=>{}).then(()=>invoke("quick_journal_voice_draft",{value:JSON.stringify(value)}));
    await draftWrites;
  };
  const updateTranscript=async(value:Transcript)=>{
    const current=latest.current,items=current.transcripts||[],old=items.find(s=>s.id===value.id);
    await persist({...current,dirty:true,transcripts:old?items.map(s=>s.id===value.id?{...value,edited:old.edited,applied:old.applied}:s):[...items,value]});
  };
  const transcription=useJournalTranscription({ready,recordId:draft.record.id,sessions:draft.transcripts||[],onChange:updateTranscript});
  useEffect(()=>{alive.current=true;ref.current?.showModal();void (async()=>{
    await draftWrites.catch(()=>{});
    const [raw,current]=await Promise.all([invoke<string>("quick_journal_voice_draft"),native("status")]);
    if(!alive.current)return;
    let value=raw?JSON.parse(raw) as Draft:emptyDraft();
    let hasDraft=Boolean(raw&&(value.record.text.trim()||value.record.attachments.length||current.state!=="idle"));
    if(raw&&value.revision&&value.dirty===false&&current.state==="idle"){value=emptyDraft();hasDraft=false;}
    if(raw&&value.revision&&value.dirty===undefined)value.dirty=true;
    if(raw&&request.record&&value.record.id!==request.record.id&&(value.record.text.trim()||value.record.attachments.length||current.state!=="idle")){setNotice("先恢复上次未保存的语音草稿；保存后可返回目标记录继续录入。");}
    else if(request.record&&(!raw||(!value.record.text.trim()&&!value.record.attachments.length&&current.state==="idle"))){
      const archived=await invoke<string>("quick_journal_voice_draft",{recordId:request.record.id});
      const transcripts:Transcript[]=archived?JSON.parse(archived):[];
      value={record:structuredClone(request.record),revision:request.revision,sourceDraft:request.sourceDraft,stagedTokens:[],transcripts,dirty:false,originalAudioHashes:request.revision?request.record.attachments.filter(a=>isJournalAudio(a.name)).map(a=>a.hash):[],originalTranscriptIds:request.revision?transcripts.map(s=>s.id):[]};
    }
    if(hasDraft)setRestored(true);
    if(value.revision&&!value.originalAudioHashes){
      const saved=await invoke<{items:QuickJournalItem[]}>("list_quick_journal");
      value.originalAudioHashes=saved.items.find(i=>i.record.id===value.record.id)?.record.attachments.filter(a=>isJournalAudio(a.name)).map(a=>a.hash)||[];
      value.originalTranscriptIds=(value.transcripts||[]).filter(s=>value.originalAudioHashes!.includes(s.audioHash||s.source)).map(s=>s.id);
    }
    await persist(value);setStatus(current);setReady(true);
  })().catch(e=>{if(alive.current)setError(String(e));});
    const timer=setInterval(()=>{if(!busyRef.current)void native("status").then(s=>{if(alive.current)setStatus(s);}).catch(()=>{});},800);
    return()=>{alive.current=false;clearInterval(timer);ref.current?.close();};
  },[]);
  const run=async(action:()=>Promise<void>)=>{if(busyRef.current)return;busyRef.current=true;setBusy(true);setError("");try{await action();}catch(e){setError(String(e));}finally{busyRef.current=false;if(alive.current)setBusy(false);}};
  const stage=async()=>{
    const current=await native("stop");setStatus(current);
    if(current.state!=="ready")return;
    let value=latest.current;
    if(!value.stagedTokens.includes(current.token)){
      if(value.record.attachments.length>=9)throw new Error("当前记录已有9个附件，原音已保留。请先整理附件后重试。");
      const a=await invoke<Attachment>("quick_journal_voice",{action:"read",token:current.token});
      value={...value,dirty:true,record:{...value.record,attachments:[...value.record.attachments,a]},stagedTokens:[...value.stagedTokens,current.token],transcripts:value.transcripts?.map(s=>s.source===current.token?{...s,audioHash:a.hash}:s)};
    }
    await persist(value);
    setStatus(await native("acknowledge",current.token));
    await transcription.flush();
    if(!(latest.current.transcripts||[]).some(s=>s.source===current.token&&["connecting","running","sending"].includes(s.state)))void native("releaseChunks",current.token).catch(()=>{});
  };
  const finish=()=>run(async()=>{await stage();setNotice("原音已保留，可以回听、补充文字或继续录入。");});
  const leave=()=>void run(async()=>{await stage();transcription.suspend();await draftWrites;if(latest.current.revision&&latest.current.dirty===false)await invoke("quick_journal_voice_draft",{value:""});onClose();});
  async function save(startNew=false){await run(async()=>{
    await stage();await draftWrites;
    const value=latest.current;if(!value.record.text.trim()&&!value.record.attachments.length)throw new Error("请先录一段声音或写下文字。");
    if(value.revision){const receipt=await invoke<{revision:string}>("update_quick_journal",{id:value.record.id,expectedRevision:value.revision,record:value.record,deleted:false});await persist({...value,revision:receipt.revision});}
    else await invoke("capture_quick_journal",{record:value.record});
    window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));
    // Once a record is durable, a cleanup failure must not retry it with a new identity.
    const items=await invoke<{items:QuickJournalItem[]}>("list_quick_journal");
    const saved=items.items.find(i=>i.record.id===value.record.id);
    if(saved?.revision)await persist({...value,revision:saved.revision});
    if(value.sourceDraft){const raw=await invoke<string>("get_quick_journal_draft");if(raw&&JSON.parse(raw).id===value.record.id)await invoke("save_quick_journal_draft",{draft:""});}
    transcription.suspend();await draftWrites;
    await invoke("quick_journal_voice_draft",{value:""});
    if(startNew){await persist(emptyDraft());setRestored(false);setStatus({state:"idle",elapsed:0,token:""});setNotice("上一条已保存，可以开始新的记录。");transcription.resume();}
    else onClose();
  });}
  const canTranscribe=transcription.connectionState==="ready"&&transcription.providers.some(p=>p.id===provider&&p.configured);
  const connectionLabel=transcription.connectionState==="checking"?"检查中":transcription.connectionState==="missing"?"未连接云端":transcription.connectionState==="offline"?"云端暂不可用":canTranscribe?"可转写":"云端未配置此服务";
  const transcribing=canTranscribe&&Boolean(draft.transcripts?.some(s=>s.source===status.token&&!s.error&&["connecting","running","sending","finishing"].includes(s.state)));
  const active=status.state==="recording"||status.state==="paused";
  const audio=draft.record.attachments.filter(a=>isJournalAudio(a.name));
  const historical=audio.filter(a=>draft.originalAudioHashes?.includes(a.hash));
  const added=audio.filter(a=>!draft.originalAudioHashes?.includes(a.hash));
  const previousText=(draft.transcripts||[]).filter(s=>draft.originalTranscriptIds?.includes(s.id)&&!audio.some(a=>s.audioHash===a.hash||s.source===a.hash));
  const transcript=(value:Transcript)=><JournalTranscript key={value.id} value={value} onChange={next=>{void persist({...latest.current,dirty:true,transcripts:latest.current.transcripts?.map(s=>s.id===next.id?next:s)}).catch(e=>setError(String(e)));}} onApply={()=>void run(async()=>{const current=latest.current,session=current.transcripts?.find(s=>s.id===value.id);if(!session||session.applied)return;const text=session.edited??session.text;await persist({...current,dirty:true,record:{...current.record,text:[current.record.text,text].filter(Boolean).join("\n\n")},transcripts:current.transcripts?.map(s=>s.id===session.id?{...s,applied:true}:s)});})} onRetry={()=>void run(()=>transcription.retry(value))} onCancel={()=>void run(()=>transcription.cancel(value))}/>;
  const segment=(a:Attachment,i:number,old=false)=>{
    const sessions=(draft.transcripts||[]).filter(s=>s.audioHash===a.hash||s.source===a.hash);
    const completed=sessions.some(s=>s.provider===provider&&s.state==="completed");
    return <div className="journal-voice-segment" key={`${a.hash}-${i}`}><JournalAudio attachment={a} label={`${old?"原录音":"第"}${i+1}${old?"":"段录音"}`}/>{!completed&&<button type="button" className="journal-voice-replay" disabled={busy||active||!canTranscribe} onClick={()=>void run(()=>transcription.begin(provider,a.hash,true))}>用{provider==="openai"?"OpenAI":"阿里"}补转写</button>}{sessions.length>0&&<details className="journal-voice-transcript-details" open={!old&&sessions.some(s=>!s.applied)}><summary>转写文字{completed?" · 已完成":""}</summary>{sessions.map(transcript)}</details>}</div>;
  };
  return <>{connectionOpen&&<VoiceConnectionSettings onClose={()=>{setConnectionOpen(false);void transcription.recheck();}}/>}{createPortal(<dialog ref={ref} className="journal-voice-dialog" aria-label="语音速记" onCancel={e=>{e.preventDefault();leave();}}><header><div><h2>{draft.revision?"追加录音":"语音速记"}</h2><span>{draft.record.date} · {draft.revision?"补充到原记录":"原音保留在本机"}</span></div><button type="button" aria-label="保留语音草稿并关闭" disabled={busy} onClick={leave}><X size={22}/></button></header><div className="journal-voice-body">
    {restored&&<p className="journal-voice-restored" role="status">已恢复上次未保存的语音草稿。保存后再打开会新建一条。</p>}
    <div className="journal-voice-service"><Mic size={17}/><span>录音与转写</span><select aria-label="转写服务" value={provider} disabled={active||busy} onChange={e=>{try{userProfileStorage.setItem("hub.voice.provider",e.target.value);setProvider(e.target.value);}catch(err){setError(String(err));}}}><option value="aliyun">阿里</option><option value="openai">OpenAI</option></select><small role="status">{connectionLabel}</small></div>
    <section className="journal-voice-connection-status"><p>{canTranscribe?"已连接个人云端，可使用所选服务转写。":"可先录音并保存原音，连接恢复后再补转写。"}</p><div><button type="button" disabled={active||busy||transcription.connectionState==="checking"} onClick={()=>void transcription.recheck()}>重新检查</button><button type="button" disabled={active||busy} onClick={()=>setConnectionOpen(true)}>连接设置</button></div><details><summary>服务密钥在哪里设置？</summary><p>阿里和 OpenAI 的服务密钥由个人云端管理，手机不用重复填写。这里复用助手的云端地址和设备密钥；设备密钥与供应商 API 密钥不同。</p>{transcription.endpoint&&<p>当前地址：{transcription.endpoint}</p>}{transcription.connectionError&&<p>连接信息：{transcription.connectionError}</p>}</details></section>
    <div className={`journal-voice-clock ${active?"is-active":""}`}><span>{status.state==="recording"?(transcribing?"正在录音并转写":"正在仅录音"):status.state==="paused"?"已暂停":status.state==="ready"?"原音待加入草稿":"准备好就开始"}</span><strong>{audioTime(status.elapsed/1000)}</strong><p>{active?(transcribing?"原音保留在本机，识别文字可校对。":"原音保留在本机，连接后可补转写。"):"轻点开始录音；完成后可回听、校对并保存。"}</p></div>
    <div className="journal-voice-controls">{active?<><button type="button" disabled={busy} onClick={()=>void run(async()=>setStatus(await native(status.state==="paused"?"resume":"pause")))}>{status.state==="paused"?<Play size={23}/>:<Pause size={23}/>}<span>{status.state==="paused"?"继续录音":"暂停"}</span></button><button type="button" className="voice-stop" disabled={busy} onClick={()=>void finish()}><Square size={20}/><span>完成本段</span></button></>:<button type="button" className="voice-start" disabled={busy||!ready} onClick={()=>void run(async()=>{if(status.state==="ready")await stage();if(latest.current.record.attachments.length>=9)throw new Error("每条最多9个附件，请先保存当前记录。");const current=await native("start");setStatus(current);setNotice("");if(current.state==="recording"){if(canTranscribe)await transcription.begin(provider,current.token);else setNotice("正在仅录音。完成后可保存原音，连接恢复后再补转写。");}})}><Mic size={27}/><span>{status.state==="ready"?"保留原音并继续":draft.record.attachments.length?"再录一段":"开始录音"}</span></button>}</div>
    {(error||status.error)&&<p className="journal-voice-error" role="alert">{error||status.error}</p>}{status.state==="ready"&&error&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{setStatus(await native("acknowledge",status.token));setNotice("原文件已归档保留，可以重新录音。");})}>保留异常原文件并重新录音</button>}{notice&&<p className="journal-voice-notice" role="status">{notice}</p>}
    {(historical.length>0||previousText.length>0)&&<details className="journal-voice-history"><summary>原记录 · {historical.length?`${historical.length} 段录音`:"转写文字"}</summary><p>补录会新增独立音频，原音与原文字保留。</p>{historical.map((a,i)=>segment(a,i,true))}{previousText.map(transcript)}</details>}
    {added.length>0&&<section className="journal-voice-segments" aria-label="本次录音"><h3>{draft.revision?"本次新增":"当前草稿"} · {added.length} 段录音</h3>{added.map((a,i)=>segment(a,i))}</section>}
    {draft.transcripts?.filter(s=>!audio.some(a=>s.audioHash===a.hash||s.source===a.hash)&&!draft.originalTranscriptIds?.includes(s.id)).map(transcript)}
    <label className="journal-voice-text">补充文字<textarea aria-label="录音补充文字" value={draft.record.text} placeholder="记下要点，或稍后再补充…" disabled={!ready||busy} onChange={e=>{void persist({...latest.current,dirty:true,record:{...latest.current.record,text:e.target.value}}).catch(err=>setError(String(err)));}}/></label>
    <p className="journal-voice-boundary">{canTranscribe?"转写时，录音经个人云端发送给所选服务。识别文字需确认后才加入正文。":"当前仅保存本机原音；连接并选择补转写后，才会发送录音进行识别。"} 离开应用会结束并保留本段。</p>
    </div><footer>{restored&&<button type="button" disabled={!ready||busy||active} onClick={()=>void save(true)}>保存并新建</button>}<button type="button" disabled={!ready||busy||active} className="voice-save" onClick={()=>void save()}><Check size={18}/>保存</button></footer></dialog>,document.body)}</>;
}
