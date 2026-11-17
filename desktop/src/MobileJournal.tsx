import { JournalCaptureButton, JournalAudio, JournalVoiceCapture, isJournalAudio, openJournalVoice } from "./JournalVoice";
import { invoke } from "@tauri-apps/api/core";
import { Fragment, memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, CalendarDays, Check, ChevronDown, Cloud, Copy, FileText, Hash, ImagePlus, Mic, Pin, Plus, RefreshCw, MoreHorizontal, Paperclip, Search, Share2, Sparkles, Clock3, Tag, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Image, tagsFor } from "./QuickJournal";
import type { QuickJournalItem } from "./JournalRecords";
import { JournalRichEditor, type JournalRichEditorHandle } from "./JournalRichEditor";
import { localJournalDate } from "./JournalViews";
import { QUICK_JOURNAL_UPDATED } from "./QuickJournalEvents";
import { userProfileStorage } from "./UserProfileStorage";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { compareJournalItems, emptyJournalScope, journalSearchActive, journalSearchMatches, journalSortLabels, JournalFilterForm, JournalQuickSearch, JournalSearchFilterBar, JournalSearchHeader, JournalViewMenu, withJournalTags, type JournalSearchScope, type JournalSort } from "./MobileJournalTools";
import "./MobileJournal.css";

type Record=QuickJournalItem["record"];
type EditDraft={record:Record;revision:string};
type Version={record:Record;revision:string;createdAt:number|null;deleted:boolean;error?:string};
type History={revision:string;versions:Version[];conflicts?:Version[]};
const scopeIcons={all:FileText,today:CalendarDays,pinned:Pin,attachments:Paperclip,untagged:Tag,pending:RefreshCw,trash:Trash2};
const pinKey="hub.journal.record-pins.v1",annotationKey="hub.journal.annotations.v1";
function read<T>(key:string,fallback:T):T{try{return JSON.parse(userProfileStorage.getItem(key)||"null")??fallback;}catch{return fallback;}}
function stamp(item:QuickJournalItem){return item.applied?"":item.uploaded?"已上传 · 等待电脑":"已存本机 · 待上传";}
function Dialog({title,children,onClose,className=""}:{title:string;children:ReactNode;onClose:()=>void;className?:string}){
 const ref=useRef<HTMLDialogElement>(null),latest=useRef(onClose);latest.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement|null;ref.current?.showModal();return()=>{ref.current?.close();if(previous?.isConnected)previous.focus({preventScroll:true});};},[]);
 return createPortal(<dialog ref={ref} className={`mobile-journal-dialog ${className}`} aria-label={title} onCancel={e=>{if(e.target!==e.currentTarget)return;e.preventDefault();latest.current();}} onClick={e=>{if(e.target===ref.current){const r=e.currentTarget.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)latest.current();}}}><header><h2>{title}</h2><button aria-label="关闭" onClick={()=>onClose()}><X size={21}/></button></header>{children}</dialog>,document.body);
}
const Body=memo(function Body({text,onTag}:{text:string;onTag?:(tag:string)=>void}){
 function tags(children:ReactNode):ReactNode{
  if(!onTag)return children;if(Array.isArray(children))return children.map((child,i)=><Fragment key={i}>{tags(child)}</Fragment>);if(typeof children!=="string")return children;
  const parts:ReactNode[]=[];let end=0;
  for(const match of children.matchAll(/(^|\s)#([^\s#]+)/gu)){parts.push(children.slice(end,match.index),match[1],<button type="button" className="mobile-journal-inline-tag" key={match.index} onClick={()=>onTag(match[2])}>#{match[2]}</button>);end=match.index!+match[0].length;}
  parts.push(children.slice(end));return parts;
 }

 return <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{a:({href,children})=>/^https?:\/\//.test(href||"")?<a href={href} onClick={e=>{e.preventDefault();void openUrl(href!);}}>{children}</a>:<span>{children}</span>,img:({src,alt})=>{const hash=src?.match(/_hub-assets\/([a-f0-9]{64})/)?.[1];return hash?<Image hash={hash} name={alt||"照片"}/>:<span>{alt}</span>;},p:({children})=><p>{tags(children)}</p>,li:({children})=><li>{tags(children)}</li>,strong:({children})=><strong>{tags(children)}</strong>,em:({children})=><em>{tags(children)}</em>}}>{text}</ReactMarkdown>;
});

function JournalCardText({text,selecting,onEdit,onSelect,children,attachments,onTag}:{text:string;onTag:(tag:string)=>void;selecting:boolean;onEdit:()=>void;onSelect:()=>void;children:ReactNode;attachments:number}){
 const ref=useRef<HTMLDivElement>(null),restore=useRef<number|null>(null),id=useId();
 const [expanded,setExpanded]=useState(false),[overflow,setOverflow]=useState(false);
 useLayoutEffect(()=>{
  const element=ref.current;if(!element)return;
  const scroller=element.closest<HTMLElement>(".mobile-journal-scroll");
  if(restore.current!==null&&scroller){scroller.scrollTop=Math.min(scroller.scrollTop,restore.current);restore.current=null;}
  const measure=()=>{if(!expanded)setOverflow(element.scrollHeight>element.clientHeight+1);};measure();
  const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):null;observer?.observe(element);return()=>observer?.disconnect();
 },[text,expanded]);
 const toggle=()=>{
  if(expanded){const element=ref.current,card=element?.closest("article"),scroller=element?.closest<HTMLElement>(".mobile-journal-scroll");if(card&&scroller)restore.current=Math.max(0,card.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop-12);}
  setExpanded(value=>!value);
 };
 return <div className={`mobile-journal-card-content${expanded?" is-expanded":""}`}>{expanded&&!selecting&&<button type="button" className="mobile-journal-expand mobile-journal-collapse-top" aria-controls={id} aria-expanded onClick={toggle}>收起全文</button>}
  <div ref={ref} id={id} className={`mobile-journal-copy${expanded?"":" is-collapsed"}`} role="button" tabIndex={0} aria-label={selecting?"选择这条记录":"编辑这条记录"} onClick={e=>{if(!selecting&&!(e.target as HTMLElement).closest("a,button"))onEdit();}} onKeyDown={e=>{if(e.key==="Enter"&&e.target===e.currentTarget){if(selecting)onSelect();else onEdit();}}}><Body text={text} onTag={onTag}/></div>
  {children}
  {!expanded&&attachments>1&&<small className="mobile-journal-attachment-count">共 {attachments} 个附件</small>}
  {(overflow||expanded||attachments>0)&&!selecting&&<button type="button" className="mobile-journal-expand" aria-controls={id} aria-expanded={expanded} onClick={toggle}>{expanded?"收起":"展开"}</button>}
 </div>;
}

export function MobileJournal({onBack,onInsights,targetId,onTargetHandled}:{onBack:()=>void;onInsights:()=>void;targetId?:string;onTargetHandled?:()=>void}){
 const [items,setItems]=useState<QuickJournalItem[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const [query,setQuery]=useState(""),[search,setSearch]=useState(false),[filter,setFilter]=useState("all"),[tag,setTag]=useState(""),[pins,setPins]=useState<string[]>(()=>read(pinKey,[]));
 const [editing,setEditing]=useState<QuickJournalItem|null>(null),[floating,setFloating]=useState("");
 const [panel,setPanel]=useState<{kind:string;item?:QuickJournalItem;version?:History["versions"][number]}>(),[history,setHistory]=useState<History>(),[busy,setBusy]=useState(false),[settings,setSettings]=useState<{settings:{sync:boolean};cloudEnabled:boolean;autoSync:boolean;error:string}>();
 const [annotations,setAnnotations]=useState<{[id:string]:Array<{text:string;at:number}>}>(()=>read(annotationKey,{}));
 const [sort,setSort]=useState<JournalSort>(()=>{const saved=read<string>("hub.journal.sort.v1","date-desc");return saved in journalSortLabels?saved as JournalSort:"date-desc";}),[selecting,setSelecting]=useState(false),[picked,setPicked]=useState<Set<string>>(new Set());
 const [scope,setScope]=useState<JournalSearchScope>(emptyJournalScope),[searchFilters,setSearchFilters]=useState(false),[searched,setSearched]=useState(false);
 const scrollRef=useRef<HTMLDivElement>(null),savedScroll=useRef<number|null>(null);
 const afterPanelClose=useRef<(()=>void)|undefined>(undefined);
 const alive=useRef(true),panelRef=useRef(panel);panelRef.current=panel;
 async function refresh(){try{const [result,configuration]=await Promise.all([invoke<{items:QuickJournalItem[];error:string}>("list_quick_journal"),invoke<typeof settings>("get_quick_journal_settings")]);if(alive.current){setItems(result.items);setSettings(configuration);setError(result.error||"");}}catch(e){if(alive.current)setError(String(e));}finally{if(alive.current)setLoading(false);}}
 useEffect(()=>{alive.current=true;void refresh();const update=()=>void refresh();const timer=setInterval(update,12000);window.addEventListener(QUICK_JOURNAL_UPDATED,update);return()=>{alive.current=false;clearInterval(timer);window.removeEventListener(QUICK_JOURNAL_UPDATED,update);};},[]);
 useEffect(()=>{if(targetId&&!loading){const item=items.find(v=>v.record.id===targetId);if(item)setEditing(item);else setError("该记录不在本机，未创建或替换任何记录。");onTargetHandled?.();}},[targetId,loading,items]);
 useEffect(()=>{if(!panel)return;const state={...window.history.state,hubJournalPanel:true};window.history.pushState(state,"");const pop=(e:PopStateEvent)=>{if(panelRef.current){e.stopImmediatePropagation();setPanel(undefined);const next=afterPanelClose.current;afterPanelClose.current=undefined;next?.();}};window.addEventListener("popstate",pop,true);return()=>window.removeEventListener("popstate",pop,true);},[!!panel]);
 const closePanel=(next?:()=>void)=>{afterPanelClose.current=next;if(window.history.state?.hubJournalPanel)window.history.back();else{setPanel(undefined);afterPanelClose.current=undefined;next?.();}};
 useEffect(()=>{
  if(!search&&!selecting){if(savedScroll.current!==null&&scrollRef.current){scrollRef.current.scrollTop=savedScroll.current;savedScroll.current=null;}return;}
  window.history.pushState({...window.history.state,hubJournalMode:search?"search":"select"},"");
  const pop=(e:PopStateEvent)=>{if(panelRef.current)return;e.stopImmediatePropagation();setSearch(false);setSelecting(false);setPicked(new Set());setQuery("");setScope(emptyJournalScope());};
  window.addEventListener("popstate",pop,true);return()=>window.removeEventListener("popstate",pop,true);
 },[search,selecting]);
 const leaveMode=()=>{if(window.history.state?.hubJournalMode)window.history.back();else{setSearch(false);setSelecting(false);setPicked(new Set());setQuery("");setScope(emptyJournalScope());}};
 const openSearch=()=>{savedScroll.current=scrollRef.current?.scrollTop||0;setNotice("");setError("");setQuery("");setScope(emptyJournalScope());setSearched(false);setSearch(true);};
 const chooseTag=useCallback((value:string)=>{setTag(value);setFilter("all");if(search){if(window.history.state?.hubJournalMode)window.history.back();else setSearch(false);}},[search]);
 const togglePicked=(id:string)=>setPicked(previous=>{const next=new Set(previous);next.has(id)?next.delete(id):next.add(id);return next;});
 const announce=(text:string)=>{setNotice(text);};
 async function sync(){if(busy)return;setBusy(true);setError("");try{await invoke("sync_quick_journal");announce("同步已结束，状态以电脑写入回执为准。");}catch(e){setError(String(e));}finally{await refresh();setBusy(false);}}
 async function mutate(item:QuickJournalItem,record:Record,deleted=Boolean(item.deleted)){
  if(!item.revision)throw new Error("记录版本暂不可读，请重新读取后重试");
  await invoke("update_quick_journal",{id:item.record.id,expectedRevision:item.revision,record,deleted});window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));
  announce("修改已保存在本机，按本设备设置同步到电脑。");await refresh();
 }
 async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setError("");try{await action();}catch(e){setError(String(e));}finally{setBusy(false);}}
 const copy=async(text:string)=>{await navigator.clipboard.writeText(text);announce("已复制");};
 async function batch(kind:"tag"|"delete",tags=""){
  await run(async()=>{const targets=items.filter(i=>picked.has(i.record.id)&&!i.deleted);if(!targets.length)return;
   for(const item of targets){const record=kind==="tag"?{...item.record,text:withJournalTags(item.record.text,tags)}:item.record;
    if(kind==="delete"||record.text!==item.record.text)await mutate(item,record,kind==="delete");
    setPicked(previous=>{const next=new Set(previous);next.delete(item.record.id);return next;});
   }
   announce(kind==="delete"?`${targets.length} 条记录已移到回收站`:`已为 ${targets.length} 条记录添加标签`);closePanel();
  });
 }
 async function action(kind:string,item:QuickJournalItem){
  if(kind==="edit"){closePanel(()=>setEditing(item));return;}
  if(kind==="copy"){await run(()=>copy(item.record.text));return;}
  if(kind==="link"){await run(()=>copy(`hub://journal/${item.record.id}`));return;}
  if(kind==="share"){await run(async()=>{await invoke("share_quick_journal",{text:item.record.text});});return;}
  if(kind==="pin"){try{const next=pins.includes(item.record.id)?pins.filter(id=>id!==item.record.id):[...pins,item.record.id];userProfileStorage.setItem(pinKey,JSON.stringify(next));setPins(next);closePanel();}catch(e){setError(String(e));}return;}
  if(kind==="float"){setFloating(item.record.id);closePanel();return;}
  if(kind==="history"){await run(async()=>{setHistory(await invoke<History>("quick_journal_history",{id:item.record.id}));setPanel({kind,item});});return;}
  setPanel({kind,item});
 }
 const filtered=items.filter(i=>(search?!i.deleted:filter==="trash"?i.deleted:!i.deleted)&&(search||filter!=="pinned"||pins.includes(i.record.id))&&(search||filter!=="attachments"||i.record.attachments.length>0)&&(search||filter!=="untagged"||!tagsFor(i.record.text).length)&&(search||filter!=="pending"||!i.applied)&&(search||filter!=="today"||i.record.date===localJournalDate())&&(search||!tag||tagsFor(i.record.text).includes(tag))&&(`${i.record.text} ${i.record.attachments.map(a=>a.name).join(" ")}`).toLowerCase().includes(query.toLowerCase())&&(!search||journalSearchMatches(i,scope))).sort((a,b)=>compareJournalItems(a,b,sort,pins));
 const showResults=!search||Boolean(query)||searched||journalSearchActive(scope);
 const names:{[key:string]:string}={all:"全部记录",today:"今天",pinned:"置顶",attachments:"有附件",untagged:"无标签",pending:"待同步",trash:"回收站"};
 const selected=panel?.item;
 const panelTitles:{[kind:string]:string}={views:"日志设置",recap:"每日回顾","search-date":"日期范围","search-tags":"标签范围","search-more":"更多条件","batch-tag":"添加标签","batch-delete":"删除所选记录"};
 return <section className="mobile-journal-feed" aria-label="日志"><header className="mobile-journal-header">
  {search?<JournalSearchHeader query={query} onQuery={setQuery} onCancel={leaveMode} onFilters={()=>setSearchFilters(v=>!v)} onSubmit={()=>setSearched(true)}/>:selecting?<div className="mobile-journal-selection-heading"><strong>已选中 {picked.size} 条笔记</strong><button onClick={leaveMode} disabled={busy}>完成</button></div>:<><button aria-label="返回浏览" onClick={onBack}><ArrowLeft size={22}/></button><h1 className="mobile-journal-title">日志</h1><div/><button aria-label="搜索日志" onClick={openSearch}><Search size={21}/></button><button aria-label="日志设置" aria-haspopup="dialog" onClick={()=>setPanel({kind:"views"})}><MoreHorizontal size={21}/></button></>}
  </header>
  <div className="mobile-journal-scroll" ref={scrollRef}>
  {!search&&<div className="mobile-journal-toolbar"><button className="mobile-journal-scope" aria-label={`切换日志范围，当前：${tag?"#"+tag:filter==="all"?"全部记录":names[filter]}`} aria-haspopup="dialog" onClick={()=>setPanel({kind:"nav"})}><span>{tag?"#"+tag:filter==="all"?"全部记录":names[filter]}</span><ChevronDown size={14}/></button><div className="mobile-journal-shortcuts"><button onClick={onInsights}><Sparkles size={16}/>AI 洞察</button><button onClick={()=>setPanel({kind:"recap"})}><Clock3 size={16}/>每日回顾</button></div></div>}
  {search&&<>{searchFilters&&<JournalSearchFilterBar scope={scope} onChoose={kind=>setPanel({kind:`search-${kind}`})}/>}<JournalQuickSearch onChoose={next=>{setScope(next);setSearched(true);}}/>{showResults&&<div className="mobile-journal-filter-summary"><span>{filtered.length} 条记录</span><button onClick={()=>{setScope(emptyJournalScope());setQuery("");setSearched(false);}}>清除条件</button></div>}</>}
  {!search&&(filter!=="all"||tag)&&<div className="mobile-journal-filter-summary"><span>{tag?`#${tag}`:names[filter]}</span><button onClick={()=>{setFilter("all");setTag("");}}>清除筛选</button></div>}
  {error&&<p role="alert" className="mobile-journal-error">{error}<button onClick={()=>void refresh()}>重新读取</button></p>}{notice&&<p role="status" className="mobile-journal-notice">{notice}</p>}
  {loading?<p role="status">正在读取记录…</p>:showResults&&filtered.slice(0,200).map(item=><article className={`mobile-journal-card${selecting&&picked.has(item.record.id)?" is-selected":""}`} key={item.record.id} data-record-id={item.record.id} onClickCapture={e=>{if(selecting){e.preventDefault();e.stopPropagation();togglePicked(item.record.id);}}}><header>{selecting&&<button className="mobile-journal-card-selector" aria-label={`选择记录 ${item.record.date}`} aria-pressed={picked.has(item.record.id)}>{picked.has(item.record.id)&&<Check size={15}/>}</button>}<span>{pins.includes(item.record.id)?"置顶 · ":""}{item.record.date}</span><small>{stamp(item)}</small>{!selecting&&<button aria-label={`记录操作 ${item.record.date}`} onClick={()=>setPanel({kind:"menu",item})}><MoreHorizontal size={19}/></button>}</header>
    <JournalCardText text={item.record.text} onTag={chooseTag} attachments={item.record.attachments.length} selecting={selecting} onEdit={()=>setEditing(item)} onSelect={()=>togglePicked(item.record.id)}>
    <div className="mobile-journal-photos">{item.record.attachments.filter(a=>a.image).map(a=><button key={a.hash} aria-label={`查看照片 ${a.name}`} onClick={()=>setPanel({kind:"photo",item,version:{record:{...item.record,attachments:[a]},revision:item.revision||"",createdAt:null,deleted:false}})}><Image hash={a.hash} name={a.name}/></button>)}</div>
    <div className="mobile-journal-files">{item.record.attachments.filter(a=>!a.image).map(a=>isJournalAudio(a.name)?<JournalAudio key={a.hash} attachment={a} onContinue={!item.deleted&&item.revision?()=>openJournalVoice({record:item.record,revision:item.revision}):undefined}/>:<button key={a.hash} onClick={()=>void run(async()=>{await invoke("export_quick_journal_attachment",{id:item.record.id,hash:a.hash,destination:""});})}><Paperclip size={18}/>{a.name}</button>)}</div>
    </JournalCardText>


    {item.deleted&&<button className="mobile-journal-restore" disabled={busy} onClick={()=>void run(async()=>{await mutate(item,item.record,false);})}>恢复记录</button>}{item.sourceError&&<div role="alert"><p>{item.sourceError}</p><button className="mobile-journal-restore" onClick={()=>void action("history",item)}>查看未同步修改</button></div>}
  </article>)}
  {showResults&&!loading&&!filtered.length&&<div className="mobile-journal-empty"><h2>{search||filter!=="all"?"没有符合条件的记录":"记下一点新的想法"}</h2><p>{search?"试试调整关键词或筛选。":"点下方的＋开始写，也可以调整筛选。"}</p></div>}
  {showResults&&filtered.length>200&&<p>请使用日期、标签或搜索缩小范围，当前显示前200条。</p>}</div>
  {!search&&!selecting&&<div className="mobile-journal-create"><JournalCaptureButton/></div>}
  {selecting&&<div className="mobile-journal-batch-dock"><button disabled={!picked.size||busy} onClick={()=>setPanel({kind:"batch-tag"})}><Tag size={20}/>添加标签</button><button disabled={!picked.size||busy} onClick={()=>void run(()=>copy(items.filter(i=>picked.has(i.record.id)).map(i=>i.record.text).join("\n\n---\n\n")))}><Copy size={20}/>复制全部</button><button disabled={!picked.size||busy} onClick={()=>setPanel({kind:"batch-delete"})}><Trash2 size={20}/>删除</button></div>}
  {floating&&items.find(i=>i.record.id===floating)&&<aside className="mobile-journal-floating"><button onClick={()=>setEditing(items.find(i=>i.record.id===floating)!)}>{items.find(i=>i.record.id===floating)!.record.text.slice(0,28)}</button><button aria-label="关闭便览" onClick={()=>setFloating("")}><X size={17}/></button></aside>}
  {panel&&<Dialog title={panelTitles[panel.kind]||(panel.kind==="menu"?"记录操作":panel.kind==="sync"?"速记同步":panel.kind==="nav"?"日志范围":panel.kind==="history"?"历史版本":panel.kind==="version"?"历史版本详情":panel.kind==="date"?"设定日期":panel.kind==="delete"?"删除记录":panel.kind==="annotate"?"添加批注":panel.kind==="related"?"相关笔记":"记录详情")} className={panel.kind==="menu"?"journal-menu-dialog":panel.kind==="views"?"journal-view-dialog":""} onClose={closePanel}>
    {error&&<p role="alert" className="mobile-journal-error">{error}</p>}
    {panel.kind==="views"&&<><JournalViewMenu sort={sort} onSort={next=>{try{userProfileStorage.setItem("hub.journal.sort.v1",JSON.stringify(next));setSort(next);closePanel();}catch(e){setError(String(e));}}} onSelect={()=>{savedScroll.current=scrollRef.current?.scrollTop||0;closePanel(()=>{setPicked(new Set());setSelecting(true);});}}/><div className="mobile-journal-menu-list"><button aria-label="速记同步状态" onClick={()=>setPanel({kind:"sync"})}><Cloud size={20}/><span><strong>同步状态与重试</strong><small>{items.filter(i=>!i.deleted&&!i.uploaded).length} 条待上传 · {items.filter(i=>!i.deleted&&i.uploaded&&!i.applied).length} 条等待电脑</small></span><ChevronDown size={16}/></button><button onClick={()=>void run(async()=>{const result=await invoke<{status:string}>("add_quick_journal_tile");announce(result.status);})}><Plus size={20}/><span><strong>控制中心入口</strong><small>快速打开“记一条”</small></span><ChevronDown size={16}/></button></div></>}
    {panel.kind.startsWith("search-")&&<JournalFilterForm key={panel.kind} kind={panel.kind.slice(7)} scope={scope} tags={[...new Set(items.filter(i=>!i.deleted).flatMap(i=>tagsFor(i.record.text)))]} onApply={next=>{setScope(next);setSearched(true);closePanel();}}/>}
    {panel.kind==="batch-tag"&&<form onSubmit={e=>{e.preventDefault();void batch("tag",String(new FormData(e.currentTarget).get("tags")||""));}}><label>标签<input name="tags" placeholder="#标签，可输入多个" maxLength={500} required/></label><p>给所选 {picked.size} 条记录添加标签，保留原正文和历史。</p><button disabled={busy||!picked.size}>确定</button></form>}
    {panel.kind==="batch-delete"&&<><p>将所选 {picked.size} 条记录移到回收站？正文、附件和历史均保留。</p><button className="destructive" disabled={busy||!picked.size} onClick={()=>void batch("delete")}>移到回收站</button></>}
    {panel.kind==="nav"&&<div className="mobile-journal-menu-list">{Object.entries(names).map(([key,label])=>{const Icon=scopeIcons[key as keyof typeof scopeIcons];return <button key={key} aria-pressed={!tag&&filter===key} onClick={()=>{setFilter(key);setTag("");closePanel();}}><Icon size={19}/><span>{label}</span><small>{items.filter(i=>key==="trash"?i.deleted:!i.deleted&&(key!=="pinned"||pins.includes(i.record.id))&&(key!=="attachments"||i.record.attachments.length>0)&&(key!=="untagged"||!tagsFor(i.record.text).length)&&(key!=="pending"||!i.applied)&&(key!=="today"||i.record.date===localJournalDate())).length}</small>{!tag&&filter===key?<Check size={17}/>:<span aria-hidden/>}</button>})}{[...new Set(items.flatMap(i=>tagsFor(i.record.text)))].map(t=><button key={t} onClick={()=>{chooseTag(t);closePanel();}}><Hash size={15}/>{t}</button>)}</div>}
    {panel.kind==="recap"&&<div className="mobile-journal-recap"><p>重温以前的真实记录。</p>{items.filter(i=>!i.deleted&&i.record.date<localJournalDate()).sort((a,b)=>b.record.date.localeCompare(a.record.date)).slice(0,3).map(i=><button key={i.record.id} onClick={()=>setPanel({kind:"details",item:i})}><small>{i.record.date}</small><span>{i.record.text.slice(0,160)||"附件记录"}</span></button>)}{!items.some(i=>!i.deleted&&i.record.date<localJournalDate())&&<p>还没有可回顾的往日记录，先留下今天的想法吧。</p>}</div>}
    {panel.kind==="sync"&&<div className="mobile-journal-sync"><div>{[[items.filter(i=>!i.uploaded).length,"待上传"],[items.filter(i=>i.uploaded&&!i.applied).length,"等电脑"],[items.filter(i=>i.applied).length,"已写入"]].map(([count,label])=><span key={label}><strong>{count}</strong>{label}</span>)}</div><p>{!settings?.settings.sync||!settings.cloudEnabled?"本设备速记同步已暂停，记录仍在本机。":!settings.autoSync?"自动同步已暂停，可在本页手动重试。":"保存后自动尝试上传，无需跳转云同步设置。电脑在线后写入 OS。"}</p><button disabled={busy} onClick={()=>void sync()}>{busy?"同步中…":"同步 / 重试"}</button><button onClick={()=>{closePanel(openCloudSyncSettings);}}>同步设置</button></div>}
    {panel.kind==="menu"&&selected&&<><div className="mobile-journal-primary">{([["share","分享",Share2],["edit","编辑",ImagePlus],["copy","复制",Copy]] as const).map(([kind,label,Icon])=><button key={kind} onClick={()=>void action(kind,selected)}><Icon size={23}/>{label}</button>)}</div><div className="mobile-journal-menu-list">{[["pin",pins.includes(selected.record.id)?"取消置顶":"置顶"],["float","加入浮窗"],["related","相关笔记"],["details","查看详情"],["history","历史版本"],["link","复制链接"],["annotate","批注"],["date","设定日期"],["delete","删除"]].map(([kind,label])=><button key={kind} className={kind==="delete"?"destructive":""} disabled={busy} onClick={()=>void action(kind,selected)}>{label}</button>)}</div><footer><p>正文字符：{[...selected.record.text].length}</p><p>创建日期：原记录未保存该信息</p><p>最后编辑：{selected.modifiedAt?new Date(selected.modifiedAt).toLocaleDateString("zh-CN"):"未记录"}</p></footer></>}
    {panel.kind==="history"&&selected&&<div className="mobile-journal-menu-list">{history?.versions.slice().reverse().map((v,i)=><button key={v.revision} onClick={()=>setPanel({kind:"version",item:selected,version:v})}><span>版本 {history.versions.length-i-1} · {v.record.date}<small>{v.record.text.slice(0,55)}</small></span></button>)}{Boolean(history?.conflicts?.length)&&<h3>未写入电脑的修改</h3>}{history?.conflicts?.slice().reverse().map(v=><button key={v.revision} onClick={()=>setPanel({kind:"version",item:selected,version:v})}><span>查看保留的内容<small>{v.record.text.slice(0,55)}</small></span></button>)}<p>恢复会保留当前版本，原 ID 不变。</p></div>}
    {panel.kind==="version"&&selected&&panel.version&&<>{panel.version.error&&<p role="alert">{panel.version.error}。这份内容已保留，可先复制并核对电脑原文。</p>}<Body text={panel.version.record.text}/><button onClick={()=>void run(()=>copy(panel.version!.record.text))}>复制这份内容</button>{!panel.version.error&&<button disabled={busy} onClick={()=>void run(async()=>{await mutate(selected,panel.version!.record,panel.version!.deleted);closePanel();})}>恢复此版本</button>}</>}
    {panel.kind==="date"&&selected&&<form onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void run(async()=>{await mutate(selected,{...selected.record,date:String(data.get("date"))});closePanel();});}}><label>记录日期<input type="date" name="date" defaultValue={selected.record.date} required/></label><p>保持原记录 ID，电脑按变更核对后移动独立区块。</p><button disabled={busy}>保存日期</button></form>}
    {panel.kind==="delete"&&selected&&<><p>移到回收站？正文、附件及版本历史保留，可以恢复。</p><button className="destructive" disabled={busy} onClick={()=>void run(async()=>{await mutate(selected,selected.record,true);closePanel();})}>移到回收站</button></>}
    {panel.kind==="annotate"&&selected&&<form onSubmit={e=>{e.preventDefault();const text=String(new FormData(e.currentTarget).get("annotation")||"").trim();if(!text)return;try{const next={...annotations,[selected.record.id]:[...(annotations[selected.record.id]||[]),{text,at:Date.now()}]};userProfileStorage.setItem(annotationKey,JSON.stringify(next));setAnnotations(next);setPanel({kind:"details",item:selected});}catch(e){setError(String(e));}}}><label>批注内容<textarea name="annotation" maxLength={4000} required/></label><p>批注单独保存在本设备，不改原正文。</p><button>保存批注</button></form>}
    {panel.kind==="details"&&selected&&<><p>{selected.record.date} · {selected.applied?"已写入 OS":stamp(selected)}</p><Body text={selected.record.text}/>{(annotations[selected.record.id]||[]).map(a=><blockquote key={a.at}>{a.text}</blockquote>)}</>}
    {panel.kind==="related"&&selected&&<div className="mobile-journal-menu-list">{items.filter(i=>i.record.id!==selected.record.id&&!i.deleted&&tagsFor(i.record.text).some(t=>tagsFor(selected.record.text).includes(t))).map(i=><button key={i.record.id} onClick={()=>{closePanel(()=>setEditing(i));}}>{i.record.text.slice(0,60)}</button>)}<p>按相同标签关联，不猜测 AI 关系。</p></div>}
    {panel.kind==="photo"&&selected&&panel.version&&<><div className="mobile-journal-photo-view"><Image hash={panel.version.record.attachments[0].hash} name={panel.version.record.attachments[0].name}/></div><button onClick={()=>void run(async()=>{await invoke("export_quick_journal_attachment",{id:selected.record.id,hash:panel.version!.record.attachments[0].hash,destination:""});})}>保存原图</button></>}
  </Dialog>}
  {editing&&<MobileJournalEditor key={editing.record.id} item={editing} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);void refresh();}}/>}
 </section>;
}

function MobileJournalEditor({item,onClose,onSaved}:{item:QuickJournalItem;onClose:()=>void;onSaved:()=>void}){
 const [voiceOpen,setVoiceOpen]=useState(false);
 const [draft,setDraft]=useState<EditDraft>({record:structuredClone(item.record),revision:item.revision||""}),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[more,setMore]=useState(false),[status,setStatus]=useState("");
 const latest=useRef(draft),writes=useRef<Promise<unknown>>(Promise.resolve()),editor=useRef<JournalRichEditorHandle>(null),files=useRef<HTMLInputElement>(null),photos=useRef<HTMLInputElement>(null),ref=useRef<HTMLDialogElement>(null),saving=useRef(false),attaching=useRef(false),closing=useRef(false),finishRef=useRef<(pop?:boolean)=>Promise<void>>(async()=>{});
 const slot=`edit:${item.record.id}`;
 useEffect(()=>{let live=true;void invoke<string>("get_quick_journal_draft",{slot}).then(raw=>{if(!live)return;if(raw){const value=JSON.parse(raw) as EditDraft;if(value.record.id!==item.record.id||!Array.isArray(value.record.attachments)||typeof value.revision!=="string")throw new Error("编辑草稿身份无效");setDraft(value);latest.current=value;if(value.revision!==item.revision)setError("原记录版本已变化，保留了未提交草稿；请复制草稿后与最新记录核对。");}setReady(true);requestAnimationFrame(()=>{editor.current?.focus();void invoke("focus_quick_journal_editor").catch(()=>{});});}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[slot]);
 const change=(record:Record)=>{const value={...latest.current,record};latest.current=value;setDraft(value);setStatus("正在保留草稿…");writes.current=writes.current.catch(()=>{}).then(()=>invoke("save_quick_journal_draft",{slot,draft:JSON.stringify(value)}));void writes.current.then(()=>setStatus("草稿已保存"),e=>{setError(`草稿未保存：${String(e)}`);setStatus("草稿暂未保存");});};
 const dirty=JSON.stringify(item.record)!==JSON.stringify(draft.record);
 async function finish(pop=false){if(attaching.current){setError("附件仍在保存，请稍后再返回。");if(pop)window.history.pushState({...window.history.state,hubJournalEditor:item.record.id},"");return;}if(saving.current)return;if(!ready){closing.current=true;if(!pop&&window.history.state?.hubJournalEditor===item.record.id)window.history.back();onClose();return;}saving.current=true;setBusy(true);setError("");try{
   await writes.current;
   const value=latest.current;
   if(JSON.stringify(value.record)!==JSON.stringify(item.record)){
    if(value.revision!==item.revision)throw new Error("原记录已变化，草稿保留。请核对后再提交。");
    await invoke("update_quick_journal",{id:item.record.id,expectedRevision:value.revision,record:value.record,deleted:Boolean(item.deleted)});
    window.dispatchEvent(new CustomEvent(QUICK_JOURNAL_UPDATED));
   }
   await invoke("save_quick_journal_draft",{slot,draft:""});closing.current=true;
   if(!pop&&window.history.state?.hubJournalEditor===item.record.id)window.history.back();
   onSaved();
  }catch(e){setError(String(e));if(pop)window.history.pushState({...window.history.state,hubJournalEditor:item.record.id},"");}finally{saving.current=false;setBusy(false);}}
 finishRef.current=finish;
 useEffect(()=>{ref.current?.showModal();const state={...window.history.state,hubJournalEditor:item.record.id};window.history.pushState(state,"");const pop=(event:PopStateEvent)=>{event.stopImmediatePropagation();if(!closing.current)void finishRef.current(true);};window.addEventListener("popstate",pop,true);return()=>{window.removeEventListener("popstate",pop,true);ref.current?.close();};},[]);
 async function attach(list:FileList|null){if(!list?.length||saving.current||attaching.current)return;attaching.current=true;setBusy(true);setError("");try{
   if(latest.current.record.attachments.length+list.length>9)throw new Error("每条最多9个附件");
   for(const file of Array.from(list)){if(file.size>20*1024*1024)throw new Error(`${file.name} 超过20 MB`);const content=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(",",2)[1]);reader.onerror=()=>reject(new Error("附件读取失败"));reader.readAsDataURL(file);});const attachment=await invoke<Record["attachments"][number]>("stage_quick_journal_attachment",{name:file.name,content});change({...latest.current.record,attachments:[...latest.current.record.attachments,attachment]});}
  }catch(e){setError(String(e));}finally{attaching.current=false;setBusy(false);if(files.current)files.current.value="";if(photos.current)photos.current.value="";}}
 return createPortal(<dialog className="mobile-journal-editor" ref={ref} aria-label="编辑日志" onCancel={e=>{if(e.target!==e.currentTarget)return;e.preventDefault();void finish();}}><header><button aria-label={dirty?"保存修改并返回":"返回日志"} disabled={busy||!ready} onClick={()=>void finish()}>{dirty?<Check size={23}/>:<ArrowLeft size={23}/>}</button><span className="sr-only">编辑日志</span><button aria-label="保留草稿并关闭" disabled={busy} onClick={()=>{closing.current=true;if(window.history.state?.hubJournalEditor)window.history.back();onClose();}}><X size={21}/></button></header><p className="mobile-journal-editor-date">{draft.record.date}</p><form onSubmit={e=>{e.preventDefault();void finish();}}><JournalRichEditor ref={editor} value={draft.record.text} onChange={text=>change({...latest.current.record,text})} disabled={!ready||busy} onPhotos={()=>photos.current?.click()} onMore={()=>setMore(!more)} moreOpen={more} onSubmit={()=>void finish()} actions={<button type="button" aria-label="本地录音" title="仅在本机保存原音" disabled={!ready||busy} onClick={()=>{void writes.current.then(()=>setVoiceOpen(true)).catch(e=>setError(String(e)));}}><Mic size={21}/></button>}/><div className="mobile-journal-editor-attachments">{draft.record.attachments.map((a,i)=><div key={`${a.hash}:${i}`} className={isJournalAudio(a.name)?"mobile-journal-editor-audio":undefined}>{a.image?<Image hash={a.hash} name={a.name}/>:isJournalAudio(a.name)?<JournalAudio attachment={a}/>:<span>{a.name}</span>}<button type="button" aria-label={`移除附件 ${a.name}`} disabled={busy} onClick={()=>change({...latest.current.record,attachments:latest.current.record.attachments.filter((_,n)=>n!==i)})}><X size={16}/></button></div>)}</div>{more&&<div className="mobile-journal-editor-more"><label>记录日期<input type="date" value={draft.record.date} onChange={e=>change({...latest.current.record,date:e.target.value})}/></label><button type="button" onClick={()=>files.current?.click()}><Paperclip size={17}/>添加文件</button></div>}<input type="file" ref={photos} accept="image/*" multiple hidden onChange={e=>void attach(e.target.files)}/><input type="file" ref={files} multiple hidden onChange={e=>void attach(e.target.files)}/><p role="status">{busy?"保存中…":status}</p>{error&&<div role="alert"><p>{error}</p><button type="button" onClick={()=>void navigator.clipboard.writeText(latest.current.record.text)}>复制保留的草稿</button></div>}</form>{voiceOpen&&<JournalVoiceCapture request={{record:draft.record,revision:draft.revision,onSave:async record=>{change(record);await writes.current;}}} onClose={()=>setVoiceOpen(false)}/>}</dialog>,document.body);
}
