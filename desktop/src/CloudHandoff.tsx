import {invoke} from "@tauri-apps/api/core";
import {save} from "@tauri-apps/plugin-dialog";
import {Smartphone} from "lucide-react";
import {useEffect,useRef,useState} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {CloudMarkdownTable} from "./CloudMarkdownTable";
import {CloudAgentSheet} from "./CloudAgentMaterials";
import {runtimeCapabilities} from "./RuntimePlatform";
import type {FileAnalysis} from "./AgentAnalysisFiles";
import "./CloudAgents.css";
import "./CloudHandoff.css";

type FileMeta={name:string;type:string;bytes:number;sha256:string};
export type HandoffManifest={version:1;title:string;origin:{workId:string;artifactId:string;executionId:string;revision:number;generatedAt:string;inputs:{title:string;sha256:string}[]};files:FileMeta[];report:{name:string;text:string;sha256:string}|null};
export type CloudHandoff={id:string;thread:string;state:"uploading"|"published"|"withdrawn";createdAt:number;publishedAt:number|null;manifest:HandoffManifest};
type Preview={manifest:HandoffManifest;manifestSha256:string;id:string;endpoint:string};
type FileReceipt={state:"notDownloaded"|"downloaded"|"saveDialogOpened"|"saving"|"verified"|"cancelled";offline?:boolean;name?:string;sha256?:string};
export const handoffCall=<T,>(request:Record<string,unknown>)=>invoke<T>("cloud_agents",{action:{op:"handoff",request}});
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const size=(bytes:number)=>bytes<1024*1024?`${(bytes/1024).toFixed(1)} KiB`:`${(bytes/1024/1024).toFixed(1)} MiB`;
const date=(value:string|number)=>new Date(value).toLocaleString("zh-CN");
export function canHandoffAnalysis(item:FileAnalysis) {
  return item.available && !item.superseded && item.files.some(file=>file.type==="md" && file.bytes>0 && file.bytes<=48000);
}

export function AgentCloudHandoff({
 workId,
 item,
 triggerLabel="手机继续查看",
 triggerClassName,
 showRequirementNote=true,
 sentReceipt,
 onSent,
 onOpenCloudThread,
}:{
 workId:string;
 item:FileAnalysis;
 triggerLabel?:string;
 triggerClassName?:string;
 showRequirementNote?:boolean;
 sentReceipt?:CloudHandoff;
 onSent?:(handoff:CloudHandoff)=>void;
 onOpenCloudThread?:(threadId:string)=>void;
}){
 const [open,setOpen]=useState(false),[files,setFiles]=useState<string[]>([]),[report,setReport]=useState("");
 const [preview,setPreview]=useState<Preview>(),[busy,setBusy]=useState(false),[error,setError]=useState(""),[done,setDone]=useState<CloudHandoff>();
 const scope=useRef("");scope.current=workId+":"+item.executionId;
 const sending=useRef(false);
 const selectable=item.files.filter(file=>file.bytes>0&&file.bytes<=10*1024*1024);
 const reports=selectable.filter(file=>file.type==="md"&&file.bytes<=48000);
 const storageKey="hub-handoff-selection:"+scope.current;
 useEffect(()=>{setOpen(false);setPreview(undefined);setDone(undefined);setError("");setBusy(false);},[workId,item.executionId]);
 function show(){
  let selected=selectable.map(file=>file.name),chosen=reports[0]?.name||"";
  try{const saved=JSON.parse(localStorage.getItem(storageKey)||"null");if(saved&&Array.isArray(saved.files)){selected=selected.filter(name=>saved.files.includes(name));if(reports.some(r=>r.name===saved.report))chosen=saved.report;}}catch{}
  setFiles(selected);setReport(chosen);setOpen(true);setPreview(undefined);setError("");setDone(undefined);
 }
 function choose(selected:string[],chosen=report){setFiles(selected);setReport(chosen);setPreview(undefined);setDone(undefined);try{localStorage.setItem(storageKey,JSON.stringify({files:selected,report:chosen}));}catch{setError("本机暂时不能保存选择。重开后请重新核对文件清单。");}}
 async function perform(send=false){
  if(sending.current)return;const owner=scope.current;sending.current=true;setBusy(true);setError("");
  try{
   const request={work:workId,execution:item.executionId,files,report};
   if(send&&preview){
    const result=await handoffCall<{handoff:CloudHandoff}>({...request,op:"send",confirm:true,expectedSha256:preview.manifestSha256,expectedId:preview.id,expectedEndpoint:preview.endpoint});
    if(scope.current===owner){setDone(result.handoff);onSent?.(result.handoff);}
   }
   else{const result=await handoffCall<Preview>({...request,op:"preview"});if(scope.current===owner)setPreview(result);}
  }catch(e){if(scope.current===owner)setError(message(e));}
  finally{sending.current=false;if(scope.current===owner)setBusy(false);}
 }
 const published = sentReceipt?.state === "published";
 return <><button type="button" className={triggerClassName} data-handoff-sent={published || undefined} disabled={!item.available||item.superseded||!reports.length} onClick={show}>{triggerClassName&&<Smartphone size={14} aria-hidden="true"/>}{triggerLabel}</button>{showRequirementNote&&!reports.length&&<small> · 需要一份不超过 48 KB 的 Markdown 报告</small>}
 {open&&<div className="hub-handoff-dialog"><CloudAgentSheet title="发送到个人云端" onClose={()=>setOpen(false)} busy={busy}>
  <div className="hub-handoff-form"><h3>{item.title} · 第 {item.revision||1} 版</h3>
   <p>选择手机上需要的成果副本。个人云端可根据报告继续讨论；其他文件供你取回。</p>
   <fieldset disabled={busy||Boolean(done)}><legend>交接文件</legend>{item.files.map(file=><label className="hub-handoff-choice" key={file.name}><input type="checkbox" checked={files.includes(file.name)} disabled={file.bytes>10*1024*1024||file.bytes===0} onChange={e=>choose(e.target.checked?[...files,file.name]:files.filter(name=>name!==file.name))}/><span>{file.name}<small>{size(file.bytes)}{file.bytes>10*1024*1024?" · 超出单文件 10 MiB 上限":""}</small></span></label>)}</fieldset>
   <label>用于阅读和续聊的报告<select value={report} disabled={busy||Boolean(done)} onChange={e=>choose(files,e.target.value)}>{reports.map(file=><option key={file.name} value={file.name}>{file.name}</option>)}</select></label>
   <p className="hub-handoff-note">这是交接时的固定副本。后续桌面资料变化不会自动更新；撤回本地授权也不会删除已导出的云端副本。云端可另行撤回，已保存的副本及历史回答会保留。</p>
   {error&&<p role="alert">{error}{preview&&"。若发送结果未确认，请保留原选择重试，系统会核对同一交接编号。"}</p>}
   {preview&&<section aria-label="本次交接预览"><h3>确认交接内容</h3><p>目标：{preview.endpoint}</p><p>{preview.manifest.files.length} 个文件 · {size(preview.manifest.files.reduce((n,f)=>n+f.bytes,0))} · 第 {preview.manifest.origin.revision} 版</p><details><summary>查看报告正文</summary><pre>{preview.manifest.report?.text}</pre></details><p className="hub-handoff-note">只上传以上所选成果、来源标题和哈希。没有交接原始表格、完整桌面聊天或桌面工具权限。云端续聊只读取这份报告正文。</p></section>}
   {done?<div className="hub-handoff-done"><p role="status">已交接并核对全部文件。手机进入「助手」，打开“{done.manifest.title}”查看报告与文件；可在同一云端会话继续提问。</p>{onOpenCloudThread&&<button type="button" onClick={()=>{setOpen(false);onOpenCloudThread(done.thread);}}>在云端会话中查看</button>}</div>:<footer><button type="button" disabled={busy||!files.length||!files.includes(report)} onClick={()=>void perform(false)}>{busy?"正在核对交接…":"预览交接内容"}</button>{preview&&<button type="button" className="hub-handoff-primary" disabled={busy} onClick={()=>void perform(true)}>确认发送到个人云端</button>}</footer>}
  </div>
 </CloudAgentSheet></div>}</>;
}

export type CloudHandoffReceiptStatus={state:"unverified"|"verified"|"cached"|"error";note?:string};

export function CloudHandoffReceiptBanner({
 handoff,
 verification,
 onOpenThread,
 onSyncHandoff,
 onWithdrawn,
}:{
 handoff:CloudHandoff;
 verification?:CloudHandoffReceiptStatus;
 onOpenThread?:(threadId:string)=>void;
 onSyncHandoff?:(handoff:CloudHandoff,verification:CloudHandoffReceiptStatus)=>void;
 onWithdrawn?:(handoffId:string)=>void;
}){
 const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[error,setError]=useState("");
 async function checkCloudState(){
  if(busy||checking)return;
  setChecking(true);setError("");
  try{
   const data=await invoke<{cached?:boolean;accessDenied?:boolean;error?:string;thread?:{handoff?:CloudHandoff|null}|null}>("cloud_agents",{action:{op:"read",thread:handoff.thread}});
   if(data?.accessDenied){
    const msg=data.error||"云端访问已撤销，无法确认当前交接状态。";
    setError(msg);
    onSyncHandoff?.(handoff,{state:"error",note:msg});
    return;
   }
   const remote=data?.thread?.handoff;
   if(!data?.thread||!remote||remote.state==="withdrawn"){
    onSyncHandoff?.({...handoff,state:"withdrawn"},{state:"verified"});
    return;
   }
   if(data.cached){
    onSyncHandoff?.(remote,{state:"cached",note:"当前仅读取到本机缓存，恢复连接后再核对云端是否已撤回。"});
   }else{
    onSyncHandoff?.(remote,{state:"verified",note:"已联机核对：云端交接当前仍有效。"});
   }
  }catch(e){
   const msg=`暂无法核对云端状态：${message(e)}`;
   setError(msg);
   onSyncHandoff?.(handoff,{state:"error",note:msg});
  }finally{setChecking(false);}
 }
 async function withdraw(){
  if(busy||checking)return;
  if(!window.confirm("撤回这份云端交接？将移除 Hub 云端交接副本，停止下载和续聊。此前已发给模型的内容、历史回答及已保存的副本保留，原桌面成果不变。"))return;
  setBusy(true);setError("");
  try{
   await handoffCall({op:"withdraw",thread:handoff.id,confirm:true});
   onWithdrawn?.(handoff.id);
  }catch(e){setError(message(e));}
  finally{setBusy(false);}
 }
 const label=`「${handoff.manifest.title}」第 ${handoff.manifest.origin.revision} 版`;
 if(handoff.state==="withdrawn"){
  return <div className="hub-handoff-receipt is-withdrawn" role="status">
   <div className="hub-handoff-receipt-copy">
    <Smartphone size={14} aria-hidden="true"/>
    <span>已撤回{label}的云端交接副本（已停止手机端下载与续聊，桌面原成果与历史回答保留）</span>
   </div>
   {onOpenThread&&<div className="hub-handoff-receipt-actions">
    <button type="button" onClick={()=>onOpenThread(handoff.thread)}>查看原云端记录</button>
   </div>}
  </div>;
 }
 return <div className={`hub-handoff-receipt${verification?.state==="error"||verification?.state==="cached"?" is-unverified":""}`} aria-label="云端交接回执">
  <div className="hub-handoff-receipt-copy">
   <Smartphone size={14} aria-hidden="true"/>
   <span>{label}已发至个人云端（固定静态副本 · {handoff.manifest.files.length} 个文件，未上传原资料库）</span>
  </div>
  <div className="hub-handoff-receipt-actions">
   <button type="button" disabled={busy||checking} onClick={()=>void checkCloudState()}>{checking?"正在核对…":"核对云端状态"}</button>
   {onOpenThread&&<button type="button" disabled={busy||checking} onClick={()=>onOpenThread(handoff.thread)}>打开云端会话</button>}
   <button type="button" className="hub-handoff-withdraw-btn" disabled={busy||checking} onClick={()=>void withdraw()}>{busy?"正在撤回…":"撤回交接"}</button>
  </div>
  {verification?.note&&!error&&<p className="hub-handoff-receipt-status" role="status">{verification.note}</p>}
  {error&&<p className="hub-handoff-receipt-error" role="alert">{error}</p>}
 </div>;
}

function HandoffFile({handoff,file}:{handoff:CloudHandoff;file:FileMeta}){
 const [receipt,setReceipt]=useState<FileReceipt>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 const owner=useRef(handoff.id+":"+file.sha256);owner.current=handoff.id+":"+file.sha256;
 const request={op:"file",thread:handoff.id,name:file.name,sha256:file.sha256};
 useEffect(()=>{let live=true;void handoffCall<FileReceipt>({...request,mode:"status"}).then(r=>{if(live)setReceipt(r);},()=>{});return()=>{live=false;};},[handoff.id,file.sha256]);
 useEffect(()=>{
  if(!receipt||!["saveDialogOpened","saving"].includes(receipt.state))return;
  let live=true;let timer:ReturnType<typeof setTimeout>;const started=Date.now();
  const read=async()=>{try{const result=await handoffCall<FileReceipt>({...request,mode:"status"});if(live)setReceipt(result);}catch{}if(live&&Date.now()-started<120000)timer=setTimeout(()=>void read(),1600);};
  const wake=()=>{if(!document.hidden)void read();};window.addEventListener("focus",wake);document.addEventListener("visibilitychange",wake);timer=setTimeout(()=>void read(),1000);
  return()=>{live=false;clearTimeout(timer);window.removeEventListener("focus",wake);document.removeEventListener("visibilitychange",wake);};
 },[receipt?.state,handoff.id,file.sha256]);
 async function act(mode:"download"|"export"){
  if(busy)return;const scope=owner.current;setBusy(true);setError("");try{
   let destination="";if(mode==="export"&&!runtimeCapabilities.mobile){const chosen=await save({title:"保存交接文件副本",defaultPath:file.name,filters:[{name:file.type.toUpperCase(),extensions:[file.type]}]});if(!chosen)return;destination=chosen;}
   if(scope!==owner.current)return;
   const result=await handoffCall<FileReceipt>({...request,mode,destination});if(scope===owner.current)setReceipt(result);
  }catch(e){if(scope===owner.current)setError(message(e));}finally{if(scope===owner.current)setBusy(false);}
 }
 const downloaded=receipt&&receipt.state!=="notDownloaded";
 const saving=receipt&&["saveDialogOpened","saving"].includes(receipt.state);
 return <li><strong>{file.name}</strong><small>{size(file.bytes)} · SHA-256 {file.sha256.slice(0,12)}…</small><div className="hub-handoff-file-actions"><button type="button" disabled={busy||Boolean(saving)} onClick={()=>void act("download")}>{busy?"正在核对…":downloaded?"重新核对文件":"取回到本机"}</button><button type="button" disabled={busy||!downloaded||Boolean(saving)} onClick={()=>void act("export")}>保存副本</button></div>
  {receipt&&receipt.state!=="notDownloaded"&&<p role="status">{receipt.state==="verified"?"已保存，并回读核对内容一致。":receipt.state==="saveDialogOpened"?"系统保存窗口已打开，尚未确认保存完成。":receipt.state==="saving"?"正在保存并校验文件…":receipt.state==="cancelled"?"本次系统保存已取消或过期；已取回的文件仍保留。":"已取回并校验，可离线保存副本。"}</p>}
  {error&&<p role="alert">{error}</p>}
 </li>;
}

export function CloudHandoffPanel({handoff,compact=false,onOpen,onWithdraw}:{handoff:CloudHandoff;compact?:boolean;onOpen?:()=>void;onWithdraw?:()=>void}){
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 if(handoff.state==="withdrawn")return <section className="hub-cloud-handoff" aria-label="桌面交接"><h2>云端交接已撤回</h2><p>已移除 Hub 云端交接副本，不再提供报告下载或继续提问。此前已发给模型的内容、历史回答及已保存的副本保留。</p></section>;
 const {manifest}=handoff;
 async function withdraw(){if(!window.confirm("撤回这份云端交接？将移除 Hub 云端交接副本，停止下载和续聊。此前已发给模型的内容、历史回答及已保存的副本保留，原桌面成果不变。"))return;setBusy(true);setError("");try{await handoffCall({op:"withdraw",thread:handoff.id,confirm:true});onWithdraw?.();}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <section className="hub-cloud-handoff" aria-label="桌面交接报告"><h2>桌面已有分析</h2><h3>{manifest.title}</h3><p className="hub-handoff-note">第 {manifest.origin.revision} 版 · {manifest.files.length} 个文件 · 交接于 {handoff.publishedAt?date(handoff.publishedAt):"待确认"}</p><p>这是桌面完成的固定版本。后续提问由个人云端根据报告回答；没有在云端重跑桌面计算。</p>
  {compact?<button type="button" onClick={onOpen}>查看报告与文件</button>:<>
   <div className="cloud-agents-markdown hub-handoff-report"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{table:CloudMarkdownTable,img:()=> <span>图片请取回对应文件查看。</span>,a:({children})=><span>{children}</span>}}>{manifest.report?.text||"报告正文不可用。"}</ReactMarkdown></div>
   <details><summary>来源版本与交接范围</summary><p>桌面生成于 {date(manifest.origin.generatedAt)}</p><ul>{manifest.origin.inputs.map((source,index)=><li key={index}>{source.title}<small>SHA-256 {source.sha256}</small></li>)}</ul><p>只交接下列成果副本；原始数据文件未上传。云端模型只收到报告正文和文件清单。后续来源变化不自动更新此快照。</p><p>离线内容截至上次成功读取，恢复连接后会重新核对云端状态。</p></details>
   <h3>取回文件</h3><ul className="hub-handoff-files">{manifest.files.map(file=><HandoffFile key={handoff.id+file.name} handoff={handoff} file={file}/>)}</ul>
   <details><summary>管理这份云端交接</summary><p>撤回会移除 Hub 云端交接副本，停止下载和续聊。此前已发给模型的内容、历史回答和已保存的副本保留。本地授权变化不会自动撤回已导出的云端副本。</p><button type="button" disabled={busy} onClick={()=>void withdraw()}>撤回云端交接</button></details>
  </>}{error&&<p role="alert">{error}</p>}
 </section>;
}

export function CloudPendingHandoffs(){
 const [drafts,setDrafts]=useState<{id:string;title:string;createdAt:number}[]>(),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 async function read(){setBusy(true);setError("");try{setDrafts((await handoffCall<{drafts:{id:string;title:string;createdAt:number}[]}>({op:"drafts"})).drafts);}catch(e){setError(message(e));}finally{setBusy(false);}}
 async function withdraw(id:string){if(!window.confirm("撤回这份未完成的云端交接？已上传的临时副本会被移除，原桌面成果不变。"))return;setBusy(true);setError("");try{await handoffCall({op:"withdraw",thread:id,confirm:true});setDrafts(v=>v?.filter(d=>d.id!==id));}catch(e){setError(message(e));}finally{setBusy(false);}}
 return <details className="hub-cloud-handoff"><summary>未完成的文件交接</summary><p>断线后可在原桌面成果中用原选择继续。已经不需要的交接，可在这里撤回临时副本。</p><button type="button" disabled={busy} onClick={()=>void read()}>核对未完成交接</button>{drafts?.map(draft=><div key={draft.id}><strong>{draft.title}</strong><small>{date(draft.createdAt)}</small><button type="button" disabled={busy} onClick={()=>void withdraw(draft.id)}>撤回这份未完成交接</button></div>)}{drafts?.length===0&&<p role="status">没有未完成的交接。</p>}{error&&<p role="alert">{error}</p>}</details>;
}
