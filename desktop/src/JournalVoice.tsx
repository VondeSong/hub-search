import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, Pause, Play, Plus, Square, X, Check, ChevronRight } from "lucide-react";
import type { QuickJournalItem } from "./JournalRecords";
import { localJournalDate } from "./JournalViews";
import { QUICK_JOURNAL_UPDATED, openQuickJournalCapture } from "./QuickJournalEvents";
import { userProfileStorage } from "./UserProfileStorage";
import "./JournalVoice.css";

type Record = QuickJournalItem["record"];
type Attachment = Record["attachments"][number];
export type VoiceRequest = { record?: Record; revision?: string; sourceDraft?: boolean };
type Draft = { record: Record; revision?: string; sourceDraft?: boolean; stagedTokens: string[] };
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

export function JournalAudio({attachment,onContinue}:{attachment:Attachment;onContinue?:()=>void}) {
  const ref=useRef<HTMLAudioElement>(null),[url,setUrl]=useState(""),[busy,setBusy]=useState(false),[playing,setPlaying]=useState(false),[error,setError]=useState("");
  const [duration,setDuration]=useState(Number(attachment.name.match(/语音-(\d+)秒/)?.[1]||0)),[position,setPosition]=useState(0);
  useEffect(()=>{
    const audio=ref.current;
    const hide=()=>{if(document.hidden)audio?.pause();};
    document.addEventListener("visibilitychange",hide);
    return()=>{document.removeEventListener("visibilitychange",hide);audio?.pause();audio?.removeAttribute("src");audio?.load();};
  },[]);
  async function play(){try{setError("");if(!url){setBusy(true);const data=await invoke<string>("quick_journal_audio",{hash:attachment.hash});setUrl(data);}else if(ref.current?.paused)await ref.current.play();else ref.current?.pause();}catch(e){setError(String(e));}finally{setBusy(false);}}
  useEffect(()=>{if(url)void ref.current?.play().catch(e=>setError(String(e)));},[url]);
  return <div className="journal-audio"><div className="journal-audio-row"><button type="button" className="journal-audio-play" aria-label={playing?"暂停原音":"播放原音"} disabled={busy} onClick={()=>void play()}>{playing?<Pause size={20}/>:<Play size={20}/>}</button><div className="journal-audio-track"><strong>语音记录</strong><input aria-label="播放进度" type="range" min={0} max={duration||1} step={0.1} value={position} disabled={!url} onChange={e=>{if(ref.current){ref.current.currentTime=Number(e.target.value);setPosition(Number(e.target.value));}}}/><small>{busy?"读取原音…":`${audioTime(position)} / ${audioTime(duration)}`}</small></div>{onContinue&&<button type="button" className="journal-audio-continue" onClick={onContinue}><Mic size={16}/><span>继续录入</span></button>}</div><audio ref={ref} src={url||undefined} preload="none" onPlay={()=>setPlaying(true)} onPause={()=>setPlaying(false)} onEnded={()=>setPlaying(false)} onDurationChange={()=>{if(Number.isFinite(ref.current?.duration))setDuration(ref.current!.duration);}} onTimeUpdate={()=>setPosition(ref.current?.currentTime||0)}/>{error&&<p role="alert">{error}</p>}</div>;
}

export function JournalVoiceHost({onOpen}:{onOpen:()=>void}) {
  const [request,setRequest]=useState<VoiceRequest|null>(null),callback=useRef(onOpen);callback.current=onOpen;
  useEffect(()=>{const open=(e:Event)=>{callback.current();setRequest((e as CustomEvent<VoiceRequest>).detail||{});};window.addEventListener(eventName,open);return()=>window.removeEventListener(eventName,open);},[]);
  return request&&<JournalVoiceCapture request={request} onClose={()=>setRequest(null)}/>;
}

export function JournalVoiceCapture({request,onClose}:{request:VoiceRequest;onClose:()=>void}) {
  const ref=useRef<HTMLDialogElement>(null),latest=useRef<Draft>(emptyDraft()),busyRef=useRef(false),alive=useRef(true);
  const [draft,setDraft]=useState(latest.current),[status,setStatus]=useState<Status>({state:"idle",elapsed:0,token:""}),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const [provider,setProvider]=useState(()=>userProfileStorage.getItem("hub.voice.provider")||"aliyun");
  const persist=async(value:Draft)=>{
    latest.current=value;setDraft(value);
    draftWrites=draftWrites.catch(()=>{}).then(()=>invoke("quick_journal_voice_draft",{value:JSON.stringify(value)}));
    await draftWrites;
  };
  useEffect(()=>{alive.current=true;ref.current?.showModal();void (async()=>{
    await draftWrites.catch(()=>{});
    const [raw,current]=await Promise.all([invoke<string>("quick_journal_voice_draft"),native("status")]);
    if(!alive.current)return;
    let value=raw?JSON.parse(raw) as Draft:emptyDraft();
    if(raw&&request.record&&value.record.id!==request.record.id&&(value.record.text.trim()||value.record.attachments.length||current.state!=="idle")){setNotice("先恢复上次未保存的语音草稿；保存后可返回目标记录继续录入。");}
    else if(request.record&&(!raw||(!value.record.text.trim()&&!value.record.attachments.length&&current.state==="idle")))value={record:structuredClone(request.record),revision:request.revision,sourceDraft:request.sourceDraft,stagedTokens:[]};
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
      value={...value,record:{...value.record,attachments:[...value.record.attachments,a]},stagedTokens:[...value.stagedTokens,current.token]};
    }
    await persist(value);
    setStatus(await native("acknowledge",current.token));
  };
  const finish=()=>run(async()=>{await stage();setNotice("原音已保留，可以回听、补充文字或继续录入。");});
  const leave=()=>void run(async()=>{await stage();await draftWrites;onClose();});
  async function save(next:boolean){await run(async()=>{
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
    await invoke("quick_journal_voice_draft",{value:""});
    if(next){await persist(emptyDraft());setStatus({state:"idle",elapsed:0,token:""});setNotice("上一条已保存。点麦克风，继续录下一条。");}
    else onClose();
  });}
  const active=status.state==="recording"||status.state==="paused";
  return createPortal(<dialog ref={ref} className="journal-voice-dialog" aria-label="语音速记" onCancel={e=>{e.preventDefault();leave();}}><header><div><h2>{draft.revision?"继续录入":"语音速记"}</h2><span>{draft.record.date} · 原音保留在本机</span></div><button type="button" aria-label="保留语音草稿并关闭" disabled={busy} onClick={leave}><X size={22}/></button></header><div className="journal-voice-body">
    <div className="journal-voice-service"><Mic size={17}/><span>实时转写</span><select aria-label="转写服务" value={provider} disabled={active||busy} onChange={e=>{try{userProfileStorage.setItem("hub.voice.provider",e.target.value);setProvider(e.target.value);}catch(err){setError(String(err));}}}><option value="aliyun">阿里</option><option value="openai">OpenAI</option></select><small>尚未连接</small></div>
    <div className={`journal-voice-clock ${active?"is-active":""}`}><span>{status.state==="recording"?"正在录音":status.state==="paused"?"已暂停":status.state==="ready"?"原音待加入草稿":"准备好就开始"}</span><strong>{audioTime(status.elapsed/1000)}</strong><p>{active?"说下来，之后再慢慢整理。":"长按＋，也能直接进入录音。"}</p></div>
    <div className="journal-voice-controls">{active?<><button type="button" disabled={busy} onClick={()=>void run(async()=>setStatus(await native(status.state==="paused"?"resume":"pause")))}>{status.state==="paused"?<Play size={23}/>:<Pause size={23}/>}<span>{status.state==="paused"?"继续录音":"暂停"}</span></button><button type="button" className="voice-stop" disabled={busy} onClick={()=>void finish()}><Square size={20}/><span>完成本段</span></button></>:<button type="button" className="voice-start" disabled={busy||!ready} onClick={()=>void run(async()=>{if(status.state==="ready")await stage();if(latest.current.record.attachments.length>=9)throw new Error("每条最多9个附件，请先保存当前记录。");setStatus(await native("start"));setNotice("");})}><Mic size={27}/><span>{status.state==="ready"?"保留原音并继续":draft.record.attachments.length?"继续录入":"开始录音"}</span></button>}</div>
    {(error||status.error)&&<p className="journal-voice-error" role="alert">{error||status.error}</p>}{status.state==="ready"&&error&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{setStatus(await native("acknowledge",status.token));setNotice("原文件已归档保留，可以重新录音。");})}>保留异常原文件并重新录音</button>}{notice&&<p className="journal-voice-notice" role="status">{notice}</p>}
    {!!draft.record.attachments.length&&<section className="journal-voice-segments" aria-label="已保留的录音">{draft.record.attachments.filter(a=>isJournalAudio(a.name)).map((a,i)=><JournalAudio key={`${a.hash}-${i}`} attachment={a}/>)}</section>}
    <label className="journal-voice-text">补充文字<textarea aria-label="录音补充文字" value={draft.record.text} placeholder="记下要点，或稍后再补充…" disabled={!ready||busy} onChange={e=>{void persist({...latest.current,record:{...latest.current.record,text:e.target.value}}).catch(err=>setError(String(err)));}}/></label>
    <p className="journal-voice-boundary">当前可录音与回听，转写服务未接通。离开应用会结束并保留本段。</p>
    </div><footer><button type="button" disabled={!ready||busy||active} onClick={()=>void save(false)}><Check size={18}/>保存</button><button type="button" className="voice-save-next" disabled={!ready||busy||active} onClick={()=>void save(true)}>保存并录下一条<ChevronRight size={18}/></button></footer></dialog>,document.body);
}
