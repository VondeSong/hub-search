import {useEffect,useRef,useState,type ReactNode} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {exactPackedMaterialBytes,formatMaterialKb,MAX_MATERIAL_BYTES,utf8ByteLength,type MaterialSelectionKey,type MaterialSnapshot} from './CloudAgentMedia';
import {localJournalDate} from './JournalViews';
import {useModalFocus} from './useModalFocus';
import {QUICK_JOURNAL_UPDATED} from './QuickJournalEvents';
import {runtimeCapabilities} from './RuntimePlatform';
import {ArrowLeft,CheckCircle2,PenLine,X} from 'lucide-react';

const call=<T,>(op:string,fields:Record<string,unknown>={})=>invoke<T>('cloud_agents',{action:{op,...fields}});
type Key=MaterialSelectionKey;
type Candidate={key:Key;title:string;source:string;chars:number;bytes?:number;preview:string};
const MAX_MULTI_MATERIALS=8;
const keyId=(key:Key)=>`${key.kind}\u0000${key.libraryId??''}\u0000${key.id}`;
const materialMatchesKey=(item:MaterialSnapshot,key:Key)=>Boolean(item.key&&keyId(item.key)===keyId(key));
export function CloudAgentSheet({title,onClose,children,busy=false,compact=false,expanded=false,onBack,headerAction,subtitle}:{headerAction?:ReactNode;subtitle?:string;title:string;onClose:()=>void;children:ReactNode;busy?:boolean;compact?:boolean;expanded?:boolean;onBack?:()=>void}){
 const ref=useRef<HTMLElement>(null);
 const dismiss=useRef(onClose),locked=useRef(busy);dismiss.current=onClose;locked.current=busy;
 const previous=useRef(onBack);previous.current=onBack;
 const mounted=useRef(false),entry=useRef<{id:string;parent:Record<string,unknown>|null}|null>(null);
 useEffect(()=>{
  if(!runtimeCapabilities.mobile)return;
  mounted.current=true;
  const {id,parent}=entry.current??(entry.current={id:crypto.randomUUID(),parent:window.history.state});
  const push=()=>window.history.pushState({...parent,hubCloudDialog:id},'');
  if(window.history.state?.hubCloudDialog!==id)push();
  const back=(event:PopStateEvent)=>{
   if(event.state?.hubCloudDialog===id)return;
   if(event.state?.hubMobileRoute===parent?.hubMobileRoute&&event.state?.hubCloudAgentOwner===parent?.hubCloudAgentOwner&&event.state?.hubCloudAgentChat===parent?.hubCloudAgentChat)event.stopImmediatePropagation();
   if(locked.current)push();else if(previous.current){push();previous.current();}else dismiss.current();
  };
  window.addEventListener('popstate',back,true);
  return()=>{
   window.removeEventListener('popstate',back,true);mounted.current=false;
   // StrictMode replays effects before this microtask; only a real unmount releases the entry.
   queueMicrotask(()=>{if(!mounted.current&&window.history.state?.hubCloudDialog===id)window.history.back();});
  };
 },[]);
 useModalFocus({active:true,containerRef:ref,onDismiss:onBack||onClose,suspended:busy});
 return <div className="cloud-agents-sheet-layer" onPointerDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className={`cloud-agents-sheet${compact?' is-compact':''}${expanded?' is-expanded':''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref} tabIndex={-1}><header>{onBack&&<button type="button" className="cloud-sheet-back" aria-label="返回上一级" onClick={onBack} disabled={busy}><ArrowLeft size={20}/></button>}{subtitle ? <div><h2>{title}</h2><small>{subtitle}</small></div> : <h2>{title}</h2>}{headerAction}<button type="button" className="cloud-sheet-close" aria-label="关闭" onClick={onClose} disabled={busy}><X size={20}/></button></header>{children}</section></div>;
}
export function CloudMaterialPicker({
 onClose,
 onConfirm,
 embedded=false,
 multiSelect=false,
 selectedMaterials=[],
 onChangeMaterials,
 mediaControls,
}:{
 onClose:()=>void;
 onConfirm?:(value:MaterialSnapshot)=>void;
 embedded?:boolean;
 multiSelect?:boolean;
 selectedMaterials?:MaterialSnapshot[];
 onChangeMaterials?:(items:MaterialSnapshot[])=>void;
 mediaControls?:ReactNode;
}){
 const [kind,setKind]=useState('document'),[query,setQuery]=useState(''),[offset,setOffset]=useState(0),[rows,setRows]=useState<Candidate[]>([]),[more,setMore]=useState(false),[busy,setBusy]=useState(false),[toggling,setToggling]=useState(''),[error,setError]=useState(''),[preview,setPreview]=useState<MaterialSnapshot>();
 const epoch=useRef(0);
 const toggleEpoch=useRef(0);
 const toggleBusy=useRef(false);
 const activeRef=useRef(true);
 const selectedRef=useRef(selectedMaterials);
 selectedRef.current=selectedMaterials;
 useEffect(()=>{activeRef.current=true;return()=>{activeRef.current=false;toggleEpoch.current++;toggleBusy.current=false;};},[]);
 const handleClose=()=>{toggleEpoch.current++;toggleBusy.current=false;onClose();};
 useEffect(()=>{let live=true;const ticket=++epoch.current;setBusy(true);const timer=setTimeout(()=>{void call<{items:Candidate[];more:boolean}>('materials',{kind,query,offset}).then(value=>{if(live&&epoch.current===ticket){setRows(value.items);setMore(value.more);setError('');}},reason=>{if(live)setError(String(reason));}).finally(()=>{if(live)setBusy(false);});},220);return()=>{live=false;epoch.current++;clearTimeout(timer);};},[kind,query,offset]);
 async function choose(selection:Key){const ticket=++epoch.current;setBusy(true);setError('');try{const value=await call<MaterialSnapshot>('material',{selection});if(activeRef.current&&epoch.current===ticket)setPreview(multiSelect?{...value,key:selection}:value);}catch(e){if(activeRef.current&&epoch.current===ticket)setError(String(e));}finally{if(activeRef.current&&epoch.current===ticket)setBusy(false);}}
 async function toggleSelection(row:Candidate){
  if(!onChangeMaterials||toggleBusy.current)return;
  const kId=keyId(row.key);
  const current=selectedRef.current;
  const existingIdx=current.findIndex(item=>materialMatchesKey(item,row.key)||(item.title===row.title&&item.source===row.source&&!item.key));
  if(existingIdx>=0){
   setError('');
   onChangeMaterials(current.filter((_,idx)=>idx!==existingIdx));
   return;
  }
  if(current.length>=MAX_MULTI_MATERIALS){
   setError(`单次最多选择 ${MAX_MULTI_MATERIALS} 份资料。`);
   return;
  }
  const ticket=++toggleEpoch.current;
  toggleBusy.current=true;
  setToggling(kId);setError('');
  try{
   const snapshot=await call<MaterialSnapshot>('material',{selection:row.key});
   if(!activeRef.current||toggleEpoch.current!==ticket)return;
   const liveCurrent=selectedRef.current;
   if(liveCurrent.some(item=>item.id===snapshot.id||materialMatchesKey(item,row.key)))return;
   const next=[...liveCurrent,{...snapshot,key:row.key}];
   if(exactPackedMaterialBytes(next,'manual')>MAX_MATERIAL_BYTES){
    setError('所选资料合计超过 48 KB 正文上限，请减少选择；不会自动截断原文。');
    return;
   }
   onChangeMaterials(next);
  }catch(e){
   if(activeRef.current&&toggleEpoch.current===ticket)setError(String(e));
  }finally{
   if(toggleEpoch.current===ticket)toggleBusy.current=false;
   if(activeRef.current&&toggleEpoch.current===ticket)setToggling('');
  }
 }
 if(multiSelect){
  const usedBytes=exactPackedMaterialBytes(selectedMaterials,'manual');
  const usedKb=formatMaterialKb(usedBytes);
  const pct=Math.min(100,Math.round((usedBytes/MAX_MATERIAL_BYTES)*100));
  const multiContent=<>
   <div className="bw-budget-panel">
    <div className="bw-budget-head">
     <span>单次发送正文容量预算</span>
     <strong>{usedKb} KB / 48.0 KB</strong>
    </div>
    <div className="bw-budget-bar" role="progressbar" aria-valuemin={0} aria-valuemax={MAX_MATERIAL_BYTES} aria-valuenow={Math.min(usedBytes,MAX_MATERIAL_BYTES)} aria-label="单次发送正文容量预算">
     <div className="bw-budget-fill" style={{width:`${pct}%`}}/>
    </div>
    <small>勾选即生效，只发送明确选中的正文快照，不上传整库</small>
   </div>
   {mediaControls&&<div className="bw-picker-media-row">{mediaControls}</div>}
   {error&&<p className="bw-picker-error" role="alert">{error}</p>}
   {preview&&<div className="bw-picker-preview">
    <div className="bw-picker-preview-head">
     <strong>快照预览：{preview.title}</strong>
     <button type="button" onClick={()=>setPreview(undefined)}>关闭预览</button>
    </div>
    <small>{preview.source} · {formatMaterialKb(utf8ByteLength(preview.text))} KB</small>
    <pre>{preview.text}</pre>
   </div>}
   <div className="cloud-agents-scopes">{[['document','文档'],['journal','速记']].map(([id,label])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>{setOffset(0);setKind(id);}}>{label}</button>)}</div>
   <input aria-label="搜索已下载资料" value={query} maxLength={200} onChange={e=>{setOffset(0);setQuery(e.target.value);}} placeholder="搜索标题或正文"/>
   {busy?<p role="status">正在读取本机资料…</p>:rows.length?<div className="bw-multi-material-list">{rows.map(row=>{
    const kId=keyId(row.key);
    const checked=selectedMaterials.some(item=>materialMatchesKey(item,row.key)||(item.title===row.title&&item.source===row.source&&!item.key));
    const kbLabel=row.bytes!=null?`${formatMaterialKb(row.bytes)} KB`:`${row.chars} 字符`;
    return <div className={`bw-multi-material-row${checked?' is-checked':''}`} key={kId}>
     <label>
      <input type="checkbox" checked={checked} disabled={Boolean(toggling)} onChange={()=>void toggleSelection(row)}/>
      <span><strong>{row.title}</strong><small>{row.source} · {kbLabel}</small></span>
     </label>
     <button type="button" className="bw-multi-preview-btn" disabled={busy||Boolean(toggling)} onClick={()=>void choose(row.key)}>预览</button>
    </div>;
   })}</div>:<p>没有可用的已下载正文。可先同步所需文档，或切换到速记。</p>}
   <footer className="bw-multi-picker-footer">
    <div>
     <button type="button" disabled={!offset||busy} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button>
     <button type="button" disabled={!more||busy} onClick={()=>setOffset(v=>v+20)}>下一页</button>
    </div>
    <button type="button" className="cloud-agents-primary" onClick={handleClose}>完成 ({selectedMaterials.length})</button>
   </footer>
  </>;
  return embedded?multiContent:<CloudAgentSheet title="添加本机资料、照片或技能" compact expanded onClose={handleClose}>{multiContent}</CloudAgentSheet>;
 }
 const content=<>
  <p>只发送这次明确选择的正文快照，不上传整库、原文件或附件。支持一份正文，最多 48 KB，不自动截断。</p>
  {error&&<p role="alert">{error}</p>}
  {preview?<><h3>{preview.title}</h3><small>{preview.source}</small><pre>{preview.text}</pre><footer><button type="button" onClick={()=>setPreview(undefined)}>重新选择</button><button type="button" onClick={()=>onConfirm?.(preview)}>使用本次正文</button></footer></>:<>
   <div className="cloud-agents-scopes">{[['document','文档'],['journal','速记']].map(([id,label])=><button type="button" key={id} aria-pressed={kind===id} onClick={()=>{setOffset(0);setKind(id);}}>{label}</button>)}</div>
   <input aria-label="搜索已下载资料" value={query} maxLength={200} onChange={e=>{setOffset(0);setQuery(e.target.value);}} placeholder="搜索标题或正文"/>
   {busy?<p role="status">正在读取本机资料…</p>:rows.length?<div className="cloud-material-results">{rows.map(row=><button type="button" key={JSON.stringify(row.key)} onClick={()=>void choose(row.key)}><strong>{row.title}</strong><small>{row.source} · {row.chars} 字符</small><span>{row.preview}</span></button>)}</div>:<p>没有可用的已下载正文。可先同步所需文档，或切换到速记。</p>}
   <footer><button type="button" disabled={!offset||busy} onClick={()=>setOffset(v=>Math.max(0,v-20))}>上一页</button><button type="button" disabled={!more||busy} onClick={()=>setOffset(v=>v+20)}>下一页</button></footer>
  </>}
 </>;
 return embedded?content:<CloudAgentSheet title={preview?'预览本次正文':'选择已下载资料'} onClose={onClose}>{content}</CloudAgentSheet>;
}
type JournalRecord={version:1;id:string;date:string;text:string;attachments:unknown[]};
type Receipt={uploaded:boolean;applied:boolean;deleted?:boolean;sourceError?:string};
const answerNoteCacheKey=(thread:string,turn:string)=>`hub-cloud-answer-note:${thread}:${turn}`;
function readCachedAnswerNote(thread:string,turn:string):{id:string;date?:string}|null{
 try{
  const raw=localStorage.getItem(answerNoteCacheKey(thread,turn));
  if(!raw)return null;
  const parsed=JSON.parse(raw) as {id?:unknown;date?:unknown};
  return typeof parsed?.id==='string'&&parsed.id?{id:parsed.id,date:typeof parsed.date==='string'?parsed.date:undefined}:null;
 }catch{return null;}
}
function writeCachedAnswerNote(thread:string,turn:string,record:JournalRecord){
 try{localStorage.setItem(answerNoteCacheKey(thread,turn),JSON.stringify({id:record.id,date:record.date}));}catch{}
}
function clearCachedAnswerNote(thread:string,turn:string){
 try{localStorage.removeItem(answerNoteCacheKey(thread,turn));}catch{}
}
export function CloudAnswerNote({thread,turn,compact=false,onOpenJournal}:{thread:string;turn:string;compact?:boolean;onOpenJournal?:(recordId:string)=>void}){
 const [open,setOpen]=useState(false),[date,setDate]=useState(localJournalDate),[record,setRecord]=useState<JournalRecord>(),[receipt,setReceipt]=useState<Receipt>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const epoch=useRef(0);useEffect(()=>()=>{epoch.current++;},[]);
 async function readReceiptById(recordId:string){
  const result=await invoke<{items:({record:JournalRecord}&Receipt)[]}>('list_quick_journal');
  return result.items.find(item=>!item.deleted&&item.record.id===recordId);
 }
 async function readReceipt(value:JournalRecord){return readReceiptById(value.id);}
 useEffect(()=>{
  if(!compact)return;
  const cached=readCachedAnswerNote(thread,turn);
  if(!cached)return;
  let live=true;
  void readReceiptById(cached.id).then(saved=>{
   if(!live)return;
   if(saved){
    setRecord(saved.record);
    setReceipt({uploaded:saved.uploaded,applied:saved.applied,sourceError:saved.sourceError});
   }else{
    clearCachedAnswerNote(thread,turn);
   }
  }).catch(()=>{});
  return()=>{live=false;};
 },[compact,thread,turn]);
 async function preview(){const ticket=++epoch.current;setBusy(true);setError('');try{const value=await call<{record:JournalRecord}>('answerNote',{thread,turn,date});const saved=await readReceipt(value.record);if(epoch.current===ticket){setRecord(value.record);setReceipt(saved);if(saved)writeCachedAnswerNote(thread,turn,saved.record);}}catch(e){if(epoch.current===ticket)setError(String(e));}finally{if(epoch.current===ticket)setBusy(false);}}
 async function save(targetRecord?:JournalRecord){const currentRecord=targetRecord??record;if(!currentRecord)return;setBusy(true);setError('');try{const result=await invoke<{warning:string|null}>('capture_quick_journal',{record:currentRecord});window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));writeCachedAnswerNote(thread,turn,currentRecord);setReceipt({uploaded:false,applied:false});if(result.warning)setError(result.warning);const saved=await readReceipt(currentRecord);if(saved)setReceipt(saved);}catch(e){setError(String(e));}finally{setBusy(false);}}
 async function quickSaveOrInspect(){
  if(receipt){
   if(onOpenJournal&&record?.id){onOpenJournal(record.id);return;}
   setOpen(true);return;
  }
  if(busy)return;
  const today=localJournalDate();
  setDate(today);
  const ticket=++epoch.current;setBusy(true);setError('');
  try{
   const cached=readCachedAnswerNote(thread,turn);
   if(cached){
    const localSaved=await readReceiptById(cached.id).catch(()=>undefined);
    if(epoch.current!==ticket)return;
    if(localSaved){
     setRecord(localSaved.record);
     setReceipt({uploaded:localSaved.uploaded,applied:localSaved.applied,sourceError:localSaved.sourceError});
     if(onOpenJournal){onOpenJournal(localSaved.record.id);return;}
     setOpen(true);
     return;
    }
   }
   const value=await call<{record:JournalRecord}>('answerNote',{thread,turn,date:today});
   if(epoch.current!==ticket)return;
   setRecord(value.record);
   const existing=await readReceipt(value.record);
   if(epoch.current!==ticket)return;
   if(existing){writeCachedAnswerNote(thread,turn,existing.record);setReceipt(existing);return;}
   const result=await invoke<{warning:string|null}>('capture_quick_journal',{record:value.record});
   if(epoch.current!==ticket)return;
   window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));
   writeCachedAnswerNote(thread,turn,value.record);
   setReceipt({uploaded:false,applied:false});
   if(result.warning)setError(result.warning);
   const saved=await readReceipt(value.record);
   if(epoch.current===ticket&&saved)setReceipt(saved);
  }catch(e){
   if(epoch.current===ticket){setError(String(e));setOpen(true);}
  }finally{
   if(epoch.current===ticket)setBusy(false);
  }
 }
 async function sync(){setBusy(true);setError('');try{await invoke('sync_quick_journal');if(record){const saved=await readReceipt(record);if(saved)setReceipt(saved);else setError('没有找到本机回执，请到速记中核对。');}}catch(e){setError(String(e));}finally{setBusy(false);}}
 const savedLabel=receipt?(receipt.applied?'已写入 OS · 查看':receipt.uploaded?'已存云端 · 查看':record?.date&&record.date!==localJournalDate()?`已存 ${record.date} · 查看`:'已存今日日志 · 查看'):'存为日志';
 return <>{compact?<button type="button" className={`bw-inline-receipt-btn${receipt?' is-done':''}`} disabled={busy} onClick={()=>void quickSaveOrInspect()}>
  {receipt?<CheckCircle2 size={13} aria-hidden="true"/>:<PenLine size={13} aria-hidden="true"/>}
  <span>{busy?'保存中…':savedLabel}</span>
 </button>:<button type="button" onClick={()=>setOpen(true)}>保存为速记</button>}{open&&<CloudAgentSheet title="保存回答为速记" busy={busy} compact={compact} onClose={()=>{if(!busy)setOpen(false);}}>
  {error&&<p role="alert">{error}</p>}
  {!record?<><label>保存日期<input type="date" aria-label="速记日期" value={date} disabled={busy} onChange={e=>setDate(e.target.value)}/></label><p>先预览本条完整回答，再确认保存；不会修改原会话或资料。</p><button type="button" disabled={busy||!date} onClick={()=>void preview()}>预览保存</button></>:<><p>{record.date}</p><pre>{record.text}</pre>{receipt?<><p role="status">{receipt.applied?'OS 已确认写入':receipt.uploaded?'已上传云端 · 等待 OS 回执':'已存本机 · 尚未确认上传云端'}</p>{receipt.sourceError&&<p role="alert">{receipt.sourceError}</p>}<button type="button" disabled={busy} onClick={()=>void sync()}>同步并核对回执</button></>:<><p>确认后进入现有速记与 OS 归档流程。重复保存本条回答使用相同记录身份。</p><button type="button" disabled={busy} onClick={()=>void save()}>确认保存速记</button></>}</>}
 </CloudAgentSheet>}</>;
}
