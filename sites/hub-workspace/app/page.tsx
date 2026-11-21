"use client";
import {CraftReadingExport} from "./CraftReadingExport";

import React, { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { PreviewThemeControls, PreviewSampleBlocks, previewSample, type PreviewTheme } from './PreviewTheme';
import { Search, MessageSquare, PanelLeft, Bookmark, ListTodo, CalendarDays, Sparkles, Star, Clock3, Tags, BookOpenCheck, Layers, Cloud, Settings2, SlidersHorizontal, PanelRight, Plus, X, ChevronDown, ArrowLeft, ArrowRight, Pin, Link2, ExternalLink, Check, Circle, CheckCircle2, Columns3, LayoutList, LayoutGrid, Table2, FileText, ArrowUpRight, RotateCcw, Folder, Hash, BookOpen, Palette, Sun, Moon, Pencil, ChevronLeft, ChevronRight, CircleHelp, Command, GripVertical, Monitor, MoreHorizontal, CheckCheck, Quote, ArrowDown, Archive, Globe2 } from "lucide-react";
import Insights from "./Insights";
import RecentOpen, { readRecentEntries, type RecentEntry } from "./RecentOpen";
import {assistantLibraryCatalog,assistantLibraryNode,isLibraryReference} from "./assistant-library-drag";
import LibraryBrowser from "./LibraryBrowser";
import SidebarResize,{useSidebarWidths} from "./SidebarResize";
import FlashcardsSite from "./FlashcardsSite";
import CloudSyncCenter, {type CloudPage,type RelatedSetting} from "./CloudSyncCenter";
import {localTaskSamples} from "./task-data";
import TaskWorkspace from "./TaskWorkspace";
import JournalSite from "./JournalSite";
import {localJournalDate} from "./journal-local/JournalViews";
import type {JournalCaptureTask} from "./journal-capture";
import TagWorkspace from "./TagWorkspace";
import { tagExamples, useTagReview, type TagTask } from "./tag-assistant";
import InsightPanel from "./InsightPanel";
import { appendAssistantAnswer, pageBody, visibleAssistantSections, type PageInsertion } from './assistant-insert';
import Assistant, { type AssistantContext } from "./Assistant";
import { initialItems, sourceMeta, type HubItem, type SourceId, type ItemKind } from "./data";
import { MIGRATED_HUB_ITEMS } from "./insight-migration";
import { recordAssistantDraft } from "./insight-workflow";
import { isPublicPractice, parsePracticeMarkdown, projectPracticeDocument, practiceChecked, practiceMarkdown, publicPracticeLinks } from "./public-practice";
import { REPORT_HUB_ITEMS, SOURCE_FIXTURES, getSourceHubItem } from "./insight-reports";
import { getLedger, subscribeLedger, getVisibleFinding, getInsightValidity, isSourceAccessible, isInsightAccessible, executeLedger, ledgerId, type LedgerState } from "./insight-ledger";

type View = "libraries" | "all" | "reading" | "tasks" | "journal" | "insights" | "favorites" | "tags" | "flashcards" | "cloud" | "settings";
type ModalName = "settings" | "new" | "collection" | "sources" | "about" | null;
type InsightMode = "current" | "explore";
type InsightScope = "all" | "review" | "starred" | "knowledge" | "life" | "decision" | "cases";
type WorkspaceItem = HubItem & { originSourceIds?: string[] };
type DraftOrigin = { insightId: string; workId?: string; sourceIds?: string[] };
const STORAGE = "hub-workspace-prototype-v1";
const workspaceItems = [previewSample,...initialItems,...localTaskSamples, ...MIGRATED_HUB_ITEMS, ...REPORT_HUB_ITEMS, ...tagExamples];
const views: {id:View; title:string; icon:typeof Search}[] = [
  {id:"all",title:"全部内容",icon:Search}, {id:"libraries",title:"库结构",icon:Folder}, {id:"reading",title:"阅读",icon:Bookmark}, {id:"tasks",title:"任务",icon:ListTodo}, {id:"journal",title:"日志",icon:CalendarDays}, {id:"insights",title:"洞察",icon:Sparkles}, {id:"favorites",title:"收藏",icon:Star}, {id:"tags",title:"标签",icon:Tags}, {id:"flashcards",title:"闪卡复习",icon:BookOpenCheck}
];
const themes = [
  {id:"white",name:"纯白",color:"#ffffff"}, {id:"black",name:"纯黑",color:"#0d0e11"}, {id:"paper",name:"纸间",color:"#f4f0e8"}, {id:"sage",name:"夜读绿",color:"#182923"}, {id:"mist",name:"雾蓝",color:"#e9eff5"}, {id:"lavender",name:"暮紫",color:"#eeeaf5"}, {id:"rose",name:"浅蔷薇",color:"#f7e9e7"}, {id:"sand",name:"暖砂",color:"#eee8db"}
];
const accents:Record<string,string> = {sage:"#536e60",blue:"#3479d4",purple:"#8462bd",amber:"#a57739",rose:"#b76076",graphite:"#636874"};
const darkAccents:Record<string,string>={sage:"#a5c3af",blue:"#94b9f0",purple:"#c5ace8",amber:"#dec39a",rose:"#dfa3b5",graphite:"#b9c1cd"};
const themeAccents:Record<string,string>={white:"sage",black:"graphite",paper:"amber",sage:"sage",mist:"blue",lavender:"purple",rose:"rose",sand:"amber"};
const groupOrder = ["今天","昨天","本周","上周"];
const taskLabels:Record<string,string> = {todo:"待办",doing:"进行中",waiting:"等待条件",done:"已完成"};
const readLabels:Record<string,string> = {inbox:"待读",reading:"进行中",done:"已读",archived:"归档",abandoned:"放弃"};

function SourceIcon({source, small=false}:{source:SourceId;small?:boolean}) {
  const meta=sourceMeta[source];
  return <span className={"source-icon source-"+source+(small?" small":"")} aria-hidden="true">{source==="ticktick"?<Check size={small?11:14}/>:source==="obsidian"?<span className="obsidian-gem"/>:source==="feishu"?<span className="feishu-mark"/>:meta.icon}</span>;
}
function PracticeText({ text }: { text: string }) {
 return <>{publicPracticeLinks(text).map((part,index)=>part.href?<a key={index} href={part.href} target="_blank" rel="noopener noreferrer" style={{color:"var(--accent)",textDecoration:"underline",textUnderlineOffset:"3px",overflowWrap:"anywhere"}}>{part.text}</a>:<React.Fragment key={index}>{part.text}</React.Fragment>)}</>;
}
function IconButton({children,label,onClick,active=false,disabled=false,className=""}:{children:ReactNode;label:string;onClick:()=>void;active?:boolean;disabled?:boolean;className?:string}) {
 return <button type="button" className={"icon-button "+(active?"active ":"")+className} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}
function Modal({title,children,onClose,wide=false}:{title:string;children:ReactNode;onClose:()=>void;wide?:boolean}) {
 const ref=useRef<HTMLDivElement>(null);
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>{const previous=document.activeElement as HTMLElement; const el=ref.current; const timer=setTimeout(()=>(el?.querySelector<HTMLElement>("input,textarea,select")||el?.querySelector<HTMLElement>("button"))?.focus(),40);const fn=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();e.stopImmediatePropagation();closeRef.current();}if(e.key==="Tab"&&el){const list=Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]),input,select,textarea,[tabindex="0"],a[href]'));const first=list[0],last=list[list.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}; document.addEventListener("keydown",fn,true);return()=>{clearTimeout(timer);document.removeEventListener("keydown",fn,true);previous?.focus();};},[]);
 return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><div className={"modal "+(wide?"wide":"")} ref={ref} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><IconButton label="关闭弹窗" onClick={onClose}><X size={18}/></IconButton></header>{children}</div></div>;
}

export default function Hub() {
 const [items,setItems]=useState<WorkspaceItem[]>(workspaceItems);
 useEffect(()=>{const route=new URLSearchParams(window.location.search).get("view");if(["libraries","tasks","journal","tags","flashcards","cloud","settings"].includes(route||""))setView(route as View);const section=new URLSearchParams(window.location.search).get("section");if(["cache","journal","sources","backup"].includes(section||""))setRelatedSetting(section as RelatedSetting);},[]);
 const [ledger,setLedger]=useState<LedgerState>(()=>getLedger());
 const [libraryTarget,setLibraryTarget]=useState("");
 const [taskTarget,setTaskTarget]=useState("");
 const [view,setView]=useState<View>("all");
 const [filter,setFilter]=useState("all");
 const [query,setQuery]=useState("");
 const [sources,setSources]=useState<SourceId[]>([]);
 const [selectedId,setSelectedId]=useState("codex-hub");
 const [favorites,setFavorites]=useState<string[]>(["ui-design","dxf-guide","read-craft"]);
 const [history,setHistory]=useState<RecentEntry[]>(readRecentEntries(["codex-hub","ui-design","harness"]));
 const [recordRecent,setRecordRecent]=useState(true);
 const [searchOpen,setSearchOpen]=useState(false);
 const [theme,setTheme]=useState("white");
 const [accent,setAccent]=useState("theme");
 const resolvedAccent=accent==="theme"?(themeAccents[theme]??"sage"):accent;
 const [density,setDensity]=useState("compact");
 const [sidebar,setSidebar]=useState(true);
 const {width:sidebarWidth,setWidth:setSidebarWidth,resetAll:resetSidebarWidths}=useSidebarWidths(view);
 const [listWidth,setListWidth]=useState(43);
 const [preview,setPreview]=useState(true);
 const [previewTheme,setPreviewTheme]=useState<PreviewTheme>('current');
 const [focused,setFocused]=useState(false);
 const [mobileDetail,setMobileDetail]=useState(false);
 const [layout,setLayout]=useState("list");
 const [modal,setModal]=useState<ModalName>(null);
 const [settingsTab,setSettingsTab]=useState("data");
 const [relatedSetting,setRelatedSetting]=useState<RelatedSetting>("cache");
 const [cloudPage,setCloudPage]=useState<CloudPage>("overview");
 const settingsReturn=useRef<View>("all");
 const cloudReturn=useRef<View>("all");
 const [filterOpen,setFilterOpen]=useState(false);
 const [hydrated,setHydrated]=useState(false);
 const [toast,setToast]=useState("");
 const [newKind,setNewKind]=useState<ItemKind>("note");
 const [newTitle,setNewTitle]=useState("");
 const [newBody,setNewBody]=useState("");
 const [collectionName,setCollectionName]=useState("");
 const [collectionTerm,setCollectionTerm]=useState("");
 const [collections,setCollections]=useState<{name:string;term:string}[]>([{name:"使用 AI",term:"AI"}]);
 const [journalDate,setJournalDate]=useState("");
 const [calendarMonth,setCalendarMonth]=useState(10);
 const [review,setReview]=useState(false);
 const [insightMode,setInsightMode]=useState<InsightMode>("current");
 const [insightScope,setInsightScope]=useState<InsightScope>("all");
 const [returnToInsights,setReturnToInsights]=useState(false);
 const insightReturn=useRef({filter:"all",review:false,mode:"current" as InsightMode,scope:"all" as InsightScope,query:""});
 const [tagEntry,setTagEntry]=useState<{tag?:string;task?:TagTask}|null>(null);
 const [tagReviewTarget,setTagReviewTarget]=useState<{id:string;time:number}|null>(null);
 const [assistantOpen,setAssistantOpen]=useState(false);
 const [sourceDemo,setSourceDemo]=useState(false);
 const [uiDemo,setUiDemo]=useState(false);
 const [activityDemo,setActivityDemo]=useState(false);
 useEffect(()=>{const mode=new URLSearchParams(window.location.search).get("assistant");if(mode==="ui-demo")setUiDemo(true);if(mode==="source-demo")setSourceDemo(true);if(mode==="activity-demo")setActivityDemo(true);if(mode==="1"||mode==="source-demo"||mode==="activity-demo"||mode==="ui-demo")setAssistantOpen(true);},[]);
 const [assistantExpanded,setAssistantExpanded]=useState(false);
 const [assistantContext,setAssistantContext]=useState<AssistantContext|null>(null);
 const [checkMarks,setCheckMarks]=useState<Record<string,boolean>>({});
 const searchRef=useRef<HTMLInputElement>(null);
 const articleRef=useRef<HTMLDivElement>(null);
 const changePreviewTheme=(next:PreviewTheme)=>{
  const scroller=articleRef.current;
  const top=scroller?.getBoundingClientRect().top??0;
  const anchor=scroller&&Array.from(scroller.querySelectorAll<HTMLElement>('.document-title,.document-meta,.document-body > *,.document-tags,.document-related')).find(node=>node.getBoundingClientRect().bottom>top);
  const offset=anchor?.getBoundingClientRect().top??0;
  const atStart=!scroller||scroller.scrollTop===0;
  setPreviewTheme(next);
  requestAnimationFrame(()=>{
   if(!scroller||!anchor||atStart)return;
   scroller.style.scrollBehavior='auto';
   scroller.scrollTop+=anchor.getBoundingClientRect().top-offset;
   scroller.style.scrollBehavior='';
  });
 };
 const toastTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const notify=(message:string)=>{setToast(message);if(toastTimer.current)clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(""),3600);};

 useEffect(()=>{setLedger(getLedger());return subscribeLedger(setLedger);},[]);

 useEffect(()=>{try{const saved=JSON.parse(localStorage.getItem(STORAGE)||"null");if(saved&&saved.version===1){if(Array.isArray(saved.items)){const valid=saved.items.filter((item:HubItem)=>item&&typeof item.id==="string"&&typeof item.title==="string"&&sourceMeta[item.source]&&Array.isArray(item.sections)&&Array.isArray(item.tags));const known=new Set(valid.map((item:HubItem)=>item.id));setItems([...valid,...workspaceItems.filter(item=>!known.has(item.id))]);}if(Array.isArray(saved.favorites))setFavorites(saved.favorites);if(Array.isArray(saved.history))setHistory(readRecentEntries(saved.history));if(saved.recordRecent===false)setRecordRecent(false);if(["current","craft"].includes(saved.previewTheme))setPreviewTheme(saved.previewTheme);if(themes.some(t=>t.id===saved.theme))setTheme(saved.theme);if(typeof saved.accentPreference==="string"&&Object.hasOwn(accents,saved.accentPreference))setAccent(saved.accentPreference);if(["compact","comfortable"].includes(saved.density))setDensity(saved.density);if(Array.isArray(saved.collections))setCollections(saved.collections);if(saved.checkMarks&&typeof saved.checkMarks==="object")setCheckMarks(saved.checkMarks);}}catch{}const entryTheme=new URLSearchParams(window.location.search).get("preview");if(entryTheme==="current"||entryTheme==="craft")setPreviewTheme(entryTheme);if(window.innerWidth<1100)setSidebar(false);setHydrated(true);},[]);
 useEffect(()=>{if(!hydrated)return;try{localStorage.setItem(STORAGE,JSON.stringify({version:1,items,favorites,history,recordRecent,theme,previewTheme,accent:resolvedAccent,accentPreference:accent,density,collections,checkMarks}));}catch{}},[hydrated,items,favorites,history,recordRecent,theme,previewTheme,accent,resolvedAccent,density,collections,checkMarks]);
 useEffect(()=>{const onKey=(e:KeyboardEvent)=>{const input=(e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]");if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k"){e.preventDefault();searchRef.current?.focus();setSearchOpen(true);}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="j"){e.preventDefault();setAssistantOpen(v=>!v);}if(e.key==="/"&&!input&&!modal){e.preventDefault();searchRef.current?.focus();setSearchOpen(true);}if(e.key==="Escape"&&!modal&&!assistantOpen){setFilterOpen(false);if(query)setQuery("");else {setMobileDetail(false);setFocused(false);}}};window.addEventListener("keydown",onKey);return()=>window.removeEventListener("keydown",onKey);},[query,modal,assistantOpen]);
 useEffect(()=>{articleRef.current?.scrollTo({top:0});},[selectedId]);
 useEffect(()=>{if(modal)setAssistantOpen(false);},[modal]);
 const availableItems=useMemo(()=>items.filter(item=>isSourceAccessible(item.id,ledger)&&(!item.originInsightId||isInsightAccessible(item.originInsightId,ledger))&&(Array.isArray(item.originSourceIds)?item.originSourceIds:[]).every(id=>isSourceAccessible(id,ledger))).map(item=>{const source=Object.values(ledger.sources).find(entry=>entry.id===item.id||entry.sourceItemId===item.id);const latest=source&&source.version>1?getSourceHubItem(source.id,source.version):null;const value=latest?{...item,excerpt:latest.excerpt,sections:latest.sections}:item;return {...value,sections:visibleAssistantSections(value.sections,id=>isSourceAccessible(id,ledger)&&isInsightAccessible(id,ledger))};}),[items,ledger]);
 const tagReview=useTagReview(availableItems,notify);
 const recentItems=useMemo(()=>history.flatMap(entry=>{
  const item=availableItems.find(candidate=>candidate.id===entry.id);
  return item?[{item,openedAt:entry.openedAt}]:[];
 }),[history,availableItems]);
 const selected=availableItems.find(x=>x.id===selectedId);
 const canUseAssistantContext=(context:AssistantContext|null|undefined)=>{if(!context)return true;const state=getLedger();const allowed=(id:string)=>isLibraryReference(id)?!!assistantLibraryNode(id):isSourceAccessible(id,state);return isInsightAccessible(context.id,state)&&allowed(context.id)&&(context.evidence||[]).every(evidence=>allowed(evidence.id));};
 const explorationBlocked=MIGRATED_HUB_ITEMS.some(item=>!isSourceAccessible(item.id,ledger));
 useEffect(()=>{if(assistantOpen&&!canUseAssistantContext(assistantContext)){setAssistantOpen(false);notify("相关来源已不可用，已收起这段讨论");}},[ledger,assistantContext,assistantOpen]);
 const visibleItems=useMemo(()=>{
  let result=availableItems.filter(x=>view==="reading"?x.kind==="reading":view==="tasks"?x.kind==="task":view==="journal"?x.kind==="journal":view==="favorites"?favorites.includes(x.id):true);
  if(sources.length)result=result.filter(x=>sources.includes(x.source));
  if(filter!=="all"){
   if(view==="reading")result=result.filter(x=>(x.readState||"inbox")===filter);
   else if(view==="tasks")result=result.filter(x=>filter.startsWith("project:")?x.project===filter.slice(8):x.taskState===filter);
   else if(view==="journal")result=result.filter(x=>filter==="today"?x.date==="2026-11-08":filter==="month"?x.date.startsWith("2026-11"):true);
   else if(view==="tags")result=result.filter(x=>x.tags.includes(filter));
   else if(filter.startsWith("collection:")){const term=filter.slice(11).toLowerCase();result=result.filter(x=>(x.title+" "+x.excerpt+" "+x.tags.join(" ")).toLowerCase().includes(term));}
  }
  if(view==="journal"&&journalDate)result=result.filter(x=>x.date===journalDate);
  if(query.trim()){const terms=query.trim().toLowerCase().split(/\s+/);result=result.filter(x=>terms.every(q=>(x.title+" "+x.excerpt+" "+x.tags.join(" ")+" "+x.space+" "+sourceMeta[x.source].name+" "+x.sections.map(s=>s.text||s.items?.join(" ")||"").join(" ")).toLowerCase().includes(q)));}
  return result;
 },[availableItems,view,filter,sources,query,favorites,journalDate]);
 useEffect(()=>{if(view!=="insights"&&view!=="flashcards"&&view!=="tags"&&visibleItems.length&&!visibleItems.some(x=>x.id===selectedId)){setSelectedId(visibleItems[0].id);}},[visibleItems,view,selectedId]);
 const current=visibleItems.find(x=>x.id===selectedId)||visibleItems[0];
 const currentPractice=useMemo(()=>current&&isPublicPractice(current)?projectPracticeDocument(current.id,current.sections):null,[current]);
 const currentSections=currentPractice?.sections||current?.sections||[];
 const documentText=(text:string|undefined)=>currentPractice?<PracticeText text={text||""}/>:text;
 const isFixedSample=current?.id===previewSample.id||REPORT_HUB_ITEMS.some(item=>item.id===current?.id);
 const fixedSampleSource=isFixedSample?SOURCE_FIXTURES.find(source=>source.id===current?.id||source.sourceItemId===current?.id):undefined;
 const fixedSampleDate=(fixedSampleSource?.eventAt||current?.date||"").slice(0,10).replaceAll("-",".");
 const publicSource=fixedSampleSource?.externalUrl?.startsWith("https://")?fixedSampleSource:undefined;
 const publicSourceDate=(publicSource?.checkedAt||"").slice(0,10).replaceAll("-",".");
 const changeView=(next:View)=>{setTagReviewTarget(null);setSearchOpen(false);if(["cloud","settings"].includes(new URLSearchParams(window.location.search).get("view")||"")){const url=new URL(window.location.href);url.searchParams.set("view",next);url.searchParams.delete("section");window.history.replaceState(null,"",url);}setView(next);setFilter("all");setQuery("");setSources([]);setJournalDate("");setFocused(false);setMobileDetail(false);setReturnToInsights(false);setLayout("list");setFilterOpen(false);setPreview(true);if(next==="insights"){setInsightMode("current");setInsightScope("all");setReview(false);setSidebar(window.innerWidth>=1100);}else if(window.innerWidth<1100)setSidebar(false);};
 const changeInsightSection=(section:"discoveries"|"review"|"topics"|"drafts"|"history"|"examples")=>{
  setInsightMode(["discoveries","history"].includes(section)?"current":"explore");
  setReview(section==="review");setInsightScope("all");
  setFilter(section==="topics"||section==="drafts"||section==="history"?section:"all");
  setQuery("");setMobileDetail(false);setReturnToInsights(false);setFilterOpen(false);
  if(window.innerWidth<1100)setSidebar(false);
 };
 const changeInsightScope=(scope:InsightScope)=>{
  setInsightMode("current");setReview(false);setInsightScope(scope);
  setFilter(scope==="review"||scope==="starred"||scope==="cases"?"everything":"all");
  setQuery("");setMobileDetail(false);setReturnToInsights(false);setFilterOpen(false);
  if(window.innerWidth<1100)setSidebar(false);
 };
 const rememberOpen=(id:string)=>{
  if(!recordRecent)return;
  const openedAt=Date.now();
  setHistory(entries=>[{id,openedAt},...entries.filter(entry=>entry.id!==id)].slice(0,30));
 };
 const pickItem=(item:HubItem)=>{setSelectedId(item.id);setPreview(true);setMobileDetail(true);rememberOpen(item.id);};
 const showRecent=searchOpen&&!query.trim()&&!modal&&!(assistantOpen&&assistantExpanded);
 const toggleFavorite=(id:string)=>setFavorites(f=>f.includes(id)?f.filter(x=>x!==id):[...f,id]);
 const updateItem=(id:string,updates:Partial<HubItem>)=>setItems(all=>all.map(x=>x.id===id?{...x,...updates,...(updates.taskState&&updates.taskState!==x.taskState?{completedOn:updates.taskState==="done"?localJournalDate():undefined}:{})}:x));
 const setTaskDone=(item:HubItem)=>{const done=item.taskState!=="done";updateItem(item.id,{taskState:done?"done":"todo"});notify(done?"已完成这项示例任务":"已恢复为待办");};
 const openCloudSection=(target:CloudPage)=>{if(view==="settings"&&settingsReturn.current!=="cloud")cloudReturn.current=settingsReturn.current;setCloudPage(target);setModal(null);changeView("cloud");const url=new URL(window.location.href);url.searchParams.set("view","cloud");url.searchParams.delete("section");window.history.replaceState(null,"",url);};
 const openCloud=()=>{cloudReturn.current=view==="cloud"?"all":view;openCloudSection("overview");};
 const openRelatedSettings=(target:RelatedSetting)=>{if(view!=="settings")settingsReturn.current=view;setRelatedSetting(target);setModal(null);changeView("settings");const url=new URL(window.location.href);url.searchParams.set("view","settings");url.searchParams.set("section",target);window.history.replaceState(null,"",url);};
 const openTagChat=(tag?:string,task?:TagTask)=>{setTagEntry({tag,task});setAssistantOpen(true);};
 const openTagQueue=(id:string)=>{changeView("tags");setTagReviewTarget({id,time:Date.now()});setAssistantOpen(false);};
 const openAssistant=(context?:string|AssistantContext)=>{const next=context?(typeof context==="string"?{id:"prototype-progress",title:"阶段回顾",excerpt:context,workId:"work-hub-prototype",workTitle:"Hub · 原型验证"}:context):view==="libraries"?null:view==="insights"?assistantContext:selected?{id:selected.id,title:selected.title,excerpt:selected.excerpt,kind:selected.kind,libraryId:selected.source,libraryName:sourceMeta[selected.source].name}:null;if(!canUseAssistantContext(next)){notify("相关来源已不可用，请先恢复来源访问");return;}setSourceDemo(false);setAssistantContext(next);setAssistantOpen(true);};
 const openSource=(id:string)=>{if(!isSourceAccessible(id)){notify("该来源当前不可用，正文与引文已隐藏");return;}const item=availableItems.find(x=>x.id===id);if(!item){notify("该示例资料暂未包含在原型中");return;}if(view==="insights")insightReturn.current={filter,review,mode:insightMode,scope:insightScope,query};setReturnToInsights(true);setView("all");setFilter("all");setSources([]);setQuery("");setFocused(false);pickItem(item);};
 const createLocalItem=(kind:ItemKind,title:string,body:string,origin?:DraftOrigin)=>{
  if(origin&&(!isInsightAccessible(origin.insightId)||!(origin.sourceIds||[]).every(id=>isSourceAccessible(id)))){notify("相关来源已不可用，无法保存这份草稿");return "";}
  const id="local-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6); const item:WorkspaceItem={id,title:title.trim(),kind,source:"hub",space:kind==="task"?"个人 / 收集箱":kind==="journal"?"生活日志":"我的笔记",group:kind==="journal"&&journalDate?(journalDate==="2026-11-08"?"今天":journalDate==="2026-11-07"?"昨天":journalDate>="2026-11-02"?"本周":"上周"):"今天",date:kind==="journal"&&journalDate?journalDate:"2026-11-08",dateLabel:"刚刚",tags:origin?["Hub","洞察草稿"]:kind==="journal"?["复盘"]:["Hub"],excerpt:body.trim().slice(0,160)||"记录已经保存，可以继续补充。",sections:body.trim().split(/\n\s*\n/).filter(Boolean).map(text=>({type:"p" as const,text})),...(kind==="task"?{taskState:"todo" as const,project:"个人",due:"2026-11-08"}:{}),...(origin?{originInsightId:origin.insightId,workId:origin.workId,originSourceIds:origin.sourceIds}:{})};
  if(isPublicPractice(item)){
   const practice=parsePracticeMarkdown(id,body);item.sections=practice.sections;
   setCheckMarks(all=>({...all,...practice.initialChecks}));
  }
  if(!item.sections.length)item.sections=[{type:"p",text:"从一个想法开始。点击「编辑」可以继续补充内容。"}];
  setItems(all=>[item,...all]);return id;
 };
 const createJournalTasks=(tasks:JournalCaptureTask[],day:string)=>{
  const date=localJournalDate();
  const created=tasks.map(({title,completed}):WorkspaceItem=>({
   id:"journal-task-"+crypto.randomUUID(),title,kind:"task",source:"ticktick",space:"收件箱",project:"收件箱",
   group:"今天",date,dateLabel:"刚刚",tags:[],excerpt:"",sections:[],due:day,taskState:completed?"done":"todo",
   ...(completed?{completedOn:day}:{})
  }));
  setItems(all=>[...created,...all]);
 };
 const addItem=(kind:ItemKind,title:string,body:string,origin?:DraftOrigin)=>{
  const id=createLocalItem(kind,title,body,origin);if(!id)return "";changeView(kind==="task"?"tasks":kind==="journal"?"journal":"all");setSelectedId(id);setMobileDetail(true);rememberOpen(id);notify(kind==="task"?"任务已保存在当前浏览器的演示清单":"记录已保存在当前浏览器");return id;
 };
 const sourceVersionChanged=(id:string,version:number,note:string)=>{setItems(current=>current.map(item=>{if(item.id!==id)return item;const marker="来源版本记录（演示）";const index=item.sections.findIndex(section=>section.type==="h2"&&section.text===marker);const original=index>=0?item.sections.slice(0,index):item.sections;return {...item,sections:[...original,{type:"h2" as const,text:marker},{type:"callout" as const,text:`示例 v${version} · ${note}`}]};}));};
 const openAssistantSource=(id:string)=>{
  if(isLibraryReference(id)){const node=assistantLibraryNode(id);if(node){setLibraryTarget(node.id);changeView("libraries");}else notify("此资料库来源当前不可用");return;}
if(!isSourceAccessible(id)){notify("该来源当前不可用，正文与引文已隐藏");return;}if(view==="insights"||returnToInsights){openSource(id);return;}const item=availableItems.find(candidate=>candidate.id===id);if(!item){notify("这份示例资料暂未包含在工作台中");return;}changeView("all");pickItem(item);};
 const saveAssistantDraft=async(kind:"note"|"task",title:string,body:string,context?:AssistantContext|null)=>{
  let createdItemId="";
  try {
   if(!canUseAssistantContext(context)){notify("相关来源已不可用，无法保存这份草稿");return;}
   const currentLedger=getLedger();const discovery=context?currentLedger.insights.find(item=>item.id===context.id):undefined;
   if(discovery&&currentLedger.storageError){notify(currentLedger.storageError);return;}
   const origin:DraftOrigin|undefined=context?{insightId:context.id,workId:context.workId,sourceIds:[context.id,...(context.evidence||[]).map(item=>item.id)]}:undefined;
   const operationId=ledgerId();
   createdItemId=addItem(kind,title,body,origin);if(!createdItemId||!origin)return;
   if(discovery){const result=await executeLedger({type:"receipt",insightId:discovery.id,targetRevision:context?.revision,originSourceIds:origin.sourceIds,kind,createdItemId,title,operationId});if(!result.ok)notify("记录已保存，洞察处理记录暂未同步："+result.message);}
   else if(context?.workId)recordAssistantDraft({...origin,title,body,kind,createdItemId});
  } catch {
   notify(createdItemId?"记录已保存在工作台，洞察处理记录暂未同步。请勿重复保存。":"这次保存未完成，请保留草稿后重试。");
  }
 };
 const insertAssistantAnswer = (value: PageInsertion) => {
  const target=availableItems.find(item=>item.id===value.targetId);
  if(!target || target.kind==='task' || REPORT_HUB_ITEMS.some(item=>item.id===target.id))throw new Error('目标页面不可写入，请重新选择');
  if(!value.sourceIds.every(id=>isSourceAccessible(id)&&isInsightAccessible(id)))throw new Error('回答来源已不可用，暂时不能插入');
  // Validate the preview against current content before appending, preserving all original sections.
  appendAssistantAnswer(target,value);
  setItems(all=>all.map(item=>item.id===value.targetId?appendAssistantAnswer(item,{...value,expectedBody:pageBody(item.sections)}):item));
  notify('回答已追加到「'+target.title+'」末尾，原文已保留');
 };
 const [editingId,setEditingId]=useState<string|null>(null);
 useEffect(()=>{if(modal==="new"&&editingId&&!availableItems.some(item=>item.id===editingId)){setModal(null);notify("这份内容的来源已不可用，已收起编辑窗口");}},[ledger,editingId,modal,availableItems]);
 const openNew=(kind?:ItemKind)=>{setNewKind(kind|| (view==="tasks"?"task":view==="journal"?"journal":"note"));setNewTitle("");setNewBody("");setEditingId(null);setModal("new");};
 const editCurrent=()=>{if(!current)return;if(isFixedSample){notify("这份固定样本通过洞察中的来源演示更新，用户补充另行保留。");return;}setNewKind(current.kind);setNewTitle(current.title);setNewBody(currentPractice?practiceMarkdown(currentPractice,checkMarks):current.sections.map(s=>s.text||s.items?.join("\n")||"").join("\n\n"));setEditingId(current.id);setModal("new");};

 const resizeList=(e:React.PointerEvent)=>{e.preventDefault();const parent=e.currentTarget.parentElement;const width=parent?.getBoundingClientRect().width||1000;const start=e.clientX,original=listWidth;const move=(ev:PointerEvent)=>setListWidth(Math.max(30,Math.min(65,original+(ev.clientX-start)/width*100)));const up=()=>{document.removeEventListener("pointermove",move);document.removeEventListener("pointerup",up);document.body.style.cursor="";};document.body.style.cursor="col-resize";document.addEventListener("pointermove",move);document.addEventListener("pointerup",up);};
 const sourceSelect=(source:SourceId,event:React.MouseEvent)=>{if(view==="cloud"||view==="settings"||view==="insights"||view==="flashcards"||view==="libraries"||view==="tasks"||view==="journal")changeView("all");setSources(prev=>event.metaKey||event.ctrlKey?(prev.includes(source)?prev.filter(s=>s!==source):[...prev,source]):prev.length===1&&prev[0]===source?[]:[source]);setFilterOpen(false);};
 const sidebarItem=(label:string,value:string,icon:ReactNode,count?:number)=> <button key={value} className={"sidebar-item "+(filter===value&&!(view==="insights"&&review)?"selected":"")} onClick={()=>{setFilter(value);setJournalDate("");setMobileDetail(false);if(view==="insights")setReview(false);}}>{icon}<span>{label}</span>{count!==undefined&&<span className="count">{count}</span>}</button>;
 const insightCounts=useMemo(()=>{
  const counts={all:ledger.insights.length,review:0,starred:0,knowledge:0,life:0,decision:0,cases:0};
  for(const insight of ledger.insights){
   if(getInsightValidity(ledger,insight)==="review")counts.review++;
   if(insight.starred)counts.starred++;
   const finding=getVisibleFinding(ledger,insight);if(finding){counts[finding.category]++;if(finding.caseStudy)counts.cases++;}
  }
  return counts;
 },[ledger]);
 const isCurrentDiscovery=insightMode==="current"&&filter!=="history"&&filter!=="reports";
 const insightSidebarItem=(label:string,selected:boolean,icon:ReactNode,onClick:()=>void,count?:number)=><button key={label} type="button" className={"sidebar-item "+(selected?"selected":"")} aria-current={selected?"page":undefined} onClick={onClick}>{icon}<span>{label}</span>{count!==undefined&&<span className="count">{count}</span>}</button>;
 const viewTitle=views.find(v=>v.id===view)?.title||"全部内容";
 const caption=view==="reading"?"把值得读的，留在这里":view==="tasks"?"项目与清单":view==="journal"?"记下经历，也记下变化":view==="favorites"?"值得再次打开":view==="tags"?"以主题连接你的资料":"所有资料，随时可达";
 const monthDate=new Date(2026,calendarMonth,1), monthDays=new Date(2026,calendarMonth+1,0).getDate(), monthOffset=(monthDate.getDay()+6)%7;
 const copyLink=async()=>{if(!current)return;try{const url=new URL(window.location.href);url.hash="item="+encodeURIComponent(current.id);await navigator.clipboard.writeText(url.toString());notify("当前示例资料链接已复制");}catch{notify("当前浏览器不允许访问剪贴板，请复制地址栏链接");}};
 useEffect(()=>{if(!hydrated)return;const hash=window.location.hash;const id=hash.startsWith("#item=")?decodeURIComponent(hash.slice(6)):"";if(id&&availableItems.some(x=>x.id===id)){setSelectedId(id);setMobileDetail(true);}},[hydrated]);
 const renderRow=(item:HubItem)=> <div key={item.id} className={"result-row "+(selectedId===item.id?"selected ":"")+(item.taskState==="done"?"completed":"")}><button className="row-main" onClick={()=>pickItem(item)} aria-label={"打开 "+item.title} aria-current={selectedId===item.id?"true":undefined}>{item.kind==="task"?<span className="task-row-indicator">{item.taskState==="done"?<CheckCircle2 size={17}/>:<Circle size={17}/>}</span>:<SourceIcon source={item.source}/>}<span className="row-copy"><span className="row-title">{item.title}</span><span className="row-source"><span className="row-dash">—</span> {item.space}</span></span><span className="row-date">{item.dateLabel}</span></button><button className={"row-star "+(favorites.includes(item.id)?"starred":"")} onClick={()=>toggleFavorite(item.id)} title={favorites.includes(item.id)?"取消收藏":"收藏"} aria-label={(favorites.includes(item.id)?"取消收藏 ":"收藏 ")+item.title}><Star size={13} fill={favorites.includes(item.id)?"currentColor":"none"}/></button></div>;
 const renderCard=(item:HubItem)=> <button key={item.id} className={"content-card "+(selectedId===item.id?"selected":"")} onClick={()=>pickItem(item)}><span className="card-top"><SourceIcon source={item.source}/><span>{sourceMeta[item.source].name}</span><span className="card-time">{item.dateLabel}</span></span><strong>{item.title}</strong><p>{item.excerpt}</p><span className="card-bottom"><span>{item.tags[0]}</span>{item.kind==="reading"?<span>{readLabels[item.readState||"inbox"]}</span>:<span>{item.project||"笔记"}</span>}</span></button>;

 const navigationResizer=sidebar?<SidebarResize panel={view} width={sidebarWidth} onChange={setSidebarWidth}/>:null;
 return <div className={"hub-app "+(sidebar?"sidebar-open ":"sidebar-closed ")+(focused?"focus-mode ":"")+(mobileDetail?"mobile-detail ":"")+(assistantOpen&&assistantExpanded?"assistant-workbench-open":"")} data-theme={theme} data-density={density} data-view={view} style={{"--accent":["black","sage"].includes(theme)?darkAccents[resolvedAccent]:accents[resolvedAccent],"--sidebar-width":sidebarWidth+"px","--list-width":listWidth+"%"} as CSSProperties}>
  <nav className="workspace-rail" aria-label="Hub 全局导航">
   <div className="rail-top"><IconButton label={sidebar?"收起二级导航":"展开二级导航"} onClick={()=>setSidebar(v=>!v)}><PanelLeft size={18}/></IconButton></div>
   <div className="rail-navigation"><IconButton label="Hub 助手" active={assistantOpen} onClick={()=>openAssistant()}><MessageSquare size={18}/></IconButton>{views.map(v=><IconButton key={v.id} label={v.title} active={view===v.id} onClick={()=>changeView(v.id)} className={v.id==="insights"?"insights-nav":""}><v.icon size={18}/>{v.id==="insights"&&<span className="nav-dot"/>}</IconButton>)}</div>
   <div className="rail-sources"><div className="rail-divider"/><IconButton label="全部资料库" active={!sources.length} onClick={()=>{setSources([]);if(view==="cloud"||view==="settings"||view==="insights"||view==="flashcards"||view==="libraries"||view==="tasks"||view==="journal")changeView("all");}}><Layers size={18}/></IconButton>{(["craft","obsidian","ticktick","notion","feishu"] as SourceId[]).map(s=><button key={s} className={"source-rail-button "+(sources.includes(s)?"selected":"")} title={sourceMeta[s].name+" · 点击筛选，Ctrl 多选"} aria-label={"筛选 "+sourceMeta[s].name} aria-pressed={sources.includes(s)} onClick={e=>sourceSelect(s,e)}><SourceIcon source={s}/></button>)}<IconButton label="云同步" active={view==="cloud"} onClick={openCloud}><Cloud size={18}/></IconButton><IconButton label="外观与设置" onClick={()=>setModal("settings")}><Settings2 size={18}/></IconButton></div>
  </nav>
  {sidebar&&!["libraries","tasks","journal","tags","flashcards","cloud","settings"].includes(view)&&<><aside id="hub-module-navigation" className="module-sidebar" aria-label={viewTitle+"导航"}><div className="sidebar-heading"><h1>{viewTitle}</h1><button className="workspace-switch" aria-label="原型说明" title="原型说明" onClick={()=>setModal("about")}><span className="mini-hub-mark">h</span><ChevronDown size={12}/></button></div>
   <div className="sidebar-scroll">
    {view==="all"&&<><div className="sidebar-section">资料索引</div><button className="sidebar-item" onClick={()=>changeView("libraries")}><Folder size={16}/><span>浏览资料库</span><ChevronRight size={12}/></button>{sidebarItem("全部内容","all",<Layers size={16}/>,availableItems.length)}{sidebarItem("Hub 开发","collection:Hub",<Folder size={16}/>)}{sidebarItem("汽车线束","collection:线束",<Folder size={16}/>)}<div className="sidebar-section with-action"><span>智能集合 <span className="section-number">{collections.length}</span></span><IconButton label="新建智能集合" onClick={()=>{setCollectionName("");setCollectionTerm("");setModal("collection");}}><Plus size={14}/></IconButton></div>{collections.map(c=>sidebarItem(c.name,"collection:"+c.term,<Bookmark size={15}/>))}<button className="subtle-side-action" onClick={()=>{setCollectionName("");setCollectionTerm("");setModal("collection");}}><Plus size={14}/> 创建智能集合</button><div className="sidebar-section source-section">资料来源</div>{(Object.keys(sourceMeta) as SourceId[]).filter(s=>s!=="hub").map(s=><button key={s} className={"sidebar-item source-side-item "+(sources.includes(s)?"selected":"")} onClick={e=>sourceSelect(s,e)}><SourceIcon source={s} small/><span>{sourceMeta[s].name}</span><span className="source-status" title="示例来源"/></button>)}</>}
    {view==="reading"&&<><div className="sidebar-section">阅读资料</div>{sidebarItem("全部内容","all",<Bookmark size={16}/>,availableItems.filter(x=>x.kind==="reading").length)}{sidebarItem("待读","inbox",<Circle size={15}/>,availableItems.filter(x=>x.kind==="reading"&&(x.readState||"inbox")==="inbox").length)}{sidebarItem("进行中","reading",<BookOpen size={16}/>)}{sidebarItem("已读","done",<CheckCheck size={16}/>)}<div className="sidebar-section">我的视图</div><button className="sidebar-item" onClick={()=>{setLayout("board");setFilter("all");setPreview(false);}}><Columns3 size={16}/><span>阅读看板</span></button><button className="sidebar-item" onClick={()=>{setLayout("gallery");setFilter("all");setPreview(false);}}><LayoutGrid size={16}/><span>资料画廊</span></button><div className="sidebar-section">整理</div>{sidebarItem("归档","archived",<Archive size={16}/>)}{sidebarItem("放弃","abandoned",<X size={16}/>)}<div className="sidebar-note"><BookOpen size={17}/><p>先收藏，再慢慢读。<br/>记录一个与你有关的想法。</p></div></>}
    {view==="tasks"&&<><div className="sidebar-section">项目与清单</div>{sidebarItem("全部项目与清单","all",<Layers size={16}/>,availableItems.filter(x=>x.kind==="task"&&x.taskState!=="done").length)}{["Hub","汽车线束","个人"].map(p=>sidebarItem(p,"project:"+p,<Folder size={16}/>,availableItems.filter(x=>x.kind==="task"&&x.project===p&&x.taskState!=="done").length))}<div className="sidebar-section">任务状态</div>{Object.entries(taskLabels).map(([key,label])=>sidebarItem(label,key,key==="done"?<CheckCheck size={16}/>:key==="waiting"?<Clock3 size={16}/>:<Circle size={15}/>))}<button className="side-new-button" onClick={()=>openNew("task")}><Plus size={15}/> 添加任务</button></>}
    {view==="journal"&&<><div className="sidebar-section">生活记录</div>{sidebarItem("全部日志","all",<BookOpen size={16}/>)}{sidebarItem("今天","today",<Sun size={16}/>)}{sidebarItem("本月记录","month",<CalendarDays size={16}/>)}<div className="mini-calendar"><header><strong>{monthDate.getFullYear()} 年 {monthDate.getMonth()+1} 月</strong><IconButton label="上个月" onClick={()=>setCalendarMonth(m=>m-1)}><ChevronLeft size={14}/></IconButton><IconButton label="下个月" onClick={()=>setCalendarMonth(m=>m+1)}><ChevronRight size={14}/></IconButton></header><div className="calendar-grid">{["一","二","三","四","五","六","日"].map(d=><span className="weekday" key={d}>{d}</span>)}{Array.from({length:monthOffset}).map((_,i)=><span key={"empty"+i}/>)}{Array.from({length:monthDays}).map((_,i)=>{const date=monthDate.getFullYear()+"-"+String(monthDate.getMonth()+1).padStart(2,"0")+"-"+String(i+1).padStart(2,"0");const has=availableItems.some(x=>x.kind==="journal"&&x.date===date);return <button key={date} className={(journalDate===date?"selected ":"")+(has?"has-record ":"")+(date==="2026-11-08"?"today":"")} aria-label={date+(has?" 有记录":"")} onClick={()=>{setJournalDate(date);setFilter("all");}}>{i+1}</button>;})}</div>{journalDate&&<button className="calendar-clear" onClick={()=>setJournalDate("")}>清除日期筛选</button>}</div><button className="side-new-button" onClick={()=>openNew("journal")}><Pencil size={15}/> 写一条日志</button></>}
    {view==="insights"&&<div className="insight-sidebar-nav">
     <div className="sidebar-section">我的洞察</div>
     {insightSidebarItem("发现",isCurrentDiscovery&&insightScope==="all",<Sparkles size={16}/>,()=>changeInsightSection("discoveries"),insightCounts.all)}
     {insightSidebarItem("真实案例",isCurrentDiscovery&&insightScope==="cases",<Globe2 size={16}/>,()=>changeInsightScope("cases"),insightCounts.cases)}
     {insightSidebarItem("阶段回顾",insightMode==="explore"&&review,<CalendarDays size={16}/>,()=>changeInsightSection("review"))}
     {insightSidebarItem("关注主题",insightMode==="explore"&&!review&&filter==="topics",<SlidersHorizontal size={16}/>,()=>changeInsightSection("topics"))}
     {insightSidebarItem("工作草稿",insightMode==="explore"&&!review&&filter==="drafts",<FileText size={16}/>,()=>changeInsightSection("drafts"))}
     {insightSidebarItem("处理记录",insightMode==="current"&&filter==="history",<Clock3 size={16}/>,()=>changeInsightSection("history"))}
     <div className="sidebar-section">我的筛选</div>
     {insightSidebarItem("待复核",isCurrentDiscovery&&insightScope==="review",<RotateCcw size={16}/>,()=>changeInsightScope("review"),insightCounts.review)}
     {insightSidebarItem("星标发现",isCurrentDiscovery&&insightScope==="starred",<Star size={16}/>,()=>changeInsightScope("starred"),insightCounts.starred)}
     <div className="sidebar-section">发现视角</div>
     {insightSidebarItem("知识与工作",isCurrentDiscovery&&insightScope==="knowledge",<BookOpen size={16}/>,()=>changeInsightScope("knowledge"),insightCounts.knowledge)}
     {insightSidebarItem("生活与进展",isCurrentDiscovery&&insightScope==="life",<Sun size={16}/>,()=>changeInsightScope("life"),insightCounts.life)}
     {insightSidebarItem("决定与变化",isCurrentDiscovery&&insightScope==="decision",<ArrowRight size={16}/>,()=>changeInsightScope("decision"),insightCounts.decision)}
     <div className="sidebar-section">探索示例</div>
     {insightSidebarItem("更多发现示例",insightMode==="explore"&&!review&&!["topics","drafts","history"].includes(filter),<Layers size={16}/>,()=>changeInsightSection("examples"))}
     <div className="insight-sidebar-tip"><BookOpenCheck size={15}/><p>每条发现都保留依据。<br/>先理解，再决定下一步。</p></div>
    </div>}
    {view==="favorites"&&<><div className="sidebar-section">你的收藏</div>{sidebarItem("全部收藏","all",<Star size={16}/>,favorites.length)}<div className="sidebar-note"><Star size={19}/><p>把重要的留下。<br/>点击条目旁的星标收藏。</p></div></>}
   </div><div className="sidebar-footer"><span className="avatar">V</span><div><strong>我的 Hub</strong><span>个人工作空间</span></div><IconButton label="查看原型说明" onClick={()=>setModal("about")}><CircleHelp size={16}/></IconButton></div>
  </aside>{navigationResizer}</>}
  <main className="main-workspace">
   {view!=="tags"&&<header className="global-toolbar">{view==="insights"&&<div className="insight-workspace-breadcrumb" aria-label="当前位置"><span>我的 Hub</span><ChevronRight size={12}/><strong>洞察</strong></div>}<div className="global-search"
     onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setSearchOpen(false);}}
     onKeyDown={e=>{
      if(!showRecent)return;
      if(e.key==="Escape"){e.preventDefault();e.stopPropagation();searchRef.current?.focus();setSearchOpen(false);}
      if(e.key==="ArrowDown"&&e.target===searchRef.current){const first=e.currentTarget.querySelector<HTMLButtonElement>(".recent-open button");if(first){e.preventDefault();first.focus();}}
     }}>
     <Search size={17}/><input ref={searchRef} value={query} onFocus={()=>setSearchOpen(true)} onClick={()=>setSearchOpen(true)} onChange={e=>{if(view==="flashcards")changeView("all");setQuery(e.target.value);setSearchOpen(true);setMobileDetail(false);}} placeholder={view==="insights"?"搜索发现、事项与依据…":view==="reading"?"搜索阅读资料…":view==="tasks"?"搜索项目与任务…":view==="journal"?"搜索日志…":"搜索全部资料库…"} aria-label={view==="insights"?"搜索发现、事项与依据":"搜索全部资料库"} aria-controls={showRecent?"recent-open":undefined}/>
     {query?<IconButton label="清除搜索" onClick={()=>{setQuery("");searchRef.current?.focus();setSearchOpen(true);}}><X size={14}/></IconButton>:<kbd>⌘ K</kbd>}
     {showRecent&&<RecentOpen entries={recentItems} recording={recordRecent}
      onOpen={item=>{changeView("all");pickItem(item);}}
      onRemove={id=>{searchRef.current?.focus();setHistory(entries=>entries.filter(entry=>entry.id!==id));}}
      onClear={()=>{searchRef.current?.focus();setHistory([]);}}
      onToggleRecording={()=>setRecordRecent(value=>!value)}/>}
    </div><div className="toolbar-right"><span className="prototype-label"><span/>交互原型</span>{view!=="insights"&&view!=="flashcards"&&<><div className="toolbar-divider"/><IconButton label="筛选资料来源" onClick={()=>setFilterOpen(v=>!v)} active={filterOpen||!!sources.length}><SlidersHorizontal size={17}/></IconButton><IconButton label={density==="compact"?"切换宽松列表":"切换紧凑列表"} onClick={()=>setDensity(d=>d==="compact"?"comfortable":"compact")}><LayoutList size={17}/></IconButton><IconButton label={preview?"隐藏阅读面板":"显示阅读面板"} active={preview} onClick={()=>{setPreview(v=>!v);setFocused(false);}}><PanelRight size={17}/></IconButton></>}</div>
   {filterOpen&&<div className="source-popover"><h3>资料来源</h3><p>选择本次浏览的范围</p>{(Object.keys(sourceMeta) as SourceId[]).map(s=><label key={s}><SourceIcon source={s} small/><span>{sourceMeta[s].name}</span><input type="checkbox" checked={sources.includes(s)} onChange={()=>setSources(prev=>prev.includes(s)?prev.filter(x=>x!==s):[...prev,s])}/></label>)}<footer><button onClick={()=>setSources([])}>全部资料库</button><button className="primary-button small-button" onClick={()=>setFilterOpen(false)}>完成</button></footer></div>}
   </header>}
   {view==="tags"?<TagWorkspace searchRef={searchRef} review={tagReview} reviewTarget={tagReviewTarget} onOpenAssistant={openTagChat} initialTag={filter} navigationOpen={sidebar} navigationResizer={navigationResizer} onToggleNavigation={()=>setSidebar(v=>!v)} renderIcon={source=><SourceIcon source={source}/>} sources={sources} onSources={setSources} query={query} onQuery={setQuery} notify={notify}/>:view==="cloud"||view==="settings"?<CloudSyncCenter initialPage={view==="settings"?relatedSetting:cloudPage} standalone={view==="settings"} onOpenSettings={openRelatedSettings} onOpenCloud={openCloudSection} onExit={()=>changeView(view==="settings"?settingsReturn.current:cloudReturn.current)}/>:view==="libraries"?<LibraryBrowser navigationResizer={navigationResizer} initialNodeId={libraryTarget} navigationOpen={sidebar} onToggleNavigation={()=>setSidebar(value=>!value)} onExit={()=>changeView("all")} notify={notify}/>:view==="tasks"?<TaskWorkspace onOpenAnalysis={item=>openAssistant({id:item.originInsightId||item.id,title:item.title,excerpt:item.excerpt,workId:item.workId})} navigationResizer={navigationResizer} initialTaskId={taskTarget} items={availableItems} onUpdate={updateItem} onNew={()=>openNew("task")} onLocate={id=>{setLibraryTarget(id);setView("libraries");}} navigationOpen={sidebar} onToggleNavigation={()=>setSidebar(v=>!v)}/>:view==="journal"?<JournalSite onOpenSettings={()=>openRelatedSettings("journal")} onOpenCloud={openCloud} navigationResizer={navigationResizer} items={availableItems} onCreateTasks={createJournalTasks} onUpdateTask={updateItem} onTaskOpen={id=>{setTaskTarget(id);setView("tasks");}} navigationOpen={sidebar} onToggleNavigation={()=>setSidebar(v=>!v)}/>:view==="insights"?<div className={"insights-host "+(insightMode==="explore"?"legacy-insights-host":"")}>{insightMode==="current"?<InsightPanel onOpenSource={openSource} onAssistant={openAssistant} onCreateDraft={createLocalItem} onSourceVersionChange={sourceVersionChanged} onOverlayOpen={()=>setAssistantOpen(false)} onFilterChange={setFilter} items={availableItems} notify={notify} query={query} onQueryChange={setQuery} filter={filter} review={review} onReviewChange={setReview} scope={insightScope} onScopeChange={scope=>{if(["all","review","starred","knowledge","life","decision","cases"].includes(scope))setInsightScope(scope as InsightScope);}} navigationOpen={sidebar} onOpenNavigation={()=>setSidebar(true)} onExplore={()=>changeInsightSection("examples")}/>:<><div className="insight-exploration-banner"><span>{review?"阶段回顾":filter==="topics"?"关注主题":filter==="drafts"?"工作草稿":"更多发现"}<i/>探索示例</span><button onClick={()=>changeInsightSection("discoveries")}><ArrowLeft size={13}/>返回发现</button></div>{explorationBlocked?<div className="empty-state"><FileText size={28}/><h3>部分示例来源当前不可用</h3><p>相关历史演示暂时隐藏。恢复来源后，可以继续浏览。</p><button className="secondary-button" onClick={()=>changeInsightSection("discoveries")}>返回发现核对来源</button></div>:<Insights onOpenSource={openSource} onAssistant={openAssistant} onCreateDraft={createLocalItem} onSourceVersionChange={sourceVersionChanged} onOverlayOpen={()=>setAssistantOpen(false)} onFilterChange={setFilter} items={availableItems} notify={notify} query={query} filter={filter} review={review} onReviewChange={setReview}/>}</>}</div>:view==="flashcards"?<FlashcardsSite onCloud={openCloud} navigationResizer={navigationResizer} navigationWidth={sidebarWidth} navigationOpen={sidebar} onToggleNavigation={()=>setSidebar(v=>!v)} onExit={()=>changeView("all")}/>:<div className={"content-workspace "+(!preview?"no-preview ":"")+(focused?"reader-focused":"")}>
    <section className="results-pane" aria-label={viewTitle+"列表"}>
     <div className="list-toolbar"><div><span className="list-caption">{query?"搜索结果":journalDate||caption}</span><span className="list-count">{visibleItems.length}</span></div><div className="list-toolbar-actions">{view==="reading"&&<><IconButton label="列表视图" active={layout==="list"} onClick={()=>setLayout("list")}><LayoutList size={15}/></IconButton><IconButton label="表格视图" active={layout==="table"} onClick={()=>setLayout("table")}><Table2 size={15}/></IconButton><IconButton label="看板视图" active={layout==="board"} onClick={()=>{setLayout("board");setPreview(false);}}><Columns3 size={15}/></IconButton>{view==="reading"&&<IconButton label="画廊视图" active={layout==="gallery"} onClick={()=>{setLayout("gallery");setPreview(false);}}><LayoutGrid size={15}/></IconButton>}</>}<IconButton label="新建记录" onClick={()=>openNew()}><Plus size={17}/></IconButton></div></div>
     {!!sources.length&&<div className="active-filters">{sources.map(s=><button key={s} onClick={()=>setSources(all=>all.filter(x=>x!==s))}><SourceIcon source={s} small/>{sourceMeta[s].name}<X size={11}/></button>)}</div>}
     <div className="results-scroll">{!visibleItems.length?<div className="empty-state"><Search size={28}/><h3>这里暂时没有内容</h3><p>{query?"换个关键词，或调整资料范围。":view==="favorites"?"给重要的内容点上星标，它会留在这里。":"试着切换筛选，或新建一条记录。"}</p><button className="secondary-button" onClick={()=>{{setQuery("");setSources([]);setFilter("all");setJournalDate("");}}}>清除筛选</button></div>:layout==="board"&&view==="reading"?<div className="board-view">{["inbox","reading","done",...(["archived","abandoned"].filter(state=>visibleItems.some(item=>item.readState===state)))].map(state=>{const list=visibleItems.filter(x=>(x.readState||"inbox")===state);return <div className="board-column" key={state}><h3><span className={"state-dot state-"+state}/>{readLabels[state]}<span>{list.length}</span></h3>{list.map(renderCard)}{!list.length&&<div className="board-empty">暂无内容</div>}</div>;})}</div>:layout==="gallery"?<div className="gallery-view">{visibleItems.map(renderCard)}</div>:layout==="table"?<div className="table-view"><div className="table-head"><span>名称</span><span>状态</span><span>来源</span></div>{visibleItems.map(item=><button key={item.id} className={"table-row "+(selectedId===item.id?"selected":"")} onClick={()=>pickItem(item)}><span><SourceIcon source={item.source} small/>{item.title}</span><span className="table-state">{readLabels[item.readState||"inbox"]}</span><span>{sourceMeta[item.source].name}</span></button>)}</div>:<>{groupOrder.map(group=>{const list=visibleItems.filter(x=>x.group===group);return list.length?<section className="result-group" key={group}><h2>{group}<span>{list.length}</span></h2>{list.map(renderRow)}</section>:null;})}</>}
     </div><footer className="list-footer"><span>{visibleItems.length} 条内容</span><span>{sources.length?"已选择 "+sources.length+" 个来源":"全部资料库"}</span></footer>
    </section>
    {preview&&<><div className="content-resizer" onPointerDown={resizeList} role="separator" aria-label="调整内容列表宽度" aria-orientation="vertical" aria-valuenow={listWidth} aria-valuemin={30} aria-valuemax={65} tabIndex={0} onDoubleClick={()=>setListWidth(43)} onKeyDown={e=>{if(e.key==="ArrowRight")setListWidth(w=>Math.min(65,w+2));if(e.key==="ArrowLeft")setListWidth(w=>Math.max(30,w-2));}}/><section className="reader-pane" aria-label="资料阅读面板">
     {current?<div className="reader-sheet" data-preview-theme={previewTheme}><div className="reader-toolbar"><div className="reader-breadcrumb"><button className="mobile-back" aria-label="返回内容列表" onClick={()=>setMobileDetail(false)}><ArrowLeft size={17}/></button>{returnToInsights&&<button className="back-insights" onClick={()=>{setView("insights");setFilter(insightReturn.current.filter);setReview(insightReturn.current.review);setInsightMode(insightReturn.current.mode);setInsightScope(insightReturn.current.scope);setQuery(insightReturn.current.query);setReturnToInsights(false);setMobileDetail(false);}}><ArrowLeft size={13}/>洞察</button>}<SourceIcon source={current.source} small/><span>{sourceMeta[current.source].name}</span><ChevronRight size={11}/><span>{current.space}</span></div><div className="reader-actions"><IconButton label="上一条内容" disabled={visibleItems.indexOf(current)===0} onClick={()=>pickItem(visibleItems[visibleItems.indexOf(current)-1])}><ArrowLeft size={14}/></IconButton><IconButton label="下一条内容" disabled={visibleItems.indexOf(current)===visibleItems.length-1} onClick={()=>pickItem(visibleItems[visibleItems.indexOf(current)+1])}><ArrowRight size={14}/></IconButton><span className="toolbar-divider"/><IconButton label={favorites.includes(current.id)?"取消收藏当前资料":"收藏当前资料"} active={favorites.includes(current.id)} onClick={()=>toggleFavorite(current.id)}><Star size={15} fill={favorites.includes(current.id)?"currentColor":"none"}/></IconButton><IconButton label="复制当前资料链接" onClick={copyLink}><Link2 size={15}/></IconButton><IconButton label={focused?"退出专注阅读":"专注阅读"} active={focused} onClick={()=>setFocused(v=>!v)}>{focused?<PanelLeft size={15}/>:<ArrowUpRight size={15}/>}</IconButton></div></div>
      <PreviewThemeControls value={previewTheme} onChange={changePreviewTheme} dark={["black","sage"].includes(theme)} onToggleDark={()=>setTheme(["black","sage"].includes(theme)?"white":"black")} onSample={()=>{changeView("all");pickItem(previewSample);}}/>
      <div className="reader-scroll" ref={articleRef}><article className={"document"+(publicSource?" document-public":"")}><div className="document-kind">{current.kind==="task"?"任务":current.kind==="journal"?"生活日志":current.kind==="reading"?"阅读资料":"笔记"}<span>·</span><time>{current.date.replaceAll("-",".")}</time><span className="document-demo">{publicSource?"官方资料 · 中文摘要":"示例内容"}</span></div><h2 className="document-title">{current.title}</h2><div className="document-meta">{publicSource?<Globe2 size={15}/>:<span className="avatar tiny">V</span>}<span>{publicSource?publicSource.publisher||publicSource.provider:"我的工作空间"}</span><span className="meta-dot">·</span><span>{publicSource?"核对日期 · "+publicSourceDate:isFixedSample?(fixedSampleSource?.eventAt?"事件日期 · ":"记录日期 · ")+fixedSampleDate:current.dateLabel+"更新"}</span>{isFixedSample?<span title={current.id===previewSample.id?"用于两种预览主题的固定排版样本":publicSource?"保留本次核对的公开资料摘要":"固定样本通过洞察中的来源演示更新"}>{publicSource?"资料摘要":"固定样本"}</span>:<button onClick={editCurrent}><Pencil size={12}/>编辑</button>}</div>
       {publicSource&&<div className="document-public-source"><span className="document-public-source-icon"><Globe2 size={18}/></span><div><strong>可核对的公开来源</strong><p>本页为官方资料的中文摘要，场景与行动建议另行说明。</p></div><a href={publicSource.externalUrl} target="_blank" rel="noreferrer">查看官方原文<ArrowUpRight size={14}/></a></div>}
       {current.kind==="task"&&<div className="task-properties"><div><span>状态</span><select aria-label="任务状态" value={current.taskState||"todo"} onChange={e=>updateItem(current.id,{taskState:e.target.value as HubItem["taskState"]})}>{Object.entries(taskLabels).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select></div><div><span>项目</span><span><Folder size={14}/>{current.project||"个人"}</span></div><div><span>计划日期</span><input type="date" aria-label="任务计划日期" value={current.due||""} onChange={e=>updateItem(current.id,{due:e.target.value})}/></div><button className={"complete-task "+(current.taskState==="done"?"is-done":"")} onClick={()=>setTaskDone(current)}><CheckCircle2 size={16}/>{current.taskState==="done"?"已完成 · 点击恢复":"标记完成"}</button></div>}
       {current.kind==="reading"&&<div className="reading-state-bar"><BookOpen size={16}/><span>阅读状态</span><select aria-label="阅读状态" value={current.readState||"inbox"} onChange={e=>{updateItem(current.id,{readState:e.target.value as HubItem["readState"]});notify("阅读状态已更新");}}>{Object.entries(readLabels).map(([k,l])=><option key={k} value={k}>{l}</option>)}</select><button onClick={()=>{updateItem(current.id,{readState:"done"});notify("已标记为读完");}}><Check size={14}/>读完了</button></div>}
       <div className="document-body">{currentSections.map((section,i)=>section.type==="h2"?<h3 key={i}>{documentText(section.text)}</h3>:section.type==="quote"?<blockquote key={i}>{documentText(section.text)}</blockquote>:section.type==="callout"?<div key={i} className="document-callout"><span className="callout-icon"><Sparkles size={15}/></span><div>{documentText(section.text)}</div></div>:section.type==="list"?<ul key={i}>{section.items?.map((text,j)=><li key={j}>{documentText(text)}</li>)}</ul>:section.type==="checklist"?<div className="document-checklist" key={i}>{section.items?.map((text,j)=>{
        const checkKey=currentPractice?.checkKeys[i]?.[j]||current.id+"-"+i+"-"+j;
        return <label key={checkKey}><input type="checkbox" checked={currentPractice?practiceChecked(currentPractice,checkMarks,i,j):!!checkMarks[checkKey]} onChange={e=>setCheckMarks(all=>({...all,[checkKey]:e.target.checked}))}/><span>{documentText(text)}</span></label>;
       })}</div>:<p key={i}>{documentText(section.text)}</p>)}{current.id===previewSample.id&&<PreviewSampleBlocks onOpenRelated={()=>{const related=availableItems.find(item=>item.id==="ui-design");if(related)pickItem(related);}}/>}</div>
       <div className="document-tags">{current.tags.map(t=><button key={t} onClick={()=>{changeView("tags");setFilter(t);}}><Hash size={12}/>{t}</button>)}</div>
       <div className="document-related"><div className="related-heading"><span><Link2 size={14}/>相关内容</span><span>沿着一个想法，继续</span></div>{availableItems.filter(x=>x.id!==current.id&&x.tags.some(t=>current.tags.includes(t))).slice(0,3).map(item=><button key={item.id} onClick={()=>{setView("all");setFilter("all");setQuery("");setSources([]);pickItem(item);}}><SourceIcon source={item.source} small/><span>{item.title}</span><ArrowUpRight size={13}/></button>)}</div>
       <div className="document-bottom"><span>{publicSource?"公开资料摘要 · 应用情境用于帮助理解":"此处为可交互的示例资料"}</span><button onClick={()=>openAssistant()}><Sparkles size={14}/>与助手讨论这篇内容<ArrowRight size={13}/></button></div>
      </article></div>
     </div>:<div className="reader-empty"><FileText size={32}/><p>选择一条内容，开始阅读</p><span>你的资料，会在这里展开。</span></div>}
    </section></>}
   </div>}
   <footer className="status-bar"><span><span className="status-dot"/> Hub <span className="status-separator">·</span> 就绪</span><span className="status-middle">{view==="insights"?"依据，让发现更有价值":"让分散的知识，连接起来"}</span><button onClick={()=>setModal("about")}>示例数据 <span>·</span> 更改保存在本浏览器<CircleHelp size={11}/></button></footer>
  </main>
  {!assistantOpen&&<button className="assistant-launcher" onClick={()=>openAssistant()}><span className="assistant-orb"/><span>助手</span></button>}
  <Assistant tagEntry={tagEntry} onTagEntryHandled={()=>setTagEntry(null)} tagModel={tagReview} sourceDemo={sourceDemo} uiDemo={uiDemo} activityDemo={activityDemo} onCloseActivityDemo={()=>setActivityDemo(false)} onOpenTagQueue={openTagQueue} currentPageId={["all","reading","journal","favorites"].includes(view)?current?.id:undefined} onInsertPage={insertAssistantAnswer} catalog={[...availableItems.map(item => ({ writable:item.kind!=="task"&&!REPORT_HUB_ITEMS.some(sample=>sample.id===item.id)&&!item.id.startsWith("tag-demo-"), id: item.id, title: item.title, excerpt: item.sections.map(section => section.text || section.items?.join("\n") || "").join("\n\n"), kind: item.kind, libraryId: item.source, libraryName: sourceMeta[item.source].name, path: item.space })),...assistantLibraryCatalog]} open={assistantOpen} expanded={assistantExpanded} context={assistantContext} canUseContext={canUseAssistantContext} onClose={()=>setAssistantOpen(false)} onExpand={()=>setAssistantExpanded(v=>!v)} onOpenSource={openAssistantSource} onCreateDraft={saveAssistantDraft} notify={notify}/>
  {toast&&<div className="toast" role="status"><CheckCircle2 size={16}/>{toast}<button onClick={()=>setToast("")} aria-label="关闭提示"><X size={13}/></button></div>}
  {modal==="settings"&&<Modal title="外观与设置" onClose={()=>setModal(null)} wide><div className="settings-tabs"><button className={settingsTab==="data"?"selected":""} onClick={()=>setSettingsTab("data")}><Folder size={15}/>内容与数据</button><button onClick={openCloud}><Cloud size={15}/>云同步</button><button className={settingsTab==="appearance"?"selected":""} onClick={()=>setSettingsTab("appearance")}><Palette size={15}/>外观</button><button className={settingsTab==="layout"?"selected":""} onClick={()=>setSettingsTab("layout")}><PanelLeft size={15}/>布局</button><button className={settingsTab==="about"?"selected":""} onClick={()=>setSettingsTab("about")}><CircleHelp size={15}/>关于原型</button></div><div className="settings-content">{settingsTab==="data"?<><h3>内容与数据</h3><p>按用途管理，云同步负责设备间的内容更新。</p><div className="settings-destinations">{([['cache','数据与存储','本机缓存、空间上限与离线保留'],['journal','速记保存位置','目标资料库、日记目录与写入状态'],['sources','来源与采集','来源连接、更新频率与原内容保留'],['backup','备份与恢复','独立文件备份与原件恢复']] as const).map(([id,label,hint])=><button key={id} onClick={()=>openRelatedSettings(id)}><Folder size={17}/><span><strong>{label}</strong><small>{hint}</small></span><ChevronRight size={16}/></button>)}</div><CraftReadingExport/></>:settingsTab==="appearance"?<><h3>让工作空间，像你喜欢的样子</h3><p>强调色默认跟随背景主题，也可以单独选择。</p><label className="setting-label">背景主题</label><div className="theme-grid">{themes.map(t=><button key={t.id} className={"theme-option "+(theme===t.id?"selected":"")} onClick={()=>setTheme(t.id)} aria-pressed={theme===t.id}><span className="theme-preview" style={{background:t.color}}><span style={{background:["black","sage"].includes(t.id)?"#ffffff24":"#0000000d"}}/><span style={{background:["black","sage"].includes(t.id)?"#ffffff32":"#00000013"}}/>{theme===t.id&&<Check size={15} style={{color:["black","sage"].includes(t.id)?"white":"#333"}}/>}</span><span>{t.name}</span></button>)}</div><label className="setting-label">强调色</label><div className="accent-options"><button className="accent-follow-theme" aria-pressed={accent==="theme"} onClick={()=>setAccent("theme")}>跟随主题</button>{Object.entries(accents).map(([key,color],i)=><button key={key} style={{background:color}} title={["松绿","湖蓝","暮紫","琥珀","玫瑰","石墨"][i]} aria-label={"强调色 "+["松绿","湖蓝","暮紫","琥珀","玫瑰","石墨"][i]} aria-pressed={accent===key} onClick={()=>setAccent(key)}>{accent===key&&<Check size={17}/>}</button>)}</div><div className="appearance-sample"><SourceIcon source="craft"/><div><strong>一处安静的工作空间</strong><span>让内容回到视线中央。</span></div><span className="sample-tag">预览</span></div></>:settingsTab==="layout"?<><h3>适合你的阅读节奏</h3><p>列表和阅读面板的分隔线都可以拖动调整。</p><div className="setting-row"><div><strong>列表密度</strong><p>紧凑适合浏览，宽松适合慢慢阅读。</p></div><select value={density} onChange={e=>setDensity(e.target.value)} aria-label="列表密度"><option value="compact">紧凑</option><option value="comfortable">宽松</option></select></div><div className="setting-row"><div><strong>二级导航</strong><p>按当前模块展示集合、清单与视图。</p></div><button role="switch" aria-checked={sidebar} aria-label="显示二级导航" className={"toggle "+(sidebar?"on":"")} onClick={()=>setSidebar(v=>!v)}><span/></button></div><div className="setting-row"><div><strong>右侧阅读面板</strong><p>保留上下文，在同一处打开资料。</p></div><button role="switch" aria-checked={preview} aria-label="显示右侧阅读面板" className={"toggle "+(preview?"on":"")} onClick={()=>setPreview(v=>!v)}><span/></button></div><button className="secondary-button" onClick={()=>{resetSidebarWidths();setListWidth(43);setSidebar(true);setPreview(true);setFocused(false);notify("布局已恢复默认");}}><RotateCcw size={14}/>恢复默认布局</button></>:<><h3>Hub 浏览器交互原型</h3><p>依据当前桌面 UI、GitHub 中的模块结构，以及洞察规划制作。</p><div className="about-note">这里的资料与流程用于交互演示，公开案例附有官方出处。助手使用演示回复，交互修改保存在当前浏览器。</div><a className="repo-link" href="https://github.com/VondeSong/hub-search" target="_blank" rel="noreferrer"><FileText size={16}/>查看 Hub 源代码<ExternalLink size={14}/></a><div className="keyboard-grid"><span>搜索</span><kbd>⌘ / Ctrl K</kbd><span>快速搜索</span><kbd>/</kbd><span>关闭弹窗 / 返回</span><kbd>Esc</kbd></div><button className="secondary-button" onClick={()=>{setItems(workspaceItems);setFavorites(["ui-design","dxf-guide","read-craft"]);setHistory([{id:"codex-hub"}]);setCollections([{name:"使用 AI",term:"AI"}]);changeView("all");setSelectedId("codex-hub");notify("内容、收藏与记录已恢复示例；外观设置保留");}}>恢复示例内容</button></>}</div><footer className="modal-footer"><span>设置会自动保留</span><button className="primary-button" onClick={()=>setModal(null)}>完成</button></footer></Modal>}
  {modal==="new"&&(!editingId||availableItems.some(item=>item.id===editingId))&&<Modal title={editingId?"编辑内容":newKind==="task"?"新建任务":newKind==="journal"?"写一条日志":"新建笔记"} onClose={()=>setModal(null)}><form onSubmit={e=>{e.preventDefault();if(!newTitle.trim())return;if(editingId){const editingItem=availableItems.find(item=>item.id===editingId);if(!editingItem){notify("相关来源已不可用，无法保存这份笔记");return;}const practice=isPublicPractice(editingItem)?parsePracticeMarkdown(editingId,newBody):null;updateItem(editingId,{title:newTitle.trim(),excerpt:newBody.slice(0,160),sections:practice?practice.sections:newBody.split(/\n\s*\n/).filter(Boolean).map(text=>({type:"p",text}))});if(practice)setCheckMarks(all=>({...all,...practice.initialChecks}));notify("修改已保存在当前浏览器");}else addItem(newKind,newTitle,newBody);setModal(null);}}><div className="form-content"><label>标题<input autoFocus value={newTitle} onChange={e=>setNewTitle(e.target.value)} placeholder={newKind==="journal"?"今天，有什么值得记下？":"给这个想法起个名字"} required maxLength={160}/></label><label>{newKind==="task"?"补充说明":"内容"}<textarea value={newBody} onChange={e=>setNewBody(e.target.value)} placeholder="从一两句话开始…" rows={8}/></label><p className="form-hint">保存到当前浏览器的演示工作空间。</p></div><footer className="modal-footer"><button type="button" className="secondary-button" onClick={()=>setModal(null)}>取消</button><button className="primary-button" type="submit">保存{newKind==="task"?"任务":newKind==="journal"?"日志":"笔记"}</button></footer></form></Modal>}
  {modal==="collection"&&<Modal title="新建智能集合" onClose={()=>setModal(null)}><form onSubmit={e=>{e.preventDefault();if(!collectionName.trim()||!collectionTerm.trim())return;setCollections(c=>[...c,{name:collectionName.trim(),term:collectionTerm.trim()}]);setFilter("collection:"+collectionTerm.trim());setModal(null);notify("智能集合已创建，将自动筛选匹配内容");}}><div className="form-content"><label>集合名称<input value={collectionName} onChange={e=>setCollectionName(e.target.value)} placeholder="例如：AI 工作流" required/></label><label>包含关键词<input value={collectionTerm} onChange={e=>setCollectionTerm(e.target.value)} placeholder="例如：Hub" required/></label><p className="form-hint">按标题、摘要和标签匹配，保留资料原来的位置。</p></div><footer className="modal-footer"><button type="button" className="secondary-button" onClick={()=>setModal(null)}>取消</button><button type="submit" className="primary-button">创建集合</button></footer></form></Modal>}
  {modal==="about"&&<Modal title="Hub · 工作与生活工作台" onClose={()=>setModal(null)}><div className="about-content"><div className="about-logo">h<span/></div><h3>熟悉的 Hub，现在可以在浏览器里体验。</h3><p>从资料出发，在内容、阅读、任务和日志之间自然流转；通过洞察看见联系，带着上下文与助手继续工作。</p><div className="about-note"><strong>交互演示 · 示例数据</strong><p>任务状态、收藏、新建记录与主题会保存在当前浏览器。助手使用演示回复，尚未连接本地 Hub 或外部账号。</p></div><a className="repo-link" href="https://github.com/VondeSong/hub-search" target="_blank" rel="noreferrer">Hub 源代码<ArrowUpRight size={14}/></a></div><footer className="modal-footer"><span>2026.11 · 浏览器原型</span><button className="primary-button" onClick={()=>setModal(null)}>开始体验</button></footer></Modal>}
 </div>;
}
