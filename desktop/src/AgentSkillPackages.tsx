import {useEffect,useRef,useState} from "react";
import type {ReactNode} from "react";
import {createPortal} from "react-dom";
import {invoke} from "@tauri-apps/api/core";
import {open} from "@tauri-apps/plugin-dialog";
import type {AgentSkill} from "./AgentSkills";

type Source={packageId:string;revision:number;name:string;directory:string;mode:"copy"|"source"|"sync";methodVersion:string;sourceFingerprint:string};
type Resource={path:string;bytes:number;sha256:string;kind:string;readable:boolean;encoding:string};
type CloudCandidate={packageId:string;name:string;fingerprint:string;candidates:{version:string;device:string;paused:boolean}[]};
type Inspection={source:Source|null;directory?:string;methodVersion:string;sourceFingerprint:string;skill:{name:string;title:string;description?:string;available:boolean;unavailableReasons:string[]};files:Resource[];warnings:string[];nameConflict?:string;changed?:boolean;checkedAt?:number;history?:{revision:number;methodVersion:string}[];recentUses?:{runId:string|null;path:string;at:number}[];paused?:boolean};
type Removal={packageId:string;revision:number;fingerprint:string;methodVersions:number;readReceipts:number;scope:string};
type Operation={clientRequestId:string;packageId:string;operation:"delete"|"export";state:string;detail:{methodVersion?:string;target?:string};verificationReason?:string};
type FileView={packageId:string;methodVersion:string;path:string;sha256:string;content:string;previewOnly:boolean};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
function validate(value:Inspection,packageId?:string,methodVersion?:string) {
 if(!value?.methodVersion?.startsWith("method-")||!value.sourceFingerprint||!value.skill?.name||!Array.isArray(value.files)||!Array.isArray(value.warnings)||(packageId&&value.source?.packageId!==packageId)||(methodVersion&&value.methodVersion!==methodVersion))throw new Error("方法包返回身份或文件清单不一致，请刷新核对");
 return value;
}

export function SkillManagerCard({title,version,description,shared,status,action,onOpen,disabled}:{
 title:string;version?:string;description?:string;shared?:boolean;status?:string;action?:ReactNode;onOpen?:()=>void;disabled?:boolean;
}) {
 const content=<><span className="agent-skill-card-title">
  <strong>{title}</strong>{version&&<small className="agent-skill-card-version" title={version}>{/^[a-f0-9]{12,}$/i.test(version)?version.slice(0,7):version}</small>}
  {shared&&<small className="agent-skill-card-shared">Codex 通用</small>}
 </span>
 {description&&<span className="agent-skill-card-description" title={description}>{description}</span>}
 {status&&<span className="agent-skill-card-status">{status}</span>}</>;
 return <article className="agent-skill-manager-card">
  {onOpen?<button type="button" className="agent-skill-card-copy" disabled={disabled} onClick={onOpen}>{content}</button>:<div className="agent-skill-card-copy">{content}</div>}
  {action}
 </article>;
}

export function AgentSkillPackages({onChanged,initiallyExpanded=false,importTarget,onShowImport,cardSkills,refreshKey,sharingEnabled=true}:{
 onChanged:()=>void;initiallyExpanded?:boolean;importTarget?:HTMLElement|null;onShowImport?:()=>void;cardSkills?:AgentSkill[];refreshKey?:number;sharingEnabled?:boolean;
}) {
 const panel=useRef<HTMLElement|null>(null);
 const alive=useRef(true),sequence=useRef(0),listSequence=useRef(0),writing=useRef(false),pending=useRef<Record<string,unknown>|null>(null),fileReturn=useRef<HTMLButtonElement|null>(null),closeFile=useRef<HTMLButtonElement|null>(null);
 const manager=useRef<HTMLButtonElement|null>(null),deleteReturn=useRef<HTMLButtonElement|null>(null);
 const [removal,setRemoval]=useState<Removal|null>(null),[confirmed,setConfirmed]=useState(false),[notice,setNotice]=useState("");
 const [expanded,setExpanded]=useState(initiallyExpanded),[sources,setSources]=useState<Source[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(""),[uncertain,setUncertain]=useState(false);
 const [listing,setListing]=useState(false);
 const [preview,setPreview]=useState<Inspection|null>(null),[detail,setDetail]=useState<Inspection|null>(null),[file,setFile]=useState<FileView|null>(null),[mode,setMode]=useState<"copy"|"source">("source"),[version,setVersion]=useState("");
 const [candidates,setCandidates]=useState<CloudCandidate[]>([]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;listSequence.current++;};},[]);
 useEffect(()=>{if(file)closeFile.current?.focus();},[file]);
 useEffect(()=>{if(notice&&!detail&&!busy)manager.current?.focus();},[notice,detail,busy]);
 const blocked=busy||listing||uncertain;
 const accept=(value:Inspection)=>{setDetail(value);setVersion(value.methodVersion);setPreview(null);setFile(null);setRemoval(null);setConfirmed(false);};
 async function list(){
  const ticket=++listSequence.current;
  setListing(true);
  try {
   const result=await call<{sources:Source[];cloudCandidates?:CloudCandidate[]}>({action:"skillPackages"});
   if(!Array.isArray(result.sources))throw new Error("方法包来源清单无效");
   if(alive.current&&ticket===listSequence.current){setSources(result.sources);setCandidates(result.cloudCandidates||[]);}
  } finally {if(alive.current&&ticket===listSequence.current)setListing(false);}
 }
 async function changeCloudState(args:Record<string,unknown>, version?:string, showDetail=true) {
  if(blocked||writing.current)return;
  writing.current=true;setBusy(true);setError("");
  try {
   const next=validate(await call<Inspection>(args),args.packageId as string,version);
   if(alive.current){
    if(showDetail||detail?.source?.packageId===args.packageId)accept(next);
    onChanged();await list();setNotice(next.paused?"技能已停用。":args.action==="skillPackagePause"?"技能已启用。":"已保存采用的技能版本。");
   }
  } catch(reason){if(alive.current)setError(String(reason));}
  finally{writing.current=false;if(alive.current)setBusy(false);}
 }
 async function read(args:Record<string,unknown>,kind:"detail"|"preview"|"check"|"file"|"delete") {
  const ticket=++sequence.current;setBusy(true);setError("");setFile(null);setRemoval(null);setConfirmed(false);setNotice("");if(kind==="preview"||kind==="check")setPreview(null);
  try {
   const result=await call<Inspection|FileView|Removal>(args);if(!alive.current||ticket!==sequence.current)return;
   if(kind==="delete"){const next=result as Removal;if(next.packageId!==args.packageId||next.revision!==args.expectedRevision||!next.fingerprint||typeof next.scope!=="string"||!Number.isInteger(next.methodVersions)||!Number.isInteger(next.readReceipts))throw new Error("删除范围身份不一致");setRemoval(next);}
   else if(kind==="file") {const next=result as FileView;if(next.packageId!==args.packageId||next.methodVersion!==args.methodVersion||next.path!==args.path||typeof next.content!=="string"||next.previewOnly!==true)throw new Error("预览文件身份不一致");setFile(next);}
   else {const next=validate(result as Inspection,args.packageId as string|undefined,kind==="detail"?args.methodVersion as string|undefined:undefined);if(kind==="detail")accept(next);else setPreview(next);}
  }catch(reason){if(alive.current&&ticket===sequence.current)setError(String(reason));}
  finally{if(alive.current&&ticket===sequence.current)setBusy(false);}
 }
 async function chooseDirectory(title:string){
  const owner=panel.current,previousFocus=document.activeElement;
  owner?.setAttribute("data-agent-native-dialog","");
  try{return await open({directory:true,multiple:false,title});}
  finally{
   if(alive.current&&previousFocus instanceof HTMLElement&&(owner?.contains(previousFocus)||importTarget?.contains(previousFocus)))previousFocus.focus();
   owner?.removeAttribute("data-agent-native-dialog");
  }
 }
 async function choose(){if(blocked)return;setError("");try{const directory=await chooseDirectory("选择包含 SKILL.md 的普通方法文件夹");if(alive.current&&typeof directory==="string"){setDetail(null);await read({action:"skillPackagePreview",directory},"preview");}}catch(reason){if(alive.current)setError(String(reason));}}
 function acceptResult(result:Inspection|Operation,payload:Record<string,unknown>){
  if(payload.action==="skillPackageDelete"||payload.action==="skillPackageExport"){
   const op=result as Operation;const kind=payload.action==="skillPackageDelete"?"delete":"export";
   if(op.clientRequestId!==payload.clientRequestId||op.packageId!==payload.packageId||op.operation!==kind||op.state!=="completed"||(kind==="export"&&(op.detail?.methodVersion!==payload.methodVersion||!op.detail?.target)))throw new Error(op.verificationReason||"操作尚未得到完整、对应的成功回执");
   setRemoval(null);setConfirmed(false);setPreview(null);setFile(null);
   if(kind==="delete"){setDetail(null);setVersion("");setNotice("Hub保存的方法副本及关联回读内容已删除；原文件夹、历史成果和用量保留。外部已发送或导出的副本未召回。");}
   else setNotice(`已核对固定版本导出：${op.detail.target}。文件只复制，不执行；外部客户端是否支持仍需实际验证。`);
  }else{
   const value=validate(result as Inspection,payload.packageId as string|undefined);
   if(payload.action==="skillPackageImport"&&value.skill.name!==preview?.skill.name)throw new Error("提交结果的方法名称不一致，待核对");accept(value);
  }
 }
 async function exportFolder(){if(blocked||!detail?.source)return;setError("");try{const directory=await chooseDirectory("选择导出父文件夹（新建方法子目录，不覆盖）");if(alive.current&&typeof directory==="string")await mutate({action:"skillPackageExport",packageId:detail.source.packageId,expectedRevision:detail.source.revision,methodVersion:detail.methodVersion,directory});}catch(reason){if(alive.current)setError(String(reason));}}
 async function mutate(args:Record<string,unknown>,retry=false) {
  if(writing.current||(!retry&&uncertain))return;
  const payload=retry?pending.current:{...args,clientRequestId:crypto.randomUUID()};if(!payload)return;
  pending.current=payload;writing.current=true;setBusy(true);setError("");setFile(null);sequence.current++;
  try{
   const result=await call<Inspection|Operation>(payload);if(!alive.current)return;acceptResult(result,payload);setUncertain(false);pending.current=null;onChanged();try{await list();}catch(reason){if(alive.current)setError(`保存已核对，但来源清单刷新失败：${String(reason)}`);}
  }catch(reason){if(alive.current){setUncertain(true);setError(`保存结果待核对：${String(reason)}。继续保存前先核对这次请求；不要另开提交。`);}}
  finally{writing.current=false;if(alive.current)setBusy(false);}
 }
 async function resolve(){if(!pending.current||writing.current)return;setBusy(true);setError("");try{const result=await call<{found:boolean;detail?:Inspection;operation?:Operation;removedPackageId?:string}>({action:"skillPackageRequest",clientRequestId:pending.current.clientRequestId});if(!alive.current)return;if(result.found&&result.removedPackageId&&!["skillPackageDelete","skillPackageExport"].includes(String(pending.current.action))&&(!pending.current.packageId||pending.current.packageId===result.removedPackageId)){pending.current=null;setUncertain(false);setDetail(null);setPreview(null);setNotice("已核对：原保存曾提交，随后方法被明确删除；未恢复或重发旧保存。原成果和用量保留。");onChanged();await list();}else if(result.found&&(result.detail||result.operation)){acceptResult((result.operation||result.detail)!,pending.current);pending.current=null;setUncertain(false);onChanged();try{await list();}catch(reason){if(alive.current)setError(`保存已核对，但来源清单刷新失败：${String(reason)}`);}}else setError("尚未发现提交记录；仍可能在途，只能继续核对或以同一请求重试。");}catch(reason){if(alive.current)setError(`结果仍待核对：${String(reason)}`);}finally{if(alive.current)setBusy(false);}}
 async function toggle(){if(expanded){if(!writing.current)setExpanded(false);return;}setExpanded(true);setBusy(true);setError("");try{await list();}catch(reason){if(alive.current)setError(String(reason));}finally{if(alive.current)setBusy(false);}}
 useEffect(()=>{if(initiallyExpanded){setError("");void list().catch(reason=>{if(alive.current)setError(String(reason));});}},[initiallyExpanded,refreshKey]);
 const dismissFile=()=>{setFile(null);fileReturn.current?.focus();};
 const active=detail?.source;
 return <section ref={panel} className={cardSkills?"agent-skill-packages-cards":undefined} aria-label="方法包管理" style={{overflowWrap:"anywhere"}}>
  {!initiallyExpanded && <button type="button" ref={manager} aria-expanded={expanded} onClick={()=>void toggle()} disabled={busy}>管理方法包</button>}
  {expanded&&<div>
   {!cardSkills&&<p className="agent-note">从包含 SKILL.md 的文件夹添加技能，检查后保存。已添加的技能可在下方查看版本、检查更新或导出。</p>}
   {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}{(busy||listing)&&<p role="status">正在核对方法包…</p>}
   {uncertain&&<div role="status"><strong>结果待核对</strong><button type="button" disabled={busy} onClick={()=>void resolve()}>核对本次保存结果</button><button type="button" disabled={busy} onClick={()=>void mutate({},true)}>以同一请求重试</button></div>}
   {importTarget?createPortal(<button type="button" className="agent-skill-import" disabled={blocked} onClick={()=>{onShowImport?.();void choose();}}>＋ 导入技能</button>,importTarget):
     <button type="button" disabled={blocked} onClick={()=>void choose()}>检查方法文件夹</button>}
   {candidates.map(item=><details key={item.packageId}><summary>{item.name} · 有多个云端候选版本</summary>
    <ul>{item.candidates.map((candidate,index)=><li key={index}><span>{candidate.device} · {candidate.paused?"停用":"启用"} · {candidate.version}</span><button type="button" disabled={blocked} onClick={()=>void changeCloudState({action:"skillPackageAdoptCloud",packageId:item.packageId,methodVersion:candidate.version,paused:candidate.paused,expectedFingerprint:item.fingerprint},candidate.version)}>采用此版本</button></li>)}</ul>
   </details>)}
   {cardSkills?<div className="agent-skill-manager-catalog">{sources.map(src=>{
    const skill=cardSkills.find(item=>item.packageId===src.packageId||(!item.packageId&&item.name===src.name));
    const paused=detail?.source?.packageId===src.packageId?detail.paused===true:skill?.unavailableReasons.includes("技能已停用")===true;
    return <SkillManagerCard key={src.packageId} title={skill?.title||src.name} version={`第 ${src.revision} 版`} description={skill?.description}
      shared={sharingEnabled&&!!skill?.available&&skill.allowImplicitInvocation&&!paused}
      status={paused?"已停用":skill&&!skill.available?skill.unavailableReasons.join("；")||"暂不可用":undefined}
      disabled={blocked} onOpen={()=>void read({action:"skillPackageDetails",packageId:src.packageId},"detail")}
      action={skill&&<button type="button" className="agent-skill-card-switch" role="switch" aria-label={`启用 ${skill.title}`} aria-checked={!paused} disabled={blocked}
        onClick={()=>void changeCloudState({action:"skillPackagePause",packageId:src.packageId,expectedRevision:src.revision,paused:!paused},undefined,false)}/>}/>;
   })}</div>:sources.map(src=><button type="button" key={src.packageId} disabled={blocked} onClick={()=>void read({action:"skillPackageDetails",packageId:src.packageId},"detail")}>{src.name} · 登记第{src.revision}版</button>)}
   {preview&&<section aria-label="方法包检查结果">
    <h4>{preview.skill.title}</h4><p>{preview.changed===false?"在本次文件及工具合同检查中未发现变化，无须重新发布或运行模型。":preview.source?"发现可比较的来源版本；发布前仍会核对文件与登记修订。":"检查完成，尚未导入。"}</p>
    <p>{preview.skill.available?"当前声明的文字能力可用，实际任务尚未验证。":`暂不可用：${preview.skill.unavailableReasons.join("；")}`}</p>
    {preview.nameConflict&&<p role="alert">{preview.nameConflict}</p>}
    <ul>{preview.files.map(resource=><li key={resource.path}>{resource.path} · {resource.bytes}字节 · {resource.readable?"可按需读取文字":"仅保存或作为方法配置，不执行"}</li>)}</ul>
    {preview.warnings.map((warning,index)=><p className="agent-note" key={index}>{warning}</p>)}
    {!preview.source?<><label>保存方式<select disabled={blocked} value={mode} onChange={e=>setMode(e.target.value as "copy"|"source")}><option value="source">登记主要维护来源</option><option value="copy">导入独立副本</option></select></label><button type="button" disabled={blocked||!!preview.nameConflict} onClick={()=>void mutate({action:"skillPackageImport",directory:preview.directory,mode,expectedFingerprint:preview.sourceFingerprint})}>保存固定方法包</button></>:<button type="button" disabled={blocked||preview.changed!==true} onClick={()=>void mutate({action:"skillPackageUpdate",packageId:preview.source?.packageId,expectedRevision:preview.source?.revision,expectedFingerprint:preview.sourceFingerprint})}>发布检查过的新版本（旧版保留）</button>}
   </section>}
   {detail&&active&&<section aria-label="已保存方法包">
    <h4>{detail.skill.title}</h4><p>{detail.skill.description}</p>
    <p>{active.mode==="sync"?"OSS 同步副本":`${active.mode==="source"?"主要维护来源":"独立导入副本"}：${active.directory}`}</p>
    <p className="agent-note">当前采用登记第{active.revision}版。源目录改变不会自动替换正在运行的方法或重跑成果；检查更新按明确操作进行。</p><details><summary>核对固定版本身份</summary><p>当前：{active.methodVersion}</p><p>正在查看：{detail.methodVersion}</p><p>来源指纹：{detail.sourceFingerprint}</p></details>
    <p>{detail.skill.available?"可用于已声明文字能力；未据此宣称真实任务已验证。":`暂不可用：${detail.skill.unavailableReasons.join("；")}`}</p>
    <button type="button" disabled={blocked} onClick={()=>void changeCloudState({action:"skillPackagePause",packageId:active.packageId,expectedRevision:active.revision,paused:!detail.paused})}>{detail.paused?"启用技能":"停用技能"}</button>
    {active.mode!=="sync"&&<button type="button" disabled={blocked} onClick={()=>void read({action:"skillPackageCheck",packageId:active.packageId,expectedRevision:active.revision},"check")}>检查原目录变化（不运行）</button>}
    <label>已保存方法版本<select value={version} disabled={blocked} onChange={e=>{setVersion(e.target.value);setFile(null);}}>{[...new Set((detail.history||[]).map(h=>h.methodVersion))].map(id=><option key={id} value={id}>{id===active.methodVersion?"当前 · ":"历史 · "}登记第{detail.history?.find(item=>item.methodVersion===id)?.revision}版</option>)}</select></label>
    <button type="button" disabled={blocked||!version} onClick={()=>void read({action:"skillPackageDetails",packageId:active.packageId,methodVersion:version},"detail")}>查看所选版本的清单</button>
    <button type="button" disabled={blocked||!version||version===active.methodVersion} onClick={()=>void mutate({action:"skillPackageSwitch",packageId:active.packageId,expectedRevision:active.revision,methodVersion:version})}>切换未来使用版本（历史与动作保留）</button>
    <button type="button" disabled={blocked} onClick={()=>void exportFolder()}>导出正在查看的固定版本</button>
    <button type="button" ref={deleteReturn} disabled={blocked} onClick={()=>void read({action:"skillPackageDeletePreview",packageId:active.packageId,expectedRevision:active.revision},"delete")}>核对删除Hub保存副本的范围</button>
    {removal&&<section aria-label="删除方法副本确认"><p>{removal.scope}</p><p>将移除{removal.methodVersions}个方法版本、{removal.readReceipts}条方法读取或回读副本。旧成果保持可访问，旧方法全文不可恢复。</p><label><input type="checkbox" checked={confirmed} disabled={blocked} onChange={e=>setConfirmed(e.target.checked)}/>我已核对删除范围和不可恢复性</label><button type="button" disabled={blocked||!confirmed} onClick={()=>void mutate({action:"skillPackageDelete",packageId:removal.packageId,expectedRevision:removal.revision,expectedFingerprint:removal.fingerprint,confirmed:true})}>确认删除Hub保存副本</button><button type="button" disabled={blocked} onClick={()=>{setRemoval(null);setConfirmed(false);deleteReturn.current?.focus();}}>取消删除</button></section>}
    <p>下列清单属于正在查看的固定版本，预览不等于模型已经读取。</p>
    <h5>配套文件</h5>
    <ul>{detail.files.map(resource=><li key={resource.path}>{resource.path} · {resource.bytes}字节<details><summary>核对文件指纹</summary>{resource.sha256}</details>{(resource.readable||resource.kind==="instructions"||resource.kind==="policy")?<button type="button" disabled={blocked} onClick={event=>{fileReturn.current=event.currentTarget;void read({action:"skillPackageFile",packageId:active.packageId,methodVersion:detail.methodVersion,path:resource.path},"file");}}>预览 {resource.path}</button>:<span>仅保存，不解析或执行</span>}</li>)}</ul>
    {detail.warnings.map((warning,index)=><p className="agent-note" key={index}>{warning}</p>)}
    <details><summary>本机运行读取记录</summary>{detail.recentUses?.length
      ? <ul>{detail.recentUses.map((use,index)=><li key={index}>{use.path} · {new Date(use.at).toLocaleString()} {use.runId&&` · ${use.runId}`}</li>)}</ul>
      : <p>此版本目前没有本机运行读取记录。</p>}</details>
   </section>}
   {file&&<section aria-label="固定方法文件预览" onKeyDownCapture={event=>{if(event.key==="Escape"){event.preventDefault();event.stopPropagation();dismissFile();}}}>
    <h4>{file.path}</h4><button type="button" ref={closeFile} onClick={dismissFile}>关闭文件预览并返回</button><pre tabIndex={0} aria-label="固定方法文件文字" className="agent-topic-method" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{file.content}</pre><p className="agent-note">按原样显示文字，不执行 HTML、脚本或外部请求。这里只是方法，不是本次个人事实证据。</p>
   </section>}
   {!cardSkills&&<details className="agent-menu-advanced"><summary>导入格式与容量</summary><p className="agent-note">每包最多 33 个文件、原始内容 128 KiB、固定记录 256 KiB。文字参考和模板每份 32 KiB，助手按需读取。超限时会提示拆分。</p></details>}
  </div>}
 </section>;
}
