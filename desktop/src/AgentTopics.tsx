import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {useAgentPopover} from "./useAgentPopover";
import {AgentTopicWork} from "./AgentTopicWork";
import type {AgentSkill} from "./AgentSkills";

export type TopicWorkSource={anchor:Anchor;title:string;path:string;libraryName:string};
type Anchor={kind:"note";libraryId:string;documentId:string;pageId:string|null};
type Topic={id:string;revision:number;methodVersion:string;config:{title:string;defaultQuestion:string;parameters:{period:string;outputPreference:string};sourceRule:{membership:string;anchor:Anchor;periodDirectory?:string};archived:boolean}};
type Detail={openedWorkId?:string|null;topic:Topic;method:{id:string;content:{name:string;files:Record<string,string|{encoding:string;content:string;bytes:number;readable:boolean;kind:string}>}};methodCompatible:boolean;methodUnavailableReason:string|null;history:{anchor?:Anchor|null;period:string;workId:string;configRevision:number;goal:string|null;state:string|null;hasReport:boolean;methodUse?:{loadedThisRun:boolean;sentToRuntime:boolean}|null}[];scopePolicy:string;methodPolicy:string};
type Preview={topicId:string;revision:number;period:string;existingWorkId?:string;fingerprint?:string;scope?:{kind:string;totalMembers?:number;dateCoverage?:{directoryMembers:number;unknownDateMembers:number}};methodVersion?:string;defaultQuestion?:string;notes?:{title:string;sourcePath:string;locator:Anchor;version:unknown}[]};
type Page={topics:{id:string;revision:number;title:string;parameters:{period:string}}[];nextOffset:number|null};
const call=<T,>(args:Record<string,unknown>)=>invoke<T>("agent_investigation",{args});
const month=()=>{const now=new Date();return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}`;};

export function AgentTopics({anchor,work,disabled,onOpenWork}:{anchor:Anchor;work?:{id:string;revision?:number;report:unknown;state:string};disabled:boolean;onOpenWork:(id:string,source?:TopicWorkSource,draft?:string)=>Promise<void>}) {
 const popover=useAgentPopover({deferEscapeSelector:".agent-topic-work .agent-source-preview"}),alive=useRef(true),sequence=useRef(0),inflight=useRef(false);
 const previewReturn=useRef<HTMLButtonElement|null>(null);
 const [disclosureOpen,setDisclosureOpen]=useState(false),[previewWork,setPreviewWork]=useState<string|null>(null);
 const pending=useRef<{payload:string;args:Record<string,unknown>}|null>(null);
 const [page,setPage]=useState<Page>({topics:[],nextOffset:null}),[detail,setDetail]=useState<Detail|null>(null),[skills,setSkills]=useState<AgentSkill[]>([]);
 const [creating,setCreating]=useState(false),[tab,setTab]=useState<"成果"|"数据"|"历史"|"设置">("成果"),[loading,setLoading]=useState(false),[uncertain,setUncertain]=useState(false),[error,setError]=useState("");
 const [directory,setDirectory]=useState<string|null>(null);
 const [empty,setEmpty]=useState(false),[question,setQuestion]=useState(""),[runPeriod,setRunPeriod]=useState(month),[scope,setScope]=useState<Preview|null>(null),[consent,setConsent]=useState(false);
 const [title,setTitle]=useState(""),[period,setPeriod]=useState(month),[skill,setSkill]=useState("hub-statistics"),[preference,setPreference]=useState("");
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 const accept=(value:Detail)=>{
  const source=value.topic.config.sourceRule.anchor;
  if(source?.kind!=="note"||source.libraryId!==anchor.libraryId||source.documentId!==anchor.documentId||source.pageId!==anchor.pageId||value.method.id!==value.topic.methodVersion)throw new Error("专题返回身份或来源锚点不一致，请重新核对");
  setDirectory(value.topic.config.sourceRule.periodDirectory??null);setScope(null);setConsent(false);setRunPeriod(value.topic.config.parameters.period);setQuestion(value.topic.config.defaultQuestion);setDetail(value);setPreviewWork(current=>detail?.topic.id===value.topic.id&&value.history.some(item=>item.workId===current&&item.state)?current:value.history.find(item=>item.state)?.workId||null);setCreating(false);setTitle(value.topic.config.title);setPeriod(value.topic.config.parameters.period);setPreference(value.topic.config.parameters.outputPreference);setSkill(value.method.content.name);};
 async function read(args:Record<string,unknown>,kind:"list"|"detail",append=false) {
  const ticket=++sequence.current;setLoading(true);setError("");
  try {const value=await call<Page|Detail>(args);if(!alive.current||ticket!==sequence.current)return;
   if(kind==="list") {const next=value as Page;setPage(previous=>append?{...next,topics:[...previous.topics,...next.topics]}:next);}
   else {const next=value as Detail;const source=next.topic.config.sourceRule.anchor;
    if(next.topic.id!==args.topicId||source?.kind!=="note"||source.libraryId!==anchor.libraryId||source.documentId!==anchor.documentId||source.pageId!==anchor.pageId)throw new Error("专题返回身份或来源锚点不一致，请重新核对");accept(next);}
  } catch(reason){if(alive.current&&ticket===sequence.current)setError(String(reason));}
  finally {if(alive.current&&ticket===sequence.current)setLoading(false);}
 }
 const list=(offset=0)=>read({action:"topicList",anchor,offset},"list",offset>0);
 async function loadSkills() {
  try {const value=await call<{skills:AgentSkill[]}>({action:"skills"});if(alive.current)setSkills(value.skills.filter(s=>(s.origin==="builtin"||s.origin==="registered")&&s.available));}
  catch(reason){if(alive.current)setError(String(reason));}
 }
 async function prepare(isEmpty=false) {
  const ticket=++sequence.current;setLoading(true);setError("");
  try {const value=await call<{skills:AgentSkill[]}>({action:"skills"});if(alive.current&&ticket===sequence.current){setSkills(value.skills.filter(s=>(s.origin==="builtin"||s.origin==="registered")&&s.available));setCreating(true);setEmpty(isEmpty);setQuestion(isEmpty?"核对当前笔记，给出有出处的简短报告":"");setScope(null);setConsent(false);setDetail(null);setTitle("材料复核");setPeriod(month());setTab("设置");}}
  catch(reason){if(alive.current&&ticket===sequence.current)setError(String(reason));}
  finally {if(alive.current&&ticket===sequence.current)setLoading(false);}
 }
 async function save(args:Record<string,unknown>) {
  if(inflight.current)return;
  const payload=JSON.stringify(args);
  if(pending.current&&pending.current.payload!==payload){setError("先核对上次保存，或读取已保存版本，再编辑新内容。");return;}
  const command=pending.current||{payload,args:{...args,clientRequestId:`topic-${crypto.randomUUID()}`}};pending.current=command;
  inflight.current=true;const ticket=++sequence.current;setLoading(true);setUncertain(true);setError("");
  try {const value=await call<Detail>(command.args);if(!alive.current||ticket!==sequence.current)return;
   if(args.topicId&&value.topic.id!==args.topicId)throw new Error("专题返回身份不一致");
   accept(value);pending.current=null;setUncertain(false);setTab("成果");void list();
   if(value.openedWorkId){void openWork(value.openedWorkId,value).catch(reason=>{if(alive.current)setError("本期工作已保存，打开失败："+String(reason));});}
  } catch(reason){if(alive.current&&ticket===sequence.current){const message=String(reason);setError(/[\u4e00-\u9fff]/.test(message)?message:"保存结果尚未确认，请核对同一次保存；原工作仍保留。");setUncertain(true);}}
  finally {inflight.current=false;if(alive.current&&ticket===sequence.current)setLoading(false);}
 }
 async function discardToList() {
  const ticket=++sequence.current;setLoading(true);
  try {const value=await call<Page>({action:"topicList",anchor,offset:0});if(alive.current&&ticket===sequence.current){setPage(value);setDetail(null);setCreating(false);pending.current=null;setUncertain(false);setError("已返回实际专题列表；此操作没有撤销已提交的设置。");}}
  catch(reason){if(alive.current&&ticket===sequence.current)setError(String(reason));}
  finally {if(alive.current&&ticket===sequence.current)setLoading(false);}
 }
 async function reloadSaved() {
  if(!detail)return;
  const ticket=++sequence.current;setLoading(true);
  try {const value=await call<Detail>({action:"topicOpen",topicId:detail.topic.id});if(alive.current&&ticket===sequence.current){accept(value);pending.current=null;setUncertain(false);setError("");}}
  catch(reason){if(alive.current&&ticket===sequence.current)setError(String(reason));}
  finally {if(alive.current&&ticket===sequence.current)setLoading(false);}
 }
 async function openWork(id:string,context=detail,draft?:string){
  if(!context)throw new Error("专题身份缺失");
  const value=await call<{workId:string;source:TopicWorkSource}>({action:"topicWorkNavigation",topicId:context.topic.id,workId:id});
  if(!alive.current)return;
  const expected=context.history.find(item=>item.workId===id)?.anchor;
  if(value.workId!==id||value.source?.anchor.kind!=="note"||value.source.anchor.libraryId!==anchor.libraryId||expected&&(value.source.anchor.libraryId!==expected.libraryId||value.source.anchor.documentId!==expected.documentId||value.source.anchor.pageId!==expected.pageId))throw new Error("原工作导航返回身份不一致");
  popover.close(true);await onOpenWork(id,value.source,...(draft===undefined?[]:[draft]));
 }
 async function previewPeriod(){
  if(!detail||inflight.current)return;
  const ticket=++sequence.current;setLoading(true);setError("");setScope(null);setConsent(false);
  try{const value=await call<Preview>({action:"topicWorkPreview",topicId:detail.topic.id,expectedRevision:detail.topic.revision,period:runPeriod});
   if(!alive.current||sequence.current!==ticket)return;
   if(value.topicId!==detail.topic.id||value.revision!==detail.topic.revision||value.period!==runPeriod||!value.existingWorkId&&(!value.fingerprint||!value.notes?.length||value.methodVersion!==detail.topic.methodVersion))throw new Error("本期预览身份或方法不一致");
   setScope(value);
  }catch(reason){if(alive.current&&sequence.current===ticket)setError(String(reason));}
  finally{if(alive.current&&sequence.current===ticket)setLoading(false);}
 }
 const blocked=disabled||loading||uncertain;
 const saveConfig=()=>void save(creating?{action:empty?"topicCreateEmpty":"topicCreate",...(empty?{anchor,defaultQuestion:question}:{workId:work?.id,expectedWorkRevision:work?.revision}),title,period,skill,outputPreference:preference}:{action:"topicUpdate",topicId:detail?.topic.id,expectedRevision:detail?.topic.revision,title,defaultQuestion:question,period,outputPreference:preference,periodDirectory:directory,...(detail&&skill!==detail.method.content.name?{skill}:{})});
 return <details ref={popover.ref} className="agent-topics agent-popover" name="hub-agent-preference" onToggle={event=>{if(event.target===event.currentTarget){setDisclosureOpen(event.currentTarget.open);if(event.currentTarget.open)void list();}}}>
  <summary>专题</summary><div className="agent-topic-panel">
   <div className="agent-popover-header"><strong>当前笔记的专题</strong><button type="button" aria-label="关闭专题" onClick={()=>popover.close(true)}>关闭</button></div>
   <p className="agent-note">保存可复用设置和原工作关联，不启动分析，也不写回笔记。当前仅支持内置/已登记固定方法与 Obsidian；本期实际资料在创建前核对。</p>
   {!detail&&!creating&&<><button type="button" disabled={disabled||loading||uncertain||!work?.report||work.revision===undefined||work.state==="revoked"} onClick={()=>void prepare()}>从当前成果保存专题</button>
    <button type="button" disabled={blocked} onClick={()=>void prepare(true)}>新建空专题（不运行）</button>
    {page.topics.map(item=><button type="button" key={item.id} disabled={disabled||loading||uncertain} onClick={()=>void read({action:"topicOpen",topicId:item.id},"detail")}>{item.title} · {item.parameters.period}</button>)}
    {!page.topics.length&&!loading&&<p className="agent-note">当前页没有相关专题。{page.nextOffset!==null?"可以继续查看下一页。":"可新建空专题，或从现有成果保存设置。"}</p>}
    {page.nextOffset!==null&&<button type="button" disabled={disabled||loading||uncertain} onClick={()=>void list(page.nextOffset!)}>查看更多专题</button>}</>}
   {detail&&<><h3>{detail.topic.config.title}{detail.topic.config.archived?"（已归档）":""}</h3><nav aria-label="专题页面">{(["成果","数据","历史","设置"] as const).map(name=><button type="button" key={name} aria-pressed={tab===name} disabled={loading} onClick={()=>{setTab(name);if(name==="设置"&&!skills.length)void loadSkills();}}>{name}</button>)}</nav>
    {(tab==="成果"||tab==="数据"||tab==="历史")&&<><p className="agent-note">{detail.scopePolicy}</p>{detail.history.map(item=><div key={item.workId}><strong>{item.period}</strong><p>{item.goal||"原工作已不可用"}</p><p className="agent-note">{item.state==="completed"?"原工作已完成":item.state?"最近工作尚未完成":"原工作已删除"} · {item.hasReport?"保留原成果；打开后核对当前有效性":"尚无本次成果"} · 关联配置第{item.configRevision}版</p><p className="agent-note">{item.methodUse?.loadedThisRun ? "本轮有固定方法加载记录" : "尚未取得本轮固定方法加载记录；不能仅凭绑定推定采用"}{item.methodUse?.sentToRuntime ? "，已送入运行层；是否完成方法要求仍需核对成果。" : "。"}</p><button type="button" data-topic-work={item.workId} disabled={loading||!item.state} onClick={event=>{previewReturn.current=event.currentTarget;setPreviewWork(item.workId);}}>查看{tab}（保留原工作归属）</button><button type="button" disabled={disabled||loading||!item.state} onClick={()=>{void openWork(item.workId).catch(reason=>{if(alive.current)setError(String(reason));});}}>打开原工作，查看成果与数据</button></div>)}</>}
    {!detail.topic.config.archived&&<section aria-label="本期工作"><label>本期月份<input type="month" value={runPeriod} disabled={blocked} onChange={event=>{setRunPeriod(event.target.value);setScope(null);setConsent(false);}}/></label><button type="button" disabled={blocked||!runPeriod} onClick={()=>void previewPeriod()}>核对本期工作与范围（不运行）</button>
     {scope?.existingWorkId?<><p role="status">本期已有原工作；失败、历史及累计用量保留，不再新建。</p><button type="button" disabled={blocked} onClick={()=>{void openWork(scope.existingWorkId!).catch(reason=>{if(alive.current)setError(String(reason));});}}>打开本期原工作（不运行）</button></>:scope&&<><p>{scope.defaultQuestion}</p><p className="agent-note">固定方法：{scope.methodVersion}。{scope.scope?.kind==="periodManifest"?`本期按目录内严格 YYYY-MM-DD.md 文件名筛选，共${scope.scope.totalMembers}篇；目录成员${scope.scope.dateCoverage?.directoryMembers}篇，日期不明${scope.scope.dateCoverage?.unknownDateMembers}篇。这里只核对元数据，正文尚未读取。`:"本期仅限下列固定笔记，月份不会自动筛选或扩大资料。"}按本地缓存版本核对，未向远端确认。创建后使用 Codex，仍须在原工作明确发送才运行；不授权写回。</p><ul>{scope.notes?.map((note,index)=><li key={index}>{note.title} · {note.sourcePath}<details><summary>核对身份与版本</summary><pre tabIndex={0}>{JSON.stringify({locator:note.locator,version:note.version},null,2)}</pre></details></li>)}</ul><label><input type="checkbox" checked={consent} disabled={blocked} onChange={event=>setConsent(event.target.checked)}/>授权本期分析读取以上笔记（不含写回）</label><button type="button" disabled={blocked||!consent} onClick={()=>void save({action:"topicCreateWork",topicId:detail.topic.id,expectedRevision:detail.topic.revision,period:scope.period,expectedPreview:scope.fingerprint,confirmedScope:consent})}>创建本期工作并打开（暂不调用模型）</button></>}
    </section>}
    {disclosureOpen&&previewWork&&(tab==="成果"||tab==="数据"||tab==="历史")&&<AgentTopicWork key={previewWork} workId={previewWork} anchor={detail.history.find(item=>item.workId===previewWork)?.anchor||anchor} page={tab} disabled={blocked} changeContext={{topicId:detail.topic.id,topicRevision:detail.topic.revision}} onBind={async revision=>{const item=detail.history.find(item=>item.workId===previewWork);if(!item)throw new Error("本期工作关联缺失");await save({action:"topicBind",topicId:detail.topic.id,expectedRevision:detail.topic.revision,workId:item.workId,expectedWorkRevision:revision,period:item.period});}} onBack={()=>{setPreviewWork(null);const back=previewReturn.current?.isConnected?previewReturn.current:[...(popover.ref.current?.querySelectorAll<HTMLButtonElement>("[data-topic-work]")||[])].find(button=>button.dataset.topicWork===previewWork);back?.focus();}} onOpenWork={async (id,draft)=>{await openWork(id,detail,draft);}}/>}
    {tab==="设置"&&<details><summary>固定方法内容与适用限制</summary><div><p className="agent-note">{detail.methodPolicy}</p><p>{detail.methodCompatible?"固定内容与当前工具参数合同匹配（实际能力按已验证范围）":"当前不可执行："+detail.methodUnavailableReason}</p>{Object.entries(detail.method.content.files).map(([path,text])=><details key={path}><summary>{path}</summary><pre tabIndex={0} aria-label={path+" 固定内容"} className="agent-topic-method">{typeof text==="string"?text:text.encoding==="utf8"&&(text.readable||path==="SKILL.md"||path==="agents/openai.yaml")?text.content:`已保存 ${text.bytes} 字节；当前不解析或执行。`}</pre></details>)}</div></details>}
   </>}
   {(creating||detail&&tab==="设置")&&<div className="agent-topic-settings"><label>专题名称<input value={title} maxLength={100} disabled={blocked} onChange={e=>setTitle(e.target.value)}/></label>{(!creating||empty)&&<label>默认问题<textarea value={question} maxLength={2000} disabled={blocked} onChange={e=>setQuestion(e.target.value)}/></label>}<label>默认月份<input type="month" value={period} disabled={blocked} onChange={e=>setPeriod(e.target.value)}/></label><label>输出偏好<textarea value={preference} maxLength={500} disabled={blocked} onChange={e=>setPreference(e.target.value)}/></label>
    <label>固定方法<select value={skill} disabled={blocked||!skills.length} onChange={e=>setSkill(e.target.value)}>{!skills.some(item=>item.name===skill)&&<option value={skill}>{skill}（已保存版本）</option>}{skills.map(item=><option key={item.name} value={item.name}>{item.title}</option>)}</select></label>
    {!creating&&<><label>来源选择规则<select disabled={blocked} value={directory===null?"fixed":"period"} onChange={event=>setDirectory(event.target.value==="fixed"?null:"")}><option value="fixed">固定笔记范围</option><option value="period">目录内按本期月份选择日记</option></select></label>{directory!==null&&<label>日记目录（相对资料库，空表示根目录）<input value={directory} maxLength={1024} disabled={blocked} onChange={event=>setDirectory(event.target.value)}/></label>}<p className="agent-note">仅改月份或偏好不会替换方法。选择其它方法会另存配置版本；已存在工作的绑定和旧成果保留，需要时再明确用于下一轮。</p><button type="button" disabled={blocked} onClick={()=>void save({action:"topicUpdate",topicId:detail?.topic.id,expectedRevision:detail?.topic.revision,title,defaultQuestion:question,period,outputPreference:preference,periodDirectory:directory,skill})}>固定所选方法的当前版本（旧版保留）</button></>}
    <button type="button" disabled={blocked||!title.trim()||!period||(empty&&creating||!creating)&&!question.trim()} onClick={saveConfig}>保存专题设置（不启动分析）</button>
    {detail&&work&&<button type="button" disabled={blocked||work.revision===undefined||detail.topic.config.archived} onClick={()=>void save({action:"topicBind",topicId:detail.topic.id,expectedRevision:detail.topic.revision,workId:work.id,expectedWorkRevision:work.revision,period:detail.topic.config.parameters.period})}>将固定方法用于当前工作下一轮（不启动分析）</button>}
    {detail&&work&&<button type="button" disabled={blocked||detail.topic.config.archived} onClick={()=>void save({action:"topicUpdate",topicId:detail.topic.id,expectedRevision:detail.topic.revision,title,period,outputPreference:preference,sourceWorkId:work.id})}>明确改用当前工作已授权的材料范围</button>}
    {detail&&<button type="button" disabled={blocked} onClick={()=>void save({action:"topicArchive",topicId:detail.topic.id,expectedRevision:detail.topic.revision,archived:!detail.topic.config.archived})}>{detail.topic.config.archived?"恢复专题":"归档专题（不取消工作）"}</button>}
   </div>}
   {uncertain&&<><p role="status">上次保存结果待核对，暂不能提交不同内容。</p><button type="button" disabled={disabled||loading} onClick={()=>{const command=pending.current;if(command){const {clientRequestId:_,...args}=command.args;void save(args);}}}>核对并重试同一次保存</button>{detail?<button type="button" disabled={disabled||loading} onClick={()=>void reloadSaved()}>放弃本地编辑，读取已保存版本</button>:<button type="button" disabled={disabled||loading} onClick={()=>void discardToList()}>返回列表核对（不撤销已提交设置）</button>}</>}
   {loading&&<p role="status">正在读取或保存专题…</p>}{error&&<p role="alert">{error}</p>}
   {(creating||detail)&&<button type="button" disabled={loading||uncertain} onClick={()=>{setCreating(false);setDetail(null);setError("");void list();}}>返回专题列表</button>}
  </div>
 </details>;
}
