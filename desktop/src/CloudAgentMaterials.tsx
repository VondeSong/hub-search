import {useEffect,useRef,useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import type {MaterialSnapshot} from './CloudAgentMedia';
import {localJournalDate} from './JournalViews';
import {useModalFocus} from './useModalFocus';
import {QUICK_JOURNAL_UPDATED} from './QuickJournalEvents';
import {runtimeCapabilities} from './RuntimePlatform';

const call=<T,>(op:string,fields:Record<string,unknown>={})=>invoke<T>('cloud_agents',{action:{op,...fields}});
type Key={kind:string;id:string;libraryId:string|null};
type Candidate={key:Key;title:string;source:string;chars:number;preview:string};
function Dialog({title,onClose,children,busy=false}:{title:string;onClose:()=>void;children:React.ReactNode;busy?:boolean}){
 const ref=useRef<HTMLElement>(null);
 const dismiss=useRef(onClose),locked=useRef(busy);dismiss.current=onClose;locked.current=busy;
 const mounted=useRef(false),entry=useRef<{id:string;parent:Record<string,unknown>|null}|null>(null);
 useEffect(()=>{
  if(!runtimeCapabilities.mobile)return;
  mounted.current=true;
  const {id,parent}=entry.current??(entry.current={id:crypto.randomUUID(),parent:window.history.state});
  const push=()=>window.history.pushState({...parent,hubCloudDialog:id},'');
  if(window.history.state?.hubCloudDialog!==id)push();
  const back=(event:PopStateEvent)=>{
   if(event.state?.hubCloudDialog===id)return;
   if(event.state?.hubMobileRoute===parent?.hubMobileRoute&&event.state?.hubCloudAgentChat===parent?.hubCloudAgentChat)event.stopImmediatePropagation();
   if(locked.current)push();else dismiss.current();
  };
  window.addEventListener('popstate',back,true);
  return()=>{
   window.removeEventListener('popstate',back,true);mounted.current=false;
   // StrictMode replays effects before this microtask; only a real unmount releases the entry.
   queueMicrotask(()=>{if(!mounted.current&&window.history.state?.hubCloudDialog===id)window.history.back();});
  };
 },[]);
 useModalFocus({active:true,containerRef:ref,onDismiss:onClose});
 return <section className="cloud-agents-sheet" role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}><header><h2>{title}</h2><button type="button" onClick={onClose} disabled={busy}>关闭</button></header>{children}</section>;
}
export function CloudMaterialPicker({onClose,onConfirm}:{onClose:()=>void;onConfirm:(value:MaterialSnapshot)=>void}){
 const [kind,setKind]=useState('document'),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[rows,setRows]=useState<Candidate[]>([]),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[preview,setPreview]=useState<MaterialSnapshot>();
 const epoch=useRef(0);
 useEffect(()=>{let live=true;const ticket=++epoch.current;setBusy(true);const timer=setTimeout(()=>{void call<{items:Candidate[];more:boolean}>('materials',{kind,query,offset}).then(value=>{if(live&&epoch.current===ticket){setRows(value.items);setMore(value.more);setError('');}},reason=>{if(live)setError(String(reason));}).finally(()=>{if(live)setBusy(false);});},220);return()=>{live=false;epoch.current++;clearTimeout(timer);};},[kind,query,offset]);
 async function choose(selection:Key){const ticket=++epoch.current;setBusy(true);setError('');try{const value=await call<MaterialSnapshot>('material',{selection});if(epoch.current===ticket)setPreview(value);}catch(e){if(epoch.current===ticket)setError(String(e));}finally{if(epoch.current===ticket)setBusy(false);}}
 return <Dialog title={preview?'预览本次正文':'选择已下载资料'} onClose={onClose}>
  <p>只发送这次明确选择的正文快照，不上传整库、原文件或附件。支持一份正文，最多 48 KB，不自动截断。</p>
  {error&&<p role="alert">{error}</p>}
  {preview?<><h3>{preview.title}</h3><small>{preview.source}</small><pre>{preview.text}</pre><footer><button type="button" onClick={()=>setPreview(undefined)}>重新选择</button><button type="button" onClick={()=>onConfirm(preview)}>使用本次正文</button></footer></>:<>
   <div className="cloud-agents-scopes">{[['document','文档'],['journal','速记']].map(([id,label])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>{setOffset(0);setKind(id);}}>{label}</button>)}</div>
   <input aria-label="搜索已下载资料" value={query} maxLength={200} onChange={e=>{setOffset(0);setQuery(e.target.value);}} placeholder="搜索标题或正文"/>
   {busy?<p role="status">正在读取本机资料…</p>:rows.length?<div className="cloud-material-results">{rows.map(row=><button type="button" key={JSON.stringify(row.key)} onClick={()=>void choose(row.key)}><strong>{row.title}</strong><small>{row.source} · {row.chars} 字符</small><span>{row.preview}</span></button>)}</div>:<p>没有可用的已下载正文。可先同步所需文档，或切换到速记。</p>}
   <footer><button type="button" disabled={!offset||busy} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button><button type="button" disabled={!more||busy} onClick={()=>setOffset(v=>v+20)}>下一页</button></footer>
  </>}
 </Dialog>;
}
type JournalRecord={version:1;id:string;date:string;text:string;attachments:unknown[]};
type Receipt={uploaded:boolean;applied:boolean;sourceError?:string};
export function CloudAnswerNote({thread,turn}:{thread:string;turn:string}){
 const [open,setOpen]=useState(false),[date,setDate]=useState(localJournalDate),[record,setRecord]=useState<JournalRecord>(),[receipt,setReceipt]=useState<Receipt>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
 async function readReceipt(value:JournalRecord){const result=await invoke<{items:({record:JournalRecord}&Receipt)[]}>('list_quick_journal');return result.items.find(item=>item.record.id===value.id);}
 async function preview(){const ticket=++epoch.current;setBusy(true);setError('');try{const value=await call<{record:JournalRecord}>('answerNote',{thread,turn,date});const saved=await readReceipt(value.record);if(epoch.current===ticket){setRecord(value.record);setReceipt(saved);}}catch(e){if(epoch.current===ticket)setError(String(e));}finally{if(epoch.current===ticket)setBusy(false);}}
 async function save(){if(!record)return;setBusy(true);setError('');try{const result=await invoke<{warning:string|null}>('capture_quick_journal',{record});window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));setReceipt({uploaded:false,applied:false});if(result.warning)setError(result.warning);const saved=await readReceipt(record);if(saved)setReceipt(saved);}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function sync(){setBusy(true);setError('');try{await invoke('sync_quick_journal');if(record){const saved=await readReceipt(record);if(saved)setReceipt(saved);else setError('没有找到本机回执，请到速记中核对。');}}catch(e){setError(String(e));}finally{setBusy(false);}}
 return <><button type="button" onClick={()=>setOpen(true)}>保存为速记</button>{open&&<Dialog title="保存回答为速记" busy={busy} onClose={()=>{if(!busy)setOpen(false);}}>
  {error&&<p role="alert">{error}</p>}
  {!record?<><label>保存日期<input type="date" aria-label="速记日期" value={date} disabled={busy} onChange={e=>setDate(e.target.value)}/></label><p>先预览本条完整回答，再确认保存；不会修改原会话或资料。</p><button type="button" disabled={busy||!date} onClick={()=>void preview()}>预览保存</button></>:<><p>{record.date}</p><pre>{record.text}</pre>{receipt?<><p role="status">{receipt.applied?'OS 已确认写入':receipt.uploaded?'已上传云端 · 等待 OS 回执':'已存本机 · 尚未确认上传云端'}</p>{receipt.sourceError&&<p role="alert">{receipt.sourceError}</p>}<button type="button" disabled={busy} onClick={()=>void sync()}>同步并核对回执</button></>:<><p>确认后进入现有速记与 OS 归档流程。重复保存本条回答使用相同记录身份。</p><button type="button" disabled={busy} onClick={()=>void save()}>确认保存速记</button></>}</>}
 </Dialog>}</>;
}
