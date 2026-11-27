import { useMobileReadingPosition } from "./MobileReadingPosition";
import { MobileReadingControls } from "./MobileReadingControls";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { userProfileStorage } from "./UserProfileStorage";
import { CollectionSyncPanel, type CollectionSyncSource, type CollectionSyncJob } from "./CollectionSyncPanel";
import { CollectionDestination, CollectionLibraryBadge, CollectionConversionPreview, type CollectionLibraryOperation } from "./CollectionDestination";
import type { LibrarySummary } from "./SearchTypes";
import { collectionEntryLabels, useCollectionViews, type CollectionBuiltinEntry, type CollectionView as View } from "./CollectionViews";
import type { CollectionItem, CollectionPage } from "./CollectionPage";
import { CollectionColumnResize } from "./CollectionColumnResize";
import { CollectionProperties } from "./CollectionProperties";
import { publishCodexNotice } from "./CodexSuite";
import { TelegramTdlSettings, type TelegramTdlState } from "./TelegramTdlSettings";
import { TelegramTdlLogin } from "./TelegramTdlLogin";
import { runtimeCapabilities } from "./RuntimePlatform";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { CircleSlash, Cloud } from "lucide-react";
import { CompletedStatusIcon } from "./CompletedStatusIcon";
import { CollectionViewTabs } from "./CollectionViewTabs";
import { defaultCollectionCards, cardFields, type CardField } from "./CollectionCardConfig";
import { CollectionGalleryCover } from "./CollectionGalleryCover";
import { CollectionSort, normalizeCollectionSorts, type CollectionSortRule } from "./CollectionSort";
import { ReadingActiveFilters, ReadingFilterTools, ReadingSortTools } from "./ReadingQueryTools";
import { ReadingCloudOverview, ReadingSourceConnections, type ReadingDidaSession } from "./ReadingSyncTools";
import { CollectionPostBody, collectionAttachments } from "./CollectionPostBody";
import { ReadingArticleTools, type ReadingArticleToolsHandle } from "./ReadingArticleTools";
import { ReadingInvestigation } from "./AgentInvestigation";
import "./PreviewContent.css";
import { PreviewFrame, PreviewHeading, PreviewTitle, PreviewToolbar } from "./PreviewFrame";
import { PreviewSelectionActions } from "./PreviewSelectionActions";
import { PreviewTocPopover } from "./PreviewTocPopover";
import { usePreviewLinkCopy } from "./usePreviewLinkCopy";
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowLeft, ArrowUpRight, Bookmark, Archive, GripVertical, PanelRight, Circle, PanelLeft, RefreshCw, Search, FolderOpen, X, LoaderCircle, LayoutList, Table2, Columns3, LayoutGrid, Paperclip, MoreHorizontal, Link2, Check, RotateCcw, Layers, Heart, Send, CircleCheck, Maximize2, Minimize2 } from "lucide-react";
import { WorkspaceHeaderContext } from "./WorkspaceChrome";
import { useVisiblePolling } from "./useVisiblePolling";
import { SerialRefresh } from "./SerialRefresh";
import "./CollectionsWorkspace.css";
import "./ReadingWorkspaceReference.css";

type Source = "bookmarks" | "likes" | "telegram" | "dida";
const readingSourceIcons = { bookmarks: Bookmark, likes: Heart, telegram: Send, dida: CircleCheck };
const boardStatuses = ["unread", "in_progress", "read", "abandoned"] as const;
type BoardStatus = typeof boardStatuses[number];
const boardLabels: Record<BoardStatus,string> = {unread:"待读",in_progress:"进行中",read:"已读",abandoned:"放弃"};
type StorageConfig = { mode: "database" | "obsidian"; vaultPath: string; downloadMedia: boolean; autoSyncMinutes: number; localSourcesMinutes: number };
type VaultRelocation = { rootExists: boolean; candidates: { path: string; name: string }[] };
type Job = CollectionSyncJob;
type StorageState = { tdl?: TelegramTdlState; telegramRunning?: boolean; didaRunning?: boolean; config: StorageConfig; running: boolean; status: string; job?: Job; vaultRelocation?: VaultRelocation; localSources?: {running?:boolean;files?:number;remaining?:number;errors?:number;error?:string;lastCheckedAt?:number} };
type SourceState = CollectionSyncSource;
type Column = "source" | "author" | "published" | "collected" | "media" | "liked" | "destination";
type TableColumn = Column | "status" | "title";
const tableWidths:Record<TableColumn,number>={status:56,title:420,source:100,author:200,published:120,collected:120,media:110,liked:76,destination:140};
const tableLabels:Record<TableColumn,string>={status:"状态",title:"内容",source:"来源",author:"作者",published:"发布时间",collected:"创建日期",media:"附件",liked:"喜欢",destination:"保存到"};
const defaultStorage: StorageConfig = { mode: "database", vaultPath: "", downloadMedia: true, autoSyncMinutes: 30, localSourcesMinutes: 0 };
const labels: Record<Column,string> = {source:"来源",author:"作者",published:"发布时间",collected:"创建日期",media:"附件",liked:"喜欢",destination:"保存到"};
const sourceName = (source: string) => source === "web" ? "公共网页快照" : source === "dida" ? "滴答稍后读" : source === "telegram" ? "Telegram" : source === "likes" ? "X 喜欢" : "X 书签";
const date = (value: string | number) => Number.isNaN(new Date(value).getTime()) ? "—" : new Date(value).toLocaleDateString();
const readingListDate = (value: string | number) => {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? "—" : String(timestamp.getMonth()+1).padStart(2,"0")+"-"+String(timestamp.getDate()).padStart(2,"0");
};
const readingSourceLabel = (source: string) => source === "dida" ? "滴答" : sourceName(source);
const readingMinutes = (text: string) => {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(han / 400 + words / 220));
};
const fullTitle = (item: CollectionItem) => item.post.text.trim().split(/\r?\n/).find(Boolean) || (item.post.source === "dida" ? "滴答稍后读" : `${item.post.authorName || (item.post.source === "telegram" ? "Telegram" : "X 用户")}的${item.post.source === "telegram" ? "收集" : "推文"}`);
const title = (item: CollectionItem) => fullTitle(item).slice(0,160);
const PREVIEW_WIDTH_KEY = "hub.collection.preview-width-v1";
const DEFAULT_PREVIEW_WIDTH = 520;
const MIN_READING_PANEL = 300;
const MAX_PREVIEW_WIDTH = 1600;
const PREVIEW_DIVIDER_WIDTH = 10;
const DEFAULT_BROWSE_WIDTH = 356;
const READING_STAGE_PADDING = 20;
const readingStatusShortcuts: Record<string,string> = { "1": "unread", "2": "in_progress", "3": "read" };
const readingLayouts = [
  { id: "list", label: "精简阅读流（双栏分屏）", icon: LayoutList },
  { id: "table", label: "全宽属性表格", icon: Table2 },
  { id: "board", label: "阅读进度看板", icon: Columns3 },
  { id: "gallery", label: "视觉灵感画廊", icon: LayoutGrid },
] as const;
function loadPreviewWidth() {
  try {
    const value = Number(userProfileStorage.getItem(PREVIEW_WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? Math.min(MAX_PREVIEW_WIDTH, Math.max(MIN_READING_PANEL, Math.round(value))) : 0;
  } catch { return 0; }
}

export function CollectionsWorkspace({ onToggleDesktopSidebar, initialItemKey, initialQuery, initialContext, onSearchTargetHandled, onOpenLibrarySettings }: { onToggleDesktopSidebar?: () => void; initialItemKey?: string; initialQuery?: string; initialContext?:string; onSearchTargetHandled?: () => void; onOpenLibrarySettings?: () => void }) {
  const shellHeader = useContext(WorkspaceHeaderContext);
  const {view, updateView, activeEntry, isModified, selectView, updateSavedView, setNavigationCounts, settingsRevision, session, updateSession, pageSnapshot, dataRevision} = useCollectionViews();
  const [searchItemKey,setSearchItemKey]=useState<string|null>(null);
  const changeView = (patch: Partial<View>) => {setSearchItemKey(null);updateView(patch);updateSession({offset:0,scrollTop:0});};
  const query=view.query;
  const setQuery=(query:string)=>changeView({query});
  const offset=session.offset;
  const setOffset=(offset:number)=>updateSession({offset});
  const selectedKey=session.selectedKey;
  const setSelectedKey=(selectedKey:string|null)=>{if(!selectedKey)setSearchItemKey(null);updateSession({selectedKey});};
  useEffect(()=>{if(initialItemKey){reading.pending.current={query:initialQuery || "",context:initialContext};setSearchItemKey(initialItemKey);updateSession({selectedKey:initialItemKey,previewEnabled:true,offset:0});onSearchTargetHandled?.();}},[initialItemKey]);
  const [openReadingKey,setOpenReadingKey]=useState<string|null>(null);
  const [checkedKeys,setCheckedKeys]=useState<Set<string>>(()=>new Set());
  const [articleMenu,setArticleMenu]=useState(false);
  const [readingFocusMode,setReadingFocusMode]=useState(false);
  const [readingWideText,setReadingWideText]=useState<boolean>(()=>{try{return userProfileStorage.getItem("hub.preview.wide-text.v1")==="true";}catch{return false;}});
  const readingContentRef=useRef<HTMLDivElement>(null);
  const previewEnabled=session.previewEnabled;
  const setPreviewEnabled=(previewEnabled:boolean)=>updateSession({previewEnabled});
  const cards = {...defaultCollectionCards,...view.cards};
  const sorts = normalizeCollectionSorts(view.sorts,view.sort,view.ascending);
  const changeSorts = (rules: CollectionSortRule[]) => changeView({sorts:rules,sort:rules[0]?.field||"collected",ascending:rules[0]?.ascending||false});
  const sortingKey = JSON.stringify(sorts.map(({field,ascending})=>({field,ascending})));
  const tagsKey=JSON.stringify(view.tags);
  const includeAbandoned = view.layout === "board" && view.status === "all" && !view.attentionOnly;
  const loadKey = JSON.stringify([query,offset,includeAbandoned,view.source,view.status,view.attentionOnly,view.destinationId,view.dateFilter,view.media,view.sort,view.ascending,sortingKey,tagsKey,searchItemKey]);
  const [libraries,setLibraries]=useState<LibrarySummary[]>([]);
  const [operations,setOperations]=useState<CollectionLibraryOperation[]>([]);
  const [reviewKey,setReviewKey]=useState<string|null>(null);
  const [reviewTarget,setReviewTarget]=useState<string|null>(null);
  const openReview=(key:string,target?:string)=>{setReviewTarget(target||null);setReviewKey(key);};
  const [conversionBusy,setConversionBusy]=useState(false);
  const [conversionError,setConversionError]=useState("");
  useEffect(()=>setConversionError(""),[reviewKey]);
  const [deleting,setDeleting]=useState<CollectionItem|null>(null);
  const deleteDialog=useRef<HTMLDialogElement>(null);
  const [deleteFiles,setDeleteFiles]=useState<string[]>([]);
  const pageLoadKey = useRef(pageSnapshot.current?.key === loadKey ? loadKey : null);
  const [pageState, setPage] = useState<CollectionPage | null>(() => pageSnapshot.current?.key === loadKey ? pageSnapshot.current.page : null);
  const page = pageLoadKey.current === loadKey ? pageState : null;
  const latestPage=useRef(page);latestPage.current=page;
  const latestLoad=useRef<(fresh?: boolean)=>Promise<void>>(async()=>{});
  const [storage, setStorage] = useState<StorageState>({config:defaultStorage,running:false,status:""});
  const [draft,setDraft] = useState<StorageConfig>(defaultStorage);
  const [settings,setSettings] = useState(false);
  const [savingStorage,setSavingStorage] = useState(false);
  const [checkingSources,setCheckingSources] = useState(false);
  const [connecting,setConnecting] = useState(false);
  const [connectionSource,setConnectionSource] = useState<Source>("bookmarks");
  const connectionLabel = connectionSource === "likes" ? "喜欢" : "书签";
  const [request,setRequest] = useState("");
  const [busy,setBusy] = useState(false);
  const [launching,setLaunching] = useState<Source|"all"|null>(null);
  const [error,setError] = useState("");
  const previewLink = usePreviewLinkCopy(setError);
  const [notice,setNotice] = useState("");
  const [propertyBusy,setPropertyBusy]=useState(false);
  const propertyWrite=useRef(false);
  const boardRef=useRef<HTMLDivElement>(null);
  const boardDragCleanup=useRef<(()=>void)|null>(null);
  const suppressBoardClick=useRef(false);
  const [boardDragKey,setBoardDragKey]=useState("");
  const [boardDropStatus,setBoardDropStatus]=useState<BoardStatus|null>(null);
  const [boardDragPreview,setBoardDragPreview]=useState<{title:string;x:number;y:number}|null>(null);
  const [searchOpen,setSearchOpen] = useState(false);
  const [syncMenu,setSyncMenu] = useState(false);
  const [syncOverview,setSyncOverview] = useState<"source"|"cloud"|null>(null);
  const [didaSession,setDidaSession] = useState<ReadingDidaSession|null>(null);
  const databaseRef=useRef<HTMLDivElement>(null);
  const inspectorRef=useRef<ReadingArticleToolsHandle>(null);
  const previewBackRef=useRef<HTMLButtonElement>(null);
  const bodyRef=useRef<HTMLDivElement>(null);
  const [bodyWidth,setBodyWidth]=useState(0);
  const [previewWidth,setPreviewWidth]=useState(loadPreviewWidth);
  const previewWidthRef=useRef(previewWidth);
  const resizeCleanup=useRef<(()=>void)|null>(null);
  const compactControls=runtimeCapabilities.mobile||(bodyWidth>0&&bodyWidth<700);
  const compactPreview=runtimeCapabilities.mobile||(bodyWidth>0&&bodyWidth<MIN_READING_PANEL*2+PREVIEW_DIVIDER_WIDTH+READING_STAGE_PADDING);
  const maximumPreviewWidth=bodyWidth>0?Math.min(MAX_PREVIEW_WIDTH,Math.max(MIN_READING_PANEL,bodyWidth-READING_STAGE_PADDING-MIN_READING_PANEL-PREVIEW_DIVIDER_WIDTH)):MAX_PREVIEW_WIDTH;
  const defaultReaderWidth=bodyWidth>0?bodyWidth-READING_STAGE_PADDING-DEFAULT_BROWSE_WIDTH-PREVIEW_DIVIDER_WIDTH:DEFAULT_PREVIEW_WIDTH;
  const effectivePreviewWidth=Math.min(maximumPreviewWidth,Math.max(MIN_READING_PANEL,previewWidth||defaultReaderWidth));
  const useSplitReading=!compactPreview&&view.layout==="list"&&!view.attentionOnly;
  useEffect(()=>{
    const body=bodyRef.current;if(!body)return;
    const measure=()=>setBodyWidth(Math.round(body.getBoundingClientRect().width));
    measure();window.addEventListener("resize",measure);
    const observer=typeof ResizeObserver!=="undefined"?new ResizeObserver(measure):null;
    observer?.observe(body);
    return()=>{observer?.disconnect();window.removeEventListener("resize",measure);resizeCleanup.current?.();};
  },[]);
  const persistPreviewWidth=(value:number)=>{
    const width=Math.min(maximumPreviewWidth,Math.max(MIN_READING_PANEL,Math.round(value)));
    previewWidthRef.current=width;setPreviewWidth(width);
    try{userProfileStorage.setItem(PREVIEW_WIDTH_KEY,String(width));}catch{/* keep the width for this session */}
  };
  const resetPreviewWidth=()=>{
    previewWidthRef.current=0;
    setPreviewWidth(0);
    try{userProfileStorage.removeItem(PREVIEW_WIDTH_KEY);}catch{/* retain the reset for this session */}
  };
  const resizePreview=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.button!==0||compactPreview)return;event.preventDefault();resizeCleanup.current?.();
    const startX=event.clientX,startWidth=effectivePreviewWidth;
    const pointerId=event.pointerId;const handle=event.currentTarget;
    handle.setPointerCapture?.(pointerId);document.body.classList.add("resizing-reading-preview");
    const move=(next:PointerEvent)=>{if(next.pointerId!==pointerId)return;const width=Math.min(maximumPreviewWidth,Math.max(MIN_READING_PANEL,Math.round(startWidth+startX-next.clientX)));previewWidthRef.current=width;bodyRef.current?.style.setProperty("--reading-preview-width",`${width}px`);handle.setAttribute("aria-valuenow",String(width));};
    const cleanup=()=>{window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",finish);window.removeEventListener("pointercancel",finish);document.body.classList.remove("resizing-reading-preview");if(handle.hasPointerCapture?.(pointerId))handle.releasePointerCapture(pointerId);resizeCleanup.current=null;};
    const finish=(next:PointerEvent)=>{if(next.pointerId!==pointerId)return;persistPreviewWidth(previewWidthRef.current);cleanup();};
    resizeCleanup.current=cleanup;window.addEventListener("pointermove",move);window.addEventListener("pointerup",finish);window.addEventListener("pointercancel",finish);
  };
  const resizePreviewWithKeyboard=(event:ReactKeyboardEvent<HTMLDivElement>)=>{
    let width=effectivePreviewWidth;
    if(event.key==="ArrowLeft")width+=event.shiftKey?40:16;
    else if(event.key==="ArrowRight")width-=event.shiftKey?40:16;
    else if(event.key==="Home")width=MIN_READING_PANEL;
    else if(event.key==="End")width=maximumPreviewWidth;
    else if(event.key==="Enter"){event.preventDefault();resetPreviewWidth();return;}
    else return;event.preventDefault();persistPreviewWidth(width);
  };
  const positionRestored=useRef(false);
  const settingsRequest=useRef(settingsRevision);
  useEffect(()=>{if(settingsRevision!==settingsRequest.current){settingsRequest.current=settingsRevision;setDraft(storage.config);setSyncMenu(false);setError("");if(runtimeCapabilities.mobile)openCloudSyncSettings();else setSettings(true);}},[settingsRevision,storage.config]);
  useEffect(()=>{positionRestored.current=false;if(databaseRef.current)databaseRef.current.scrollTop=session.scrollTop;},[activeEntry,session.offset]);
  useEffect(()=>{if(page&&!positionRestored.current&&databaseRef.current){databaseRef.current.scrollTop=session.scrollTop;positionRestored.current=true;}},[page,session.scrollTop]);
  useEffect(()=>{const close=(event:Event)=>{for(const menu of document.querySelectorAll<HTMLDetailsElement>(".collection-toolbar details[open]")){if(event.type==="blur"||(event instanceof KeyboardEvent&&event.key==="Escape")||(!(event instanceof KeyboardEvent)&&!menu.contains(event.target as Node)))menu.open=false;}};document.addEventListener("pointerdown",close);document.addEventListener("focusin",close);document.addEventListener("keydown",close);window.addEventListener("blur",close);return()=>{document.removeEventListener("pointerdown",close);document.removeEventListener("focusin",close);document.removeEventListener("keydown",close);window.removeEventListener("blur",close);};},[]);
  useEffect(()=>{if(error&&!connecting&&!settings)publishCodexNotice(error,"error",0);},[error,connecting,settings]);
  useEffect(()=>{if(conversionError)publishCodexNotice(conversionError,"error",0);},[conversionError]);
  useEffect(()=>{if(notice)publishCodexNotice(notice,"success",6000);},[notice]);
  const tableRef = useRef<HTMLTableElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const statusGeneration = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refreshQueue = useRef(new SerialRefresh());
  const statusRefreshQueue = useRef(new SerialRefresh());
  const loadLocation = useRef({ key: loadKey });
  if (loadLocation.current.key !== loadKey) loadLocation.current = { key: loadKey };
  const load = useCallback((fresh = true) => {
    const location = loadLocation.current;
    // A pending write can finish after another filter or workspace is opened.
    // Keep its invalidation, but never let that old owner restart an old query.
    if (!mounted.current) {
      if (fresh) { pageSnapshot.current = null; dataRevision.current++; }
      return Promise.resolve();
    }
    if (location.key !== loadKey) return latestLoad.current(fresh);
    // A write or explicit refresh invalidates retained rows immediately, also
    // preventing an older in-flight poll from repopulating the return snapshot.
    if (fresh) { pageSnapshot.current = null; dataRevision.current++; generation.current++; statusGeneration.current++; }
    const statusRead = statusRefreshQueue.current.run(loadKey, async () => {
      if (location !== loadLocation.current) return;
      const current = ++statusGeneration.current;
      const revision = dataRevision.current;
      const apply = () => mounted.current && dataRevision.current === revision && statusGeneration.current === current && location === loadLocation.current;
      await Promise.all([
        invoke<StorageState>("get_collection_storage").then(state => { if (apply() && state?.config) setStorage({...state,config:{...defaultStorage,...state.config}}); }).catch(e => { if (apply()) setError(String(e)); }),
        invoke<LibrarySummary[]>("list_libraries").catch(()=>[]).then(libs => { if (apply()) setLibraries(Array.isArray(libs)?libs:[]); }),
        invoke<CollectionLibraryOperation[]>("collection_library_operations").catch(()=>[]).then(ops => { if (apply()) setOperations(Array.isArray(ops)?ops:[]); }),
      ]);
    }, fresh);
    const pageRead = refreshQueue.current.run(loadKey, async () => {
    if (location !== loadLocation.current) return;
    const current=++generation.current;
    const revision = dataRevision.current;
    try {
      const next = await invoke<CollectionPage>("list_collection_items", searchItemKey?{query:"",unreadOnly:false,offset:0,source:"all",status:"all",filters:{itemKey:searchItemKey}}:{query,unreadOnly:false,offset,source:view.source,status:view.attentionOnly?"needs_attention":view.status,media:view.media,sort:view.sort,ascending:view.ascending,sorts:JSON.parse(sortingKey),filters:{includeAbandoned,tags:JSON.parse(tagsKey),libraryId:view.destinationId||null,collectedWithinDays:view.dateFilter==="any"?null:Number(view.dateFilter)}});
      if (!mounted.current || dataRevision.current !== revision || generation.current !== current || location !== loadLocation.current) return;
      if(next.navigationCounts)setNavigationCounts(next.navigationCounts);
      if (offset>0 && offset>=next.matched) setOffset(Math.max(0,Math.floor((next.matched-1)/60)*60));
      else { pageSnapshot.current = { key: loadKey, page: next }; pageLoadKey.current = loadKey; setPage(next); }
    } catch(e) {if (mounted.current && dataRevision.current === revision && generation.current===current && location === loadLocation.current) setError(String(e));}
  }, fresh);
    // Auxiliary status must neither delay the rows nor hold up another query.
    void statusRead.catch(e => { if (location === loadLocation.current) setError(String(e)); });
    return pageRead;
  },[loadKey,query,offset,includeAbandoned,view.source,view.status,view.attentionOnly,view.destinationId,view.dateFilter,view.media,view.sort,view.ascending,sortingKey,tagsKey,setNavigationCounts,pageSnapshot,dataRevision,searchItemKey]);
  latestLoad.current=load;
  useVisiblePolling(() => load(false), true, 2000, { refreshKey: load, initialDelayMs: 150 });
  useEffect(() => () => { generation.current++; statusGeneration.current++; }, [load]);
  useEffect(()=>{if(connecting) dialog.current?.showModal();else {dialog.current?.close();setRequest("");}},[connecting]);
  useEffect(()=>{if(settings) settingsDialog.current?.showModal();else settingsDialog.current?.close();},[settings]);
  useEffect(()=>{if(deleting){deleteDialog.current?.showModal();void invoke<string[]>("collection_delete_preview",{key:deleting.key}).then(setDeleteFiles).catch(e=>setError(String(e)));}else{deleteDialog.current?.close();setDeleteFiles([]);}},[deleting]);
  const review=operations.find(o=>o.key===reviewKey&&(!reviewTarget||o.target===reviewTarget))||page?.items.flatMap(item=>item.attentionOperations||[]).find(o=>o.key===reviewKey&&(!reviewTarget||o.target===reviewTarget));
  const operationMessage=operations.length ? (()=>{
    const running=operations.filter(o=>!o.error&&["queued","ready","planning","saving","writing","cleanup"].includes(o.phase));
    const blocked=operations.filter(o=>o.phase!=="cancelled"&&(!!o.error||["failed","partial","unknown","needs_review"].includes(o.phase)));
    const latest=blocked[0];
    return {text:latest ? `资料库副本 · ${latest.plan?.libraryName||"待处理"}：${latest.error||latest.detail||"请查看处理方案"}${running.length?` · 另有 ${running.length} 项正在处理`:""}` : running.length ? `资料库副本 · 正在处理 ${running.length} 项${running[0].detail?` · ${running[0].detail}`:""}` : "",tone:latest?"warning" as const:"working" as const};
  })() : null;
  const lastOperationText=useRef("");
  const operationStartNotice=useRef("");
  useEffect(()=>{
    if(operationMessage?.text){
      if(!lastOperationText.current)operationStartNotice.current=notice;
      publishCodexNotice(operationMessage.text,operationMessage.tone,0);
    }
    else if(lastOperationText.current&&notice===operationStartNotice.current)publishCodexNotice("资料库处理已结束，可查看各库副本记录","success",4500);
    lastOperationText.current=operationMessage?.text||"";
  },[operationMessage?.text,operationMessage?.tone]);
  const job=storage.job;
  useEffect(()=>{if(job?.id&&job.outcome)setNotice("");},[job?.id,job?.outcome]);
  const storageRunning=Boolean(job?.running || page?.running || storage.running || (launching && launching!=="telegram"&&launching!=="dida"));
  const jobRunning=Boolean(storageRunning || storage.telegramRunning || storage.didaRunning || storage.tdl?.running || launching);
  // Telegram owns a separate receiver lock; an X fetch or shared export does not block bot setup.
  const sourceConnectionRunning=(source:Source)=>source==="dida"?Boolean(storage.didaRunning || launching==="dida"):source==="telegram"?Boolean(storage.telegramRunning || launching==="telegram"):storageRunning;
  const sourceActive=(source:Source)=>source==="dida" ? Boolean(storage.didaRunning||launching==="dida") :
    source==="telegram" ? Boolean(storage.telegramRunning||launching==="telegram") : Boolean((job?.running&&job.source===source)||launching===source);
  const connectionRunning=sourceConnectionRunning(connectionSource);
  const sources: SourceState[] = (["bookmarks","likes","telegram","dida"] as Source[]).map(id=>pageState?.sources?.find(source=>source.id===id)||{id,count:id==="bookmarks"?(pageState?.total||0):0,connected:id==="bookmarks"?!!pageState?.connected:id==="dida"?libraries.some(l=>l.provider==="dida365"&&l.connected):false,canResume:id==="bookmarks"?!!pageState?.canResume:false,status:id==="bookmarks"?(pageState?.status||""):""});
  const activeTotal=pageState?.sources?.length?sources.reduce((sum,source)=>sum+source.count,0):pageState?.total||0;
  const connection=sources.find(s=>s.id===connectionSource);
  const selected=page?.items.find(item=>item.key===selectedKey)||(useSplitReading&&!searchItemKey?page?.items[0]:undefined);
  const selectedSource=selected?.post.source||"bookmarks";
  const detailOpen=!!selected&&previewEnabled&&!useSplitReading&&(runtimeCapabilities.mobile||openReadingKey===selected.key||searchItemKey===selected.key);
  const showReading=!!selected&&previewEnabled&&(useSplitReading||detailOpen);
  useEffect(()=>{if(!showReading)setReadingFocusMode(false);},[showReading]);
  const reading = useMobileReadingPosition(readingContentRef, runtimeCapabilities.mobile && showReading ? selected?.key : undefined, selected ? fullTitle(selected) : "");
  const openItem=(key:string)=>{
    if (runtimeCapabilities.mobile && !reading.pending.current) reading.pending.current={query};
    setArticleMenu(false);
    setOpenReadingKey(key);
    updateSession({previewEnabled:true,selectedKey:key});
  };
  const closeReading=()=>{
    if(runtimeCapabilities.mobile && window.history.state?.hubExternalReading){window.history.back();return;}
    setArticleMenu(false);
    setOpenReadingKey(null);
    if(runtimeCapabilities.mobile && searchItemKey) setSearchItemKey(null);
    if(searchItemKey||runtimeCapabilities.mobile||useSplitReading)setPreviewEnabled(false);
  };
  const changeLayout=(layout:View["layout"])=>{
    if(layout===view.layout)return;
    setOpenReadingKey(null);
    setArticleMenu(false);
    changeView({layout});
  };
  const shownItems=page?.items||[];
  const batchItems=shownItems.filter(item=>checkedKeys.has(item.key));
  useEffect(()=>{setCheckedKeys(new Set());setArticleMenu(false);},[loadKey]);
  useEffect(()=>{setOpenReadingKey(null);},[activeEntry.kind,activeEntry.id,view.layout]);
  const toggleChecked=(key:string)=>setCheckedKeys(current=>{
    const next=new Set(current);
    if(next.has(key))next.delete(key);else next.add(key);
    return next;
  });
  const previewHistoryPushed=useRef(false);
  useEffect(()=>{
    if(!runtimeCapabilities.mobile)return;
    const closeAfterBack=(event:PopStateEvent)=>{
      if(previewHistoryPushed.current&&!event.state?.hubReadingPreview){
        previewHistoryPushed.current=false;
        setSearchItemKey(null);
        updateSession({previewEnabled:false});
      }
    };
    window.addEventListener("popstate",closeAfterBack);
    return()=>{
      window.removeEventListener("popstate",closeAfterBack);
      updateSession({previewEnabled:false});
    };
  },[updateSession]);
  useEffect(()=>{
    if(!runtimeCapabilities.mobile)return;
    if(window.history.state?.hubExternalReading) return;
    if(detailOpen&&!previewHistoryPushed.current){
      window.history.pushState({...window.history.state,hubReadingPreview:true},"");
      previewHistoryPushed.current=true;
    }else if(!detailOpen&&previewHistoryPushed.current){
      previewHistoryPushed.current=false;
      if(window.history.state?.hubReadingPreview)window.history.back();
    }
  },[detailOpen]);
  const wasDetailOpen=useRef(false);
  useEffect(()=>{
    // Scroll events persist position; only a detail transition may restore it.
    if(wasDetailOpen.current===detailOpen)return;
    if(detailOpen)previewBackRef.current?.focus();
    else if(databaseRef.current){
      databaseRef.current.scrollTop=session.scrollTop;
      if(wasDetailOpen.current)databaseRef.current.querySelector<HTMLElement>(".collection-row.selected,.collection-gallery-card.selected,.collection-table-wrap tr.selected,.collection-board article.selected button")?.focus({preventScroll:true});
    }
    wasDetailOpen.current=detailOpen;
  },[detailOpen,session.scrollTop]);
  const open = async(url:string)=>{try {await invoke("open_external_url",{url});} catch(e){setError(String(e));}};
  const store = async(saveSettings:boolean)=>{
    setSavingStorage(true);setError("");setNotice("");
    try {
      const message=await invoke<string>(saveSettings?"save_collection_storage":"export_collections_to_obsidian",saveSettings?{config:draft}:{});
      // The backend acknowledges persisted settings and owns the following job.
      if(saveSettings) setSettings(false);
      setNotice(message);await load();
    } catch(e){setError(String(e));} finally{setSavingStorage(false);}
  };
  const checkLocalSources = async () => {
    if(checkingSources || storage.localSources?.running) return "本地素材正在检查。";
    setCheckingSources(true);setError("");setNotice("");
    try {
      const result=await invoke<{files:number;changed:number;errors:number}>("check_local_reading_sources");
      setNotice(`本地素材检查完成：已检查 ${result.files} 个文件，新增或更新 ${result.changed} 条${result.errors?`，${result.errors} 个文件待重试`:""}`);
      await load();
      return result.errors ? "部分本地素材检查未通过，请重试或查看同步详情。" : undefined;
    } catch(e) {setError(String(e));return String(e);} finally {setCheckingSources(false);}
  };
  const selectVault=async()=>{try {const path=await chooseDirectory({directory:true,multiple:false,title:"选择新内容的默认保存库",...(draft.vaultPath&&!(storage.vaultRelocation?.rootExists===false&&draft.vaultPath===storage.config.vaultPath)?{defaultPath:draft.vaultPath}:{})});if(mounted.current&&typeof path==="string")setDraft(d=>({...d,vaultPath:path}));}catch(e){if(mounted.current)setError(String(e));}};
  const relocatingVault = useRef(false);
  const relocateVault=async(suggestedPath?:string)=>{
    if(relocatingVault.current||savingStorage||storageRunning)return;
    const expectedVaultPath=storage.config.vaultPath;
    if(storage.config.mode!=="obsidian"||!expectedVaultPath.trim())return;
    relocatingVault.current=true;setSavingStorage(true);setError("");setNotice("");
    try {
      const path=suggestedPath??await chooseDirectory({directory:true,multiple:false,title:"选择原 Obsidian 库改名或移动后的文件夹"});
      if(!mounted.current||typeof path!=="string")return;
      const result=await invoke<{location:string;warning:string|null}>("relocate_collection_vault",{expectedVaultPath,path});
      if(!mounted.current)return;
      setStorage(previous=>({...previous,config:{...previous.config,vaultPath:result.location},vaultRelocation:{rootExists:true,candidates:[]}}));
      setDraft(previous=>({...previous,vaultPath:result.location}));
      setNotice(`原库位置已更新，已有内容和附件关联已保留。${result.warning?` ${result.warning}`:""}`);
      await latestLoad.current();
    } catch(e){if(mounted.current)setError(String(e));}
    finally {relocatingVault.current=false;if(mounted.current)setSavingStorage(false);}
  };
  const refreshContent=async(key:string)=>{try{setNotice(await invoke<string>("refresh_collection_content",{key}));await load();}catch(e){setError(String(e));}};
  const sync=async(source:Source|"all",restart:boolean)=>{
    setLaunching(source);setError("");setNotice("");
    try {setNotice(await invoke<string>("sync_x_bookmarks",{source,restart}));await load();}
    catch(e){setError(String(e));return String(e);}finally{setLaunching(null);}
  };
  const save=async()=>{
    if(busy||connectionRunning||!request.trim())return;
    setBusy(true);setError("");
    try {
      if(connectionSource==="telegram"){
        setNotice(await invoke<string>("save_telegram_connection",{token:request.trim()}));
        setSyncMenu(true);
      }else{
        await invoke("save_x_bookmark_connection",{source:connectionSource,request});
        setNotice("连接已保存，可以立即同步，也会按设定间隔自动读取。");
      }
      setRequest("");setConnecting(false);await load();
    }catch(e){setError(String(e));}finally{setBusy(false);}
  };
  const disconnect=async()=>{setBusy(true);setError("");try {await invoke(connectionSource==="telegram"?"disconnect_telegram":"disconnect_x_bookmarks",connectionSource==="telegram"?{}:{source:connectionSource});setConnecting(false);setNotice("已断开，本地内容保留。");await load();}catch(e){setError(String(e));}finally{setBusy(false);}};
  const commitProperties=(key:string,status:string,tags:string[])=>{
    const update=(current:CollectionPage|null)=>current?{...current,items:current.items.map(item=>item.key===key?{...item,status,tags:[...tags],read:status==="read"||status==="abandoned"}:item)}:current;
    latestPage.current=update(latestPage.current);setPage(update);
  };
  const toggleRead=async(item:CollectionItem)=>{if(propertyWrite.current)return;propertyWrite.current=true;setPropertyBusy(true);setError("");try {await invoke("set_collection_read",{key:item.key,read:!item.read});commitProperties(item.key,item.read?"unread":"read",latestPage.current?.items.find(value=>value.key===item.key)?.tags||[]);await latestLoad.current();}catch(e){setError(String(e));}finally{propertyWrite.current=false;setPropertyBusy(false);}};
  const pause=async()=>{try {await invoke("cancel_x_bookmark_sync");setNotice("正在暂停，已完成的内容会保留。");await load();}catch(e){setError(String(e));}};
  const resetFilters=()=>{setSearchOpen(false);changeView({media:"all",query:"",tags:[],dateFilter:"any"});};
  const hasQueryFilters=!!query||view.media!=="all"||view.dateFilter!=="any"||view.tags.length>0;
  const needsAttention=(operation:CollectionLibraryOperation)=>!operation.parked&&operation.phase!=="cancelled"&&(!!operation.error||["failed","partial","unknown","needs_review"].includes(operation.phase));
  const issues=(item:CollectionItem)=>item.attentionOperations||operations.filter(o=>o.key===item.key&&needsAttention(o));
  const renderIssues=(item:CollectionItem)=>view.attentionOnly&&<div className="collection-attention-actions">{issues(item).map(o=><button key={o.target} onClick={e=>{e.stopPropagation();openReview(item.key,o.target);}}><span>{libraries.find(l=>l.id===o.target)?.name||o.plan?.libraryName||"资料库"}</span>：{o.phase==="unknown"?"待核对":o.phase==="needs_review"?"需要补充":o.phase==="partial"?"继续补齐":"查看失败记录"}</button>)}{item.attentionIssues?.map(issue=><button key={issue.kind} onClick={e=>{e.stopPropagation();setSyncMenu(true);}}>{issue.kind==="sourceCancellation"?"来源取消失败":"内容更新失败"}：查看同步记录</button>)}{issues(item).length===0&&!item.attentionIssues?.length&&<span>来源或附件处理需要检查，可查看同步与连接记录。</span>}</div>;
  const readControl=(item:CollectionItem)=><button className="collection-read-control" data-status={readingStatus(item)} type="button" disabled={propertyBusy} aria-label={`${item.read?"标为待读":"标为已读"}：${title(item)}`} aria-pressed={item.read} onClick={e=>{e.stopPropagation();void toggleRead(item);}}>{statusIcon(item.lifecycle==="archived"?"archived":readingStatus(item))}</button>;
  const badge=(item:CollectionItem)=><span className={`collection-source-badge ${item.post.source||"bookmarks"}`}>{sourceName(item.post.source||"bookmarks")}</span>;
  const saveProperties=async(item:CollectionItem,status:string,tags:string[],prefix="")=>{if(propertyWrite.current)return false;propertyWrite.current=true;setPropertyBusy(true);setError("");setNotice("");try{const message=await invoke<string>("set_collection_properties",{key:item.key,status,tags,expectedStatus:readingStatus(item),expectedTags:item.tags||[]});commitProperties(item.key,status,tags);setNotice(`${prefix}${message||"状态与标签已保存"}`);await latestLoad.current();return true;}catch(e){setError(String(e));return false;}finally{propertyWrite.current=false;setPropertyBusy(false);}};
  const applyBatch=async(action:"read"|"in_progress"|"archived")=>{
    if(propertyWrite.current)return;
    propertyWrite.current=true;
    setPropertyBusy(true);
    setError("");
    const failed=new Set<string>();
    try{
      for(const item of batchItems){
        try{
          if(action==="archived"){await invoke("set_collection_lifecycle",{key:item.key,state:"archived"});}
          else if(readingStatus(item)!==action){
            await invoke("set_collection_properties",{key:item.key,status:action,tags:item.tags||[],expectedStatus:readingStatus(item),expectedTags:item.tags||[]});
            commitProperties(item.key,action,item.tags||[]);
          }
        }catch{failed.add(item.key);}
      }
      await latestLoad.current();
      setCheckedKeys(failed);
      const count=batchItems.length-failed.size;
      setNotice(count?"已处理 "+count+" 篇":"");
      if(failed.size)setError(failed.size+" 篇处理失败，可重试。");
    }finally{propertyWrite.current=false;setPropertyBusy(false);}
  };
  const moveBoardCard=async(key:string,status:BoardStatus)=>{
    const item=latestPage.current?.items.find(item=>item.key===key);
    if(!item||propertyBusy||propertyWrite.current||item.lifecycle==="archived"||item.lifecycle==="deleting"||readingStatus(item)===status)return;
    const sourceNote=status==="abandoned"&&["bookmarks","likes"].includes(item.post.source||"bookmarks")?"（下次同步时取消 X 原收藏）":"";
    await saveProperties(item,status,item.tags||[],`已移至${boardLabels[status]}${sourceNote} · `);
  };
  const boardStatusAt=(x:number,y:number):BoardStatus|null=>{
    const column=document.elementFromPoint?.(x,y)?.closest<HTMLElement>("[data-reading-status]");
    const status=column?.dataset.readingStatus as BoardStatus|undefined;
    return column&&boardRef.current?.contains(column)&&status&&boardStatuses.includes(status)?status:null;
  };
  const beginBoardDrag=(event:ReactPointerEvent<HTMLElement>,item:CollectionItem)=>{
    const control=(event.target as Element).closest("button,a,input,select,textarea,summary");
    if(event.button!==0||event.isPrimary===false||propertyBusy||propertyWrite.current||item.lifecycle==="archived"||item.lifecycle==="deleting"||(control&&!control.matches(".collection-board-title,.collection-board-drag")))return;
    boardDragCleanup.current?.();
    const pointerId=event.pointerId,startX=event.clientX,startY=event.clientY,handle=event.currentTarget;
    let dragging=false;
    const move=(next:PointerEvent)=>{
      if(next.pointerId!==pointerId)return;
      if(!dragging&&Math.hypot(next.clientX-startX,next.clientY-startY)<6)return;
      if(!dragging){dragging=true;handle.setPointerCapture?.(pointerId);setBoardDragKey(item.key);document.body.classList.add("dragging-reading-card");}
      next.preventDefault();setBoardDragPreview({title:title(item),x:next.clientX,y:next.clientY});setBoardDropStatus(boardStatusAt(next.clientX,next.clientY));
    };
    const cleanup=()=>{
      boardDragCleanup.current=null;window.removeEventListener("pointermove",move);window.removeEventListener("pointerup",finish);window.removeEventListener("pointercancel",cancel);window.removeEventListener("blur",cancel);window.removeEventListener("keydown",key);handle.removeEventListener("lostpointercapture",cancel);
      if(handle.hasPointerCapture?.(pointerId))handle.releasePointerCapture(pointerId);
      document.body.classList.remove("dragging-reading-card");setBoardDragKey("");setBoardDropStatus(null);setBoardDragPreview(null);
    };
    const cancel=(next:Event)=>{if((next.type==="pointercancel"||next.type==="lostpointercapture")&&(next as PointerEvent).pointerId!==pointerId)return;cleanup();};
    const key=(next:KeyboardEvent)=>{if(next.key==="Escape"){next.preventDefault();cleanup();}};
    const finish=(next:PointerEvent)=>{
      if(next.pointerId!==pointerId)return;
      const status=dragging?boardStatusAt(next.clientX,next.clientY):null;
      if(dragging){next.preventDefault();suppressBoardClick.current=true;window.setTimeout(()=>{suppressBoardClick.current=false;},0);}
      cleanup();if(status)void moveBoardCard(item.key,status);
    };
    boardDragCleanup.current=cleanup;window.addEventListener("pointermove",move,{passive:false});window.addEventListener("pointerup",finish);window.addEventListener("pointercancel",cancel);window.addEventListener("blur",cancel);window.addEventListener("keydown",key);handle.addEventListener("lostpointercapture",cancel);
  };
  const moveBoardWithKeyboard=(event:ReactKeyboardEvent<HTMLButtonElement>,item:CollectionItem)=>{
    const current=boardStatuses.indexOf(readingStatus(item) as BoardStatus);
    const target=event.key==="ArrowRight"?current+1:event.key==="ArrowLeft"?current-1:event.key==="Home"?0:event.key==="End"?boardStatuses.length-1:-1;
    if(!["ArrowRight","ArrowLeft","Home","End"].includes(event.key))return;
    event.preventDefault();if(target>=0&&target<boardStatuses.length)void moveBoardCard(item.key,boardStatuses[target]);
  };
  useEffect(()=>()=>boardDragCleanup.current?.(),[]);
  useEffect(()=>{boardDragCleanup.current?.();},[view.layout,activeEntry,propertyBusy]);
  const lifecycle=async(item:CollectionItem,state:"active"|"archived"|"deleting")=>{if(state==="deleting"){setDeleting(item);return;}setPropertyBusy(true);setError("");try{setNotice(await invoke<string>("set_collection_lifecycle",{key:item.key,state}));setSelectedKey(null);await load();}catch(e){setError(String(e));}finally{setPropertyBusy(false);}};
  const move=async(item:CollectionItem,destination:string)=>{setPropertyBusy(true);setError("");try{setNotice(await invoke<string>("move_collection_to_library",{key:item.key,destination}));await load();}catch(e){setError(String(e));}finally{setPropertyBusy(false);}};
  const removeDestination=async(item:CollectionItem,destination:string)=>{setPropertyBusy(true);setError("");try{setNotice(await invoke<string>("remove_collection_library_destination",{key:item.key,destination}));await load();}catch(e){setError(String(e));}finally{setPropertyBusy(false);}};
  const approveConversion=async()=>{if(!review?.key||conversionBusy)return;setConversionBusy(true);setConversionError("");try{setNotice(await invoke<string>("approve_collection_conversion",{key:review.key,expectedTarget:review.target}));setReviewKey(null);}catch(e){setConversionError(String(e));}finally{await load();setConversionBusy(false);}};
  const cancelConversion=async()=>{if(!review?.key||conversionBusy)return;setConversionBusy(true);setConversionError("");try{const message=await invoke<string>("cancel_collection_conversion",{key:review.key,expectedTarget:review.target});setReviewKey(null);setNotice(message||"方案已取消，原内容和附件保留");}catch(e){setConversionError(String(e));}finally{await load();setConversionBusy(false);}};
  const regenerateConversion=async(goal:string)=>{if(!review?.key||conversionBusy)return;setConversionBusy(true);setConversionError("");try{await invoke("regenerate_collection_conversion",{key:review.key,goal,expectedTarget:review.target});setReviewKey(null);await load();}catch(e){setConversionError(String(e));}finally{setConversionBusy(false);}};
  const resolveConversion=async(remoteId:string)=>{if(!review?.key||conversionBusy)return;setConversionBusy(true);setConversionError("");try{await invoke("resolve_collection_conversion",{key:review.key,remoteId,expectedTarget:review.target});await load();}catch(e){setConversionError(String(e));}finally{setConversionBusy(false);}};
  const resumeReview=async()=>{if(!review?.key||conversionBusy)return;setConversionBusy(true);setConversionError("");try{setNotice(await invoke<string>("move_collection_to_library",{key:review.key,destination:review.target}));await load();}catch(e){setConversionError(String(e));}finally{setConversionBusy(false);}};
  const openAttachmentLogin=async()=>{setConversionError("");try{await invoke("open_dida_attachment_login");}catch(e){setConversionError(String(e));}};
  const confirmDelete=async()=>{if(!deleting)return;setPropertyBusy(true);try{setNotice(await invoke<string>("set_collection_lifecycle",{key:deleting.key,state:"deleting"}));setSelectedKey(null);setDeleting(null);await load();}catch(e){setError(String(e));}finally{setPropertyBusy(false);}};
  const readingStatus=(item:CollectionItem)=>item.status||(item.read?"read":"unread");
  const statusIcon=(status:string)=>status==="archived"?<Archive size={16}/>:status==="read"?<CompletedStatusIcon size={19}/>:status==="abandoned"?<CircleSlash size={19}/>:status==="in_progress"?<svg width="19" height="19" viewBox="0 0 20 20" aria-label="进行中"><circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeWidth="1.5"/><path d="M10 2 A8 8 0 0 1 18 10 H10 Z" fill="currentColor"/></svg>:<Circle size={19}/>;
  const checkItem=(item:CollectionItem)=><input className="reading-item-checkbox" type="checkbox" aria-label={"选择："+title(item)} checked={checkedKeys.has(item.key)} onClick={event=>event.stopPropagation()} onChange={()=>toggleChecked(item.key)}/>;
  const downloaded=(item:CollectionItem)=>collectionAttachments(item.post).filter(asset=>item.savedMedia?.includes(asset.url)).length;
  const galleryCover = (item: CollectionItem) => {
    const original = collectionAttachments(item.post)[0];
    const preview = original?.previewUrl;
    const previewAvailable = !!preview && (item.savedMedia?.includes(preview) || item.cloudPreviewUrls?.includes(preview));
    const media = original ? { ...original, previewUrl: previewAvailable ? preview : undefined } : undefined;
    const url = media?.previewUrl || media?.url || "";
    return <CollectionGalleryCover itemKey={item.key} media={media} saved={!!url && !!item.savedMedia?.includes(url)} cloudPreview={!!media?.previewUrl && !!item.cloudPreviewUrls?.includes(media.previewUrl)} text={item.post.text}/>;
  };
  const copyLibraries=(item:CollectionItem)=>libraries.filter(l=>(item.destinationIds||[item.destinationId]).includes(l.id));
  const copyBadges=(item:CollectionItem)=><>{copyLibraries(item).map(l=><CollectionLibraryBadge key={l.id} library={l}/>)}</>;
  const attentionRows = view.attentionOnly ? shownItems.flatMap(item => {
    const targets = issues(item).map(operation => ({
      item, key: item.key+":"+operation.target, heading: operation.plan?.libraryName||libraries.find(library=>library.id===operation.target)?.name||"资料库副本",
      group: operation.phase==="partial" ? "后台可恢复" : "待你确认",
      detail: operation.error||operation.detail||"查看保存方案",
      label: operation.phase==="unknown" ? "核对并关联" : operation.phase==="partial" ? "继续补齐" : "查看方案",
      action: () => openReview(item.key,operation.target),
    }));
    const sources = (item.attentionIssues||[]).map(issue => ({
      item, key: item.key+":"+issue.kind, heading: sourceName(item.post.source||"bookmarks"),
      group: "需重连与会话故障", detail: issue.error, label: "查看同步记录",
      action: () => setSyncMenu(true),
    }));
    return [...targets,...sources];
  }) : [];
  const cardValue=(item:CollectionItem,field:CardField)=>field==="destination"?copyLibraries(item).map(l=>l.name).join("、"):field==="status"?(({unread:"待读",read:"已读",in_progress:"进行中",abandoned:"放弃"} as Record<string,string>)[readingStatus(item)]||"待读"):field==="source"?sourceName(item.post.source||"bookmarks"):field==="author"?(item.post.authorName||item.post.authorHandle):field==="published"?date(item.post.publishedAt):field==="collected"?date(item.collectedAt):field==="liked"?(item.post.liked||item.post.source==="likes"?"是":"否"):`${downloaded(item)}/${collectionAttachments(item.post).length} 已下载`;
  const cardStyle=(item:CollectionItem)=>{const rule=view.layout==="gallery"?cards.rules.find(rule=>{const value=cardValue(item,rule.field);return rule.operator==="equals"?value===rule.value:rule.operator==="contains"?value.includes(rule.value):rule.operator==="not_contains"?!value.includes(rule.value):rule.operator==="is_empty"?!value:!!value;}):undefined;if(rule)return {background:rule.color};const color=view.colorMode==="source"?({bookmarks:"#737b86",likes:"#c77b98",telegram:"#2198d4",dida:"#4a71f3"} as Record<string,string>)[item.post.source||"bookmarks"]:view.colorMode==="status"?({unread:"#2088e9",in_progress:"#c18a24",read:"#3a9e61",abandoned:"#89909b",archived:"#89909b"} as Record<string,string>)[readingStatus(item)]:undefined;return color?{background:`color-mix(in srgb, ${color} 12%, var(--hub-content-surface, #fff))`}:undefined;};
  const fields=(item:CollectionItem,column:Column)=>column==="destination"?copyBadges(item):column==="source"?badge(item):column==="author"?(item.post.authorName||item.post.authorHandle):column==="published"?date(item.post.publishedAt):column==="collected"?date(item.collectedAt):column==="liked"?(item.post.liked||item.post.source==="likes"?"是":"否"):`${downloaded(item)}/${collectionAttachments(item.post).length} 已下载`;
  const jobVisible=Boolean(job?.id && (job.running || job.outcome==="paused" || job.outcome==="failed"));
  const visibleColumns:TableColumn[]=["status","title",...(Object.keys(labels) as Column[]).filter(c=>view.columns[c])];
  const widths={...tableWidths};for(const c of visibleColumns){const saved=view.widths?.[c];if(typeof saved==="number"&&Number.isFinite(saved))widths[c]=Math.min(1600,Math.max(c==="status"?44:72,saved));}
  const setWidths=(patch:Partial<Record<TableColumn,number>>)=>{updateView({widths:{...view.widths,...patch}});updateSavedView();};
  const beginResize=(column:TableColumn)=>{const measured:Partial<Record<TableColumn,number>>={};for(const header of tableRef.current?.querySelectorAll<HTMLTableCellElement>("th[data-column]")||[]){const c=header.dataset.column as TableColumn;measured[c]=Math.round(header.getBoundingClientRect().width)||widths[c];}setWidths(measured);return measured[column]||widths[column];};
  const searchButtonRef=useRef<HTMLButtonElement>(null);
  const searchInputRef=useRef<HTMLInputElement>(null);
  const dismissSearch=()=>{setSearchOpen(false);setQuery("");requestAnimationFrame(()=>searchButtonRef.current?.focus());};
  useEffect(()=>{if(searchOpen)searchInputRef.current?.focus();},[searchOpen,compactControls]);
  const readingKeys=(event:ReactKeyboardEvent<HTMLElement>)=>{
    if(runtimeCapabilities.mobile||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey)return;
    const target=event.target as HTMLElement;
    if(target.closest("dialog,.collection-sync-popover"))return;
    if(event.key==="Escape"){
      if(target.closest(".collection-property-menu,.collection-destination-menu,details[open]"))return;
      if(articleMenu)setArticleMenu(false);
      else if(readingFocusMode)setReadingFocusMode(false);
      else if(syncMenu)setSyncMenu(false);
      else if(searchOpen)dismissSearch();
      else if(detailOpen)closeReading();
      else return;
      event.preventDefault();
      return;
    }
    if(target.closest("input,textarea,select,[contenteditable=true]"))return;
    if(event.key==="/"){event.preventDefault();setSearchOpen(true);return;}
    const key=event.key.toLowerCase();
    if(key==="j"||key==="k"){
      const index=shownItems.findIndex(item=>item.key===selected?.key);
      const next=shownItems[Math.max(0,Math.min(shownItems.length-1,index+(key==="j"?1:-1)))];
      if(next){event.preventDefault();openItem(next.key);requestAnimationFrame(()=>{
        if(document.activeElement===previewBackRef.current)return;
        databaseRef.current?.querySelector<HTMLElement>(".selected")?.scrollIntoView?.({block:"nearest"});
      });}
      return;
    }
    if(!selected||(!showReading&&!target.closest(".collection-database"))||propertyBusy||event.repeat)return;
    const status=readingStatusShortcuts[key];
    if(status&&selected.lifecycle!=="archived"){event.preventDefault();void saveProperties(selected,status,selected.tags||[]);}
    if(key==="e"&&selected.lifecycle!=="archived"&&selected.lifecycle!=="deleting"){event.preventDefault();void lifecycle(selected,"archived");}
  };
  const layoutName=readingLayouts.find(layout=>layout.id===view.layout)?.label;
  const activeTitle=activeEntry.kind==="view"?view.name:activeEntry.kind==="library"?(libraries.find(library=>library.id===activeEntry.id)?.name||"资料库副本"):collectionEntryLabels[activeEntry.id as CollectionBuiltinEntry];
  const sourceCount = view.source === "all" ? activeTotal : sources.find(source => source.id === view.source)?.count ?? activeTotal;
  const toggleReadingNavigation = shellHeader?.onToggleReadingNavigation ?? onToggleDesktopSidebar;
  return <section onKeyDown={readingKeys} className={`collections-workspace task-workspace${compactControls?" collection-compact-layout":""}${detailOpen?" collection-detail-open":""}`} aria-label="阅读">
    {runtimeCapabilities.mobile && reading.bookmark && !query.trim() && !detailOpen && <button className="bw-resume" onClick={()=>{const mark=reading.bookmark!;reading.pending.current={bookmark:mark};setSearchItemKey(mark.key);openItem(mark.key);}}><strong>继续上次阅读</strong><span>{reading.bookmark.title}</span><small>{reading.bookmark.paragraph < 0 ? "文章开头" : `正文第 ${reading.bookmark.paragraph + 1} 段`} ›</small></button>}
    {searchItemKey&&(!runtimeCapabilities.mobile || (page && !page.items.length))&&<div role="status" className="collection-notice">从搜索打开的阅读条目<button type="button" onClick={()=>setSelectedKey(null)}>返回阅读列表</button>{page&&!page.items.length&&<span>条目已变更或移除，请重新搜索。</span>}</div>}
    <div className="collection-browse-controls" hidden={detailOpen&&(compactPreview||runtimeCapabilities.mobile)}>
    {runtimeCapabilities.mobile?<MobileReadingControls view={view} onChange={changeView} count={page?.matched} tags={page?.availableTags||[]} onSync={openCloudSyncSettings}><CollectionViewTabs onChange={changeView} compact={true} onNotice={setNotice}/><CollectionSort key={`${view.id}:${view.layout}`} rules={sorts} onChange={changeSorts}/></MobileReadingControls>:<>
    <header className="task-workspace-header collection-header" onMouseDown={e=>{if(!(e.target as HTMLElement).closest("button, input, select, textarea, a, summary, details, [role=button]"))shellHeader?.onMouseDown(e);}}>
      <div className="task-source-chips" role="group" aria-label="阅读来源">
        {!runtimeCapabilities.mobile&&toggleReadingNavigation&&<button className="task-icon-button workspace-panel-toggle" aria-label="切换侧边栏" aria-expanded={shellHeader?.readingNavigationExpanded} onClick={toggleReadingNavigation}><PanelLeft size={16}/></button>}
        <strong className="reading-window-title">阅读</strong>
        <div className="reading-source-segment">
        <button className={`task-source-chip ${view.source==="all"?"active":""}`} aria-pressed={view.source==="all"} onClick={()=>changeView({source:"all"})}><Layers size={12}/><span>全部</span><strong>{activeTotal.toLocaleString("en-US")}</strong></button>
        {sources.map(s=>{const Icon=readingSourceIcons[s.id];return <button key={s.id} className={`task-source-chip collection-chip-${s.id} ${view.source===s.id?"active":""}`} aria-pressed={view.source===s.id} onClick={()=>changeView({source:s.id})}><Icon size={12}/><span>{readingSourceLabel(s.id)}</span><strong>{s.count.toLocaleString("en-US")}</strong></button>;})}
        </div>
      </div>
      {!runtimeCapabilities.mobile&&<div className="collection-header-tools">
        {searchOpen&&!compactControls?<label className="task-toolbar-search"><Search size={14}/><input ref={searchInputRef} aria-label="搜索阅读内容" placeholder="搜索标题、正文或作者…" value={query} onChange={event=>setQuery(event.target.value)}/><button aria-label="关闭搜索" onClick={dismissSearch}><X size={13}/></button></label>:<button ref={searchButtonRef} aria-label="搜索阅读内容" title="阅读内搜索 (/)" aria-expanded={searchOpen} onClick={()=>setSearchOpen(!searchOpen)}><Search size={15}/></button>}
        {!runtimeCapabilities.mobile&&<div className="collection-menu-wrap"><button className={`collection-sync-trigger${syncMenu||syncOverview==="source"?" active":""}`} aria-label="来源同步与连接" title="来源同步与连接" aria-haspopup="dialog" aria-expanded={syncMenu||syncOverview==="source"} aria-busy={jobRunning} onClick={()=>{if(syncMenu)setSyncMenu(false);else setSyncOverview("source");}}>{jobRunning?<LoaderCircle size={16} strokeWidth={1.8} className="spin"/>:<RefreshCw size={16} strokeWidth={1.8}/>} {jobVisible&&!jobRunning&&<span className="collection-sync-indicator"/>}</button>
          {syncMenu&&<CollectionSyncPanel sources={sources} operations={operations} itemTitles={Object.fromEntries((page?.items||[]).map(item=>[item.key,title(item)]))}
            autoSyncMinutes={storage.config.autoSyncMinutes} storageLabel={`${storage.config.mode==="obsidian"?"保存到 Obsidian · 本机保留索引与缓存":"保存到本地数据库"} · Telegram 大附件可通过 tdl 下载`} storageStatus={storage.status} pendingCancellations={page?.pendingCancellations||0}
            job={job} jobRunning={jobRunning} jobVisible={jobVisible} sourceBusy={sourceConnectionRunning} sourceActive={sourceActive}
            onClose={()=>setSyncMenu(false)} onSettings={()=>{setDraft(storage.config);setSyncMenu(false);setError("");setSettings(true);}} onSync={(source,restart)=>void sync(source,restart)} onPause={()=>void pause()} onStore={()=>{setSyncMenu(false);void store(false);}}
            onConnect={source=>{setConnectionSource(source);setSyncMenu(false);setError("");setConnecting(true);}} onOpenUrl={url=>void open(url)} onDidaLogin={()=>invoke("open_dida_attachment_login")} onReview={openReview}
            onRetry={op=>void invoke("retry_collection_library_operation",{key:op.key,expectedTarget:op.target}).then(()=>load()).catch(e=>setError(String(e)))} onContinueCopy={op=>void invoke("move_collection_to_library",{key:op.key,destination:op.target}).then(()=>load()).catch(e=>setError(String(e)))}>
            <TelegramTdlSettings state={storage.tdl} paired={!!sources.find(s=>s.id==="telegram")?.paired} reload={load} onError={setError}/>
          </CollectionSyncPanel>}
        </div>}
        <button aria-label="云同步状态与设置" title="云同步状态与设置" aria-haspopup="dialog" aria-expanded={syncOverview==="cloud"} onClick={()=>{setSyncMenu(false);setSyncOverview("cloud");}}><Cloud size={15}/></button>
        {shellHeader?.actions}
        {!runtimeCapabilities.mobile&&<button aria-label="切换预览侧栏" title="预览侧栏" aria-pressed={previewEnabled} onClick={()=>{if(detailOpen)closeReading();else setPreviewEnabled(!previewEnabled);}}><PanelRight size={18}/></button>}
      </div>}
    </header>
    {compactControls&&searchOpen&&<label className="collection-mobile-search"><Search size={16}/><input ref={searchInputRef} aria-label="搜索阅读内容" placeholder="搜索标题、正文或作者…" value={query} onChange={event=>setQuery(event.target.value)}/><button aria-label="关闭搜索" onClick={dismissSearch}><X size={17}/></button></label>}
    </>}
    </div>
    {detailOpen&&compactPreview&&!runtimeCapabilities.mobile&&(toggleReadingNavigation||shellHeader?.actions)&&<header className="collection-detail-desktop-header" onMouseDown={event=>{if(!(event.target as HTMLElement).closest("button, input, select, textarea, a, summary, details, [role=button]"))shellHeader?.onMouseDown(event);}}>{toggleReadingNavigation&&<button className="workspace-panel-toggle" aria-label="切换侧边栏" aria-expanded={shellHeader?.readingNavigationExpanded} onClick={toggleReadingNavigation}><PanelLeft size={18}/></button>}<span>阅读</span><div className="collection-header-tools">{shellHeader?.actions}</div></header>}
    <div className="reading-workspace-body">
    {shellHeader?.readingNavigation}
    {shellHeader?.readingNavigation && shellHeader.navigationResizer}
    <div ref={bodyRef} className={`collection-body ${showReading?"has-preview":""} ${detailOpen?"compact-preview":""}${!runtimeCapabilities.mobile&&showReading&&readingFocusMode?" reading-focus-mode":""}`} style={{"--reading-preview-width":`${resizeCleanup.current?previewWidthRef.current:effectivePreviewWidth}px`} as CSSProperties}>
      <div className="reading-browse-paper" hidden={detailOpen}>
        {!runtimeCapabilities.mobile&&<>
    <div className="task-view-toolbar collection-toolbar">
      <div className="reading-view-title"><h2>{activeTitle}</h2>{page&&<span>{hasQueryFilters ? `命中 ${page.matched.toLocaleString("en-US")} / ${sourceCount.toLocaleString("en-US")}` : page.matched.toLocaleString("en-US")}</span>}
        {isModified&&<div className="reading-view-draft"><button onClick={updateSavedView}>更新视图</button><button aria-label="还原视图" title="还原" onClick={()=>selectView(activeEntry.id)}><RotateCcw size={12}/></button></div>}
      </div>
      <div className="reading-view-configuration" title={layoutName}><CollectionViewTabs onChange={patch=>patch.layout?changeLayout(patch.layout):changeView(patch)} compact={true} onNotice={setNotice}
        advancedSort={<CollectionSort key={`${view.id}:${view.layout}`} rules={sorts} onChange={changeSorts} embedded/>}/></div>
      <div className="task-secondary-actions">
        <div className="reading-layout-segment" role="group" aria-label="阅读布局">{readingLayouts.map(({id,label,icon:Icon})=><button type="button" key={id} aria-label={label} title={label} aria-pressed={view.layout===id} onClick={()=>changeLayout(id)}><Icon size={14}/></button>)}</div>
        
        <ReadingFilterTools view={view} tags={pageState?.availableTags||[]} onChange={changeView}/>
        <ReadingSortTools rule={sorts[0]} onChange={changeSorts}/>

      </div>
    </div>
    <ReadingActiveFilters view={view} onChange={changeView} onClear={resetFilters} onClearQuery={dismissSearch}/>
    {syncOverview==="source"&&<ReadingSourceConnections sources={sources} loading={!pageState} tdlReady={!!storage.tdl?.ready}
      didaSession={didaSession} onDidaSession={setDidaSession}
      local={{...storage.localSources,path:storage.config.mode==="obsidian"?storage.config.vaultPath:"",running:checkingSources||storage.localSources?.running,
        error:storage.localSources?.error||(storage.vaultRelocation?.rootExists===false?"保存库目录已移动":"")}}
      sourceBusy={sourceConnectionRunning} sourceActive={sourceActive}
      onSync={sync} onCheckLocal={checkLocalSources} onClose={()=>setSyncOverview(null)} onNotice={setNotice}
      onDetails={()=>{setSyncOverview(null);setSyncMenu(true);}}
      onStorage={()=>{setSyncOverview(null);setDraft(storage.config);setError("");setSettings(true);}}
      onConnect={source=>{setSyncOverview(null);setError("");if(source==="dida"){if(onOpenLibrarySettings)onOpenLibrarySettings();else setSyncMenu(true);}else{setConnectionSource(source);setConnecting(true);}}}/>}
    {syncOverview==="cloud"&&<ReadingCloudOverview onClose={()=>setSyncOverview(null)} onNotice={setNotice}/>}
        </>}
      <div ref={databaseRef} data-reading-layout={view.layout} className={`collection-database density-${view.density}`} aria-hidden={detailOpen||undefined} inert={detailOpen} onScroll={e=>{if(!detailOpen)updateSession({scrollTop:e.currentTarget.scrollTop});}}>
        {!page&&<div className="collections-empty">正在读取本地阅读内容…</div>}
        {page?.items.length===0&&<div className="collections-empty"><Bookmark size={28}/><h2>{page.total?"没有符合筛选条件的内容":"把值得读的内容留在这里"}</h2><p>{page.total?"调整筛选，或搜索其他作者和正文。":"在右上角管理 X、Telegram 和滴答来源，把待读内容放在一起。"}</p>{page.total>0&&hasQueryFilters&&<button onClick={resetFilters}>清除筛选</button>}{view.source==="telegram"&&!sources.find(s=>s.id==="telegram")?.connected&&<button onClick={()=>{setConnectionSource("telegram");setError("");setConnecting(true);}}>连接 Telegram</button>}</div>}
        {view.attentionOnly&&attentionRows.length>0&&<div className="reading-triage">
          {["待你确认","后台可恢复","需重连与会话故障"].map(group=>{
            const rows=attentionRows.filter(row=>row.group===group);
            return rows.length>0&&<section key={group} aria-label={group}>
              <header><h3>{group}</h3><span>{rows.length}</span></header>
              {rows.map(row=><article key={row.key}>
                <div><strong>{row.heading}</strong><p>{row.detail}</p><button className="reading-triage-title" onClick={()=>openItem(row.item.key)}>{title(row.item)}</button></div>
                <div className="collection-attention-actions"><button onClick={row.action}>{row.label}</button></div>
              </article>)}
            </section>;
          })}
        </div>}
        {(!view.attentionOnly||!attentionRows.length)&&<>
        {runtimeCapabilities.mobile && view.layout==="list" && page?.items.map(item=>{
          const term=query.trim().toLowerCase();
          const lines=item.post.text.split(/\n+/).map(line=>line.trim()).filter(Boolean);
          const hits=term?lines.filter(line=>line.toLowerCase().includes(term)):[];
          return (hits.length?hits:[null]).map((hit,index)=><button type="button" key={JSON.stringify([item.key,index])} className={`collection-row bw-reading-row${selected?.key===item.key?" selected":""}`} aria-label={`阅读：${title(item)}`} onClick={()=>{reading.pending.current={query,context:hit||undefined,occurrence:index};openItem(item.key);}}><small>{badge(item)} · {item.post.authorName}</small><strong>{title(item)}</strong><span>{hit || lines.slice(1).join(" ") || lines[0]}</span>{hit&&<em>定位命中段落 ›</em>}</button>);
        })}
        {!runtimeCapabilities.mobile&&view.layout==="list"&&page?.items.map(item=><article key={item.key} role="button" tabIndex={0} aria-label={`阅读：${title(item)}`} data-reading-state={readingStatus(item)} className={`collection-row ${selected?.key===item.key?"selected":""}`} style={cardStyle(item)} draggable onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({itemKey:item.key,title:title(item)}));}} onClick={()=>openItem(item.key)} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==="Enter"||e.key===" ")){e.preventDefault();openItem(item.key);}}}>
          {!runtimeCapabilities.mobile&&checkItem(item)}
          {readControl(item)}<div className="collection-row-title"><strong>{title(item)}{!runtimeCapabilities.mobile&&(issues(item).length>0||Boolean(item.attentionIssues?.length))&&<i className="reading-list-warning" title="有待处理项"/>}</strong>{!runtimeCapabilities.mobile&&<p className="reading-row-excerpt">{cleanSearchSnippet(item.post.text).slice(0,200)}</p>}{runtimeCapabilities.mobile&&view.density!=="compact"&&(view.columns.author||view.columns.media)&&<small>{view.columns.author&&<span data-reading-property="author">{item.post.authorName} {item.post.authorHandle&&`@${item.post.authorHandle}`}</span>}{view.columns.media&&collectionAttachments(item.post).length>0&&<span data-reading-property="media">{view.columns.author?" · ":""}{collectionAttachments(item.post).length} 个附件</span>}</small>}{runtimeCapabilities.mobile&&<p className="mobile-reading-excerpt">{cleanSearchSnippet(item.post.text).slice(0,160)}</p>}{renderIssues(item)}</div><div className="collection-row-meta">
          {!runtimeCapabilities.mobile&&view.density!=="compact"&&view.columns.author&&<span className="reading-row-author" data-reading-property="author" title={item.post.authorName||item.post.authorHandle}>{item.post.authorName||item.post.authorHandle}</span>}
          {view.columns.source&&badge(item)}{view.columns.destination&&copyBadges(item)}
          {view.columns.published&&<time data-reading-property="published" title={date(item.post.publishedAt)}>{runtimeCapabilities.mobile?date(item.post.publishedAt):readingListDate(item.post.publishedAt)}</time>}
          {view.columns.collected&&<time data-reading-property="collected" title={"收集于 "+date(item.collectedAt)}>{runtimeCapabilities.mobile?date(item.collectedAt):readingListDate(item.collectedAt)}</time>}{view.columns.liked&&<small data-reading-property="liked">喜欢：{fields(item,"liked")}</small>}{!runtimeCapabilities.mobile&&view.columns.media&&collectionAttachments(item.post).length>0&&<small className="reading-attachment-count" title="本机附件"><Paperclip size={11}/>{downloaded(item)}/{collectionAttachments(item.post).length}</small>}{!runtimeCapabilities.mobile&&item.tags?.[0]&&<small className="reading-list-tag">{item.tags[0]}</small>}</div>
        </article>)}
        {view.layout==="table"&&!!page?.items.length&&<div className="collection-table-wrap"><table ref={tableRef} className="task-database-table" style={{width:visibleColumns.reduce((sum,c)=>sum+widths[c],0),minWidth:view.widths?0:"100%"}}><colgroup>{visibleColumns.map(c=><col key={c} style={{width:widths[c]}}/>)}</colgroup><thead><tr>{visibleColumns.map(c=><th data-column={c} key={c} className={c==="status"?"task-check-column":c==="title"?"task-title-column":undefined}><span>{tableLabels[c]}</span><CollectionColumnResize name={tableLabels[c]} column={c} width={widths[c]} min={c==="status"?44:72} onStart={()=>beginResize(c)} onChange={width=>setWidths({[c]:width})}/></th>)}</tr></thead><tbody>{page.items.map(item=><tr key={item.key} className={selected?.key===item.key?"selected":""} style={cardStyle(item)} tabIndex={0} draggable onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({itemKey:item.key,title:title(item)}));}} onClick={()=>openItem(item.key)} onKeyDown={e=>{if(e.target===e.currentTarget&&e.key==="Enter")openItem(item.key);}}><td><div className="reading-table-status">{!runtimeCapabilities.mobile&&checkItem(item)}{readControl(item)}</div></td><td><button className="collection-title-link" draggable onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({itemKey:item.key,title:title(item)}));}} onClick={()=>openItem(item.key)}>{title(item)}</button>{renderIssues(item)}</td>{(Object.keys(labels) as Column[]).filter(c=>view.columns[c]).map(c=><td key={c}>{fields(item,c)}</td>)}</tr>)}</tbody></table></div>}
        {view.layout==="board"&&<div className="collection-board" ref={boardRef}>{boardStatuses.map(status=><section key={status} data-reading-status={status} aria-label={`${boardLabels[status]}列`} className={boardDropStatus===status?"collection-board-drop-target":""}><header><strong>{boardLabels[status]}</strong><small>本页 {page?.items.filter(i=>readingStatus(i)===status).length||0}</small></header>{page?.items.filter(i=>readingStatus(i)===status).map(item=><article key={item.key} aria-label={`阅读卡片：${title(item)}`} className={`${selected?.key===item.key?"selected ":""}${boardDragKey===item.key?"collection-board-dragging":""}`} style={cardStyle(item)} draggable={false} onPointerDown={event=>beginBoardDrag(event,item)} onClickCapture={event=>{if(suppressBoardClick.current){event.preventDefault();event.stopPropagation();}}}>
          <div className="collection-board-card-heading"><button className="collection-board-title" onPointerDown={event=>event.stopPropagation()} draggable onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({itemKey:item.key,title:title(item)}));}} onClick={()=>openItem(item.key)}>{title(item)}</button><button className="collection-board-drag" aria-label={`移动阅读卡片：${title(item)}`} title="拖到另一列；方向键或 Home / End 更改状态" disabled={propertyBusy||item.lifecycle==="archived"||item.lifecycle==="deleting"} onKeyDown={event=>moveBoardWithKeyboard(event,item)}><GripVertical size={14}/></button></div>
          {view.columns.author&&<p data-reading-property="author">{item.post.authorName}</p>}{renderIssues(item)}<footer>{readControl(item)}{view.columns.source&&badge(item)}{view.columns.destination&&copyBadges(item)}{view.columns.media&&<small data-reading-property="media">{collectionAttachments(item.post).length?`${collectionAttachments(item.post).length} 个附件`:"文字"}</small>}{view.columns.published&&<small data-reading-property="published">{date(item.post.publishedAt)}</small>}{view.columns.collected&&<small data-reading-property="collected" title="创建日期">{date(item.collectedAt)}</small>}{view.columns.liked&&<small data-reading-property="liked">喜欢：{fields(item,"liked")}</small>}</footer></article>)}</section>)}</div>}
        {boardDragPreview&&<div className="collection-board-drag-preview" aria-hidden="true" style={{left:boardDragPreview.x+14,top:boardDragPreview.y+14}}>{boardDragPreview.title}</div>}
        {view.layout==="gallery"&&<div className={`collection-gallery card-size-${cards.size} ${cards.fullTitle?"full-title":""} ${cards.wrap?"wrap-properties":""} ${cards.compact&&!cards.names?"compact-properties":""} cover-${cards.coverMode}`}>{page?.items.map(item=><article key={item.key} style={cardStyle(item)} className={`collection-gallery-card ${selected?.key===item.key?"selected":""}`} role="button" tabIndex={0} aria-label={`阅读：${title(item)}`} draggable onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({itemKey:item.key,title:title(item)}));}} onClick={()=>openItem(item.key)} onKeyDown={event=>{if(event.target===event.currentTarget&&(event.key==="Enter"||event.key===" ")){event.preventDefault();openItem(item.key);}}}>
          {cards.cover && galleryCover(item)}
          <div className="collection-gallery-copy"><strong>{title(item)}</strong>{renderIssues(item)}</div>
          <div className="collection-gallery-properties">{(Object.keys(cardFields) as CardField[]).filter(field=>!cards.hidden.includes(field)).map(field=><div key={field} data-field={field} title={cardValue(item,field)}>{cards.names&&<span className="collection-property-name">{cardFields[field]}</span>}{field==="destination"?copyBadges(item):field==="status"?readControl(item):field==="source"?badge(item):<span>{cardValue(item,field)}</span>}</div>)}</div>
        </article>)}</div>}
        </>}
        {page&&page.matched>60&&<nav className="collections-pagination" aria-label="阅读分页"><button disabled={offset===0} onClick={()=>setOffset(Math.max(0,offset-60))}>上一页</button><span>{Math.floor(offset/60)+1} / {Math.ceil(page.matched/60)} · 每页 60 条</span><button disabled={offset+60>=page.matched} onClick={()=>setOffset(offset+60)}>下一页</button></nav>}
      </div>
      </div>
      {!runtimeCapabilities.mobile&&!detailOpen&&batchItems.length>=2&&<div className="reading-batch-bar" role="group" aria-label="批量阅读操作"><strong>已选 {batchItems.length} 篇</strong><button disabled={propertyBusy} onClick={()=>void applyBatch("read")}>已读</button><button disabled={propertyBusy} onClick={()=>void applyBatch("in_progress")}>进行中</button><button disabled={propertyBusy||batchItems.some(item=>item.lifecycle==="archived"||item.lifecycle==="deleting")} onClick={()=>void applyBatch("archived")}>归档</button><button aria-label="清除选择" onClick={()=>setCheckedKeys(new Set())}><X size={14}/></button></div>}
      {selected&&showReading&&<>{useSplitReading&&<div className="reading-preview-resizer" role="separator" tabIndex={compactPreview?-1:0} aria-label="调整阅读预览宽度" aria-orientation="vertical" aria-valuemin={MIN_READING_PANEL} aria-valuemax={maximumPreviewWidth} aria-valuenow={effectivePreviewWidth} title="拖动调整预览宽度；双击恢复默认" onPointerDown={resizePreview} onKeyDown={resizePreviewWithKeyboard} onDoubleClick={resetPreviewWidth}/>}<PreviewFrame className={`collection-detail${!runtimeCapabilities.mobile&&readingWideText?" preview-wide-text":""}`} label="阅读详情">
        {runtimeCapabilities.mobile?<>
        <PreviewHeading source={<>{badge(selected)}<span className="preview-path" title={selected.post.authorName}>{selected.post.authorName}{selected.post.authorHandle&&` / @${selected.post.authorHandle}`}</span></>} actions={<PreviewToolbar
          copied={previewLink.copiedKey===selected.key} onCopy={()=>previewLink.copy(selected.key,()=>selected.post.url)}
          openTitle="打开原文" openDisabled={!selected.post.url} hideOpen={selected.post.source==="dida"} onOpen={()=>void open(selected.post.url)}
        >{compactPreview&&<button ref={previewBackRef} className="collection-preview-back mobile-preview-back" aria-label="返回阅读列表" title="返回阅读列表" onClick={closeReading}><ArrowLeft size={20}/><span>返回</span></button>}<ReadingArticleTools key={selected.key} itemKey={selected.key} revision={JSON.stringify([selected.post,readingStatus(selected),selected.tags||[],selected.lifecycle])}/>{!runtimeCapabilities.mobile&&<button className="collection-refresh-content" aria-label="更新内容" title="更新内容" disabled={selected.post.source==="dida"?sourceConnectionRunning("dida"):jobRunning} onClick={()=>selected.post.source==="dida"?void sync("dida",false):selected.post.source==="telegram"?void sync("telegram",false):void refreshContent(selected.key)}><RefreshCw size={17}/></button>}<ReadingInvestigation itemKey={selected.key} title={fullTitle(selected)}/></PreviewToolbar>}><PreviewTitle agentSource={{itemKey:selected.key,title:fullTitle(selected)}} key={selected.key} text={fullTitle(selected)}>{title(selected)}</PreviewTitle></PreviewHeading>
        </>:<>
        <div className="reading-article-toolbar">
          {detailOpen&&<button ref={previewBackRef} className="collection-preview-back" aria-label="返回阅读列表" onClick={closeReading}><ArrowLeft size={14}/>{compactPreview?"返回列表":"收起阅读"}</button>}
          <span className="reading-article-source">{badge(selected)}{selected.post.authorHandle?" · @"+selected.post.authorHandle:""}</span>
          <div className="preview-actions" role="group" aria-label="预览操作">
            <PreviewTocPopover contentRef={readingContentRef} contentKey={selected.key}/>
            <button type="button" className={`preview-focus-btn${readingFocusMode?" active":""}`} aria-label={readingFocusMode?"退出专注阅读":"全宽专注阅读"} title={readingFocusMode?"退出专注阅读（Esc）":"全宽专注阅读"} aria-pressed={readingFocusMode} onClick={()=>setReadingFocusMode(v=>!v)}>{readingFocusMode?<Minimize2 size={15}/>:<Maximize2 size={15}/>}</button>
            {selected.post.source!=="dida"&&selected.post.url&&<button type="button" className="preview-copy-action" aria-label={previewLink.copiedKey===selected.key?"已复制":"复制来源链接"} title="复制来源链接" onClick={()=>void previewLink.copy(selected.key,()=>selected.post.url)}>{previewLink.copiedKey===selected.key?<Check size={15}/>:<Link2 size={15}/>}</button>}
            <ReadingInvestigation itemKey={selected.key} title={fullTitle(selected)}/>
            <ReadingArticleTools key={selected.key} ref={inspectorRef} reference needsAttention={issues(selected).length>0||Boolean(selected.attentionIssues?.length)} itemKey={selected.key} revision={JSON.stringify([selected.post,readingStatus(selected),selected.tags||[],selected.lifecycle])}/>
            <div className="reading-article-menu" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))setArticleMenu(false);}}>
              <button type="button" aria-label="归档或更多阅读操作" title="归档 / 永久删除" aria-expanded={articleMenu} onClick={()=>setArticleMenu(!articleMenu)}><MoreHorizontal size={17}/></button>
              <div className="reading-article-menu-panel" hidden={!articleMenu}>
                <button type="button" aria-pressed={readingWideText} onClick={()=>{setReadingWideText(current=>{const next=!current;try{userProfileStorage.setItem("hub.preview.wide-text.v1",String(next));}catch{}return next;});setArticleMenu(false);}}>{readingWideText?"✓ 宽松行宽":"宽松行宽"}</button>
                {selected.post.source!=="dida"&&selected.post.url&&<button aria-label="打开原文" onClick={()=>{setArticleMenu(false);void open(selected.post.url);}}>打开原文</button>}
                <button className="collection-refresh-content" aria-label="更新内容" disabled={selected.post.source==="dida"?sourceConnectionRunning("dida"):jobRunning} onClick={()=>{setArticleMenu(false);selected.post.source==="dida"?void sync("dida",false):selected.post.source==="telegram"?void sync("telegram",false):void refreshContent(selected.key);}}>更新内容</button>
                <button disabled={propertyBusy} onClick={()=>{setArticleMenu(false);void lifecycle(selected,selected.lifecycle==="archived"?"active":"archived");}}>{selected.lifecycle==="archived"?"恢复到阅读":"归档"}</button>
                <button className="reading-menu-danger" disabled={propertyBusy} onClick={()=>{setArticleMenu(false);void lifecycle(selected,"deleting");}}>永久删除</button>
              </div>
            </div>
          </div>
        </div>
        </>}
        <div ref={readingContentRef} className="preview-content collection-detail-content preview-document" key={selected.key}>{!runtimeCapabilities.mobile&&<>
          {selected.lifecycle==="archived"&&<div className="reading-context-alert"><span>已归档 · 已保存的资料库副本保持不变</span><button disabled={propertyBusy} onClick={()=>void lifecycle(selected,"active")}>恢复到阅读</button></div>}
          {selected.lifecycle!=="archived"&&issues(selected).length>0&&<div className="reading-context-alert warning"><span>{issues(selected)[0]?.detail||"这篇内容有待处理的资料库副本"}</span><button onClick={()=>openReview(selected.key,issues(selected)[0]?.target)}>查看处理记录</button></div>}
          <div className="reading-article-kicker"><strong>{readingSourceLabel(selectedSource)}</strong><span aria-hidden="true">·</span><span>约 {readingMinutes(selected.post.text)} 分钟阅读</span></div>
          <PreviewTitle agentSource={{itemKey:selected.key,title:fullTitle(selected)}} text={fullTitle(selected)}>{title(selected)}</PreviewTitle>
        </>}<dl><div><dt>作者</dt><dd>{selected.post.authorName}{selected.post.authorHandle&&` @${selected.post.authorHandle}`}</dd></div><CollectionProperties key={selected.key} status={readingStatus(selected)} tags={selected.tags||[]} options={page?.availableTags||[]} disabled={propertyBusy} reference={!runtimeCapabilities.mobile} icon={statusIcon} archived={selected.lifecycle==="archived"} allowDelete={!runtimeCapabilities.mobile} sourceActions={!runtimeCapabilities.mobile && !selected.cloudImported} onLifecycle={state=>void lifecycle(selected,state)} save={async(status,tags)=>{await saveProperties(selected,status,tags);}}/>{runtimeCapabilities.mobile?<div><dt>保存位置</dt><dd>在桌面端管理资料库副本</dd></div>:<CollectionDestination libraries={libraries} destinationId={selected.destinationId} storageLocation={selected.storageLocation} storageLocations={selected.storageLocations} defaultConfig={storage.config} operation={selected.operation} disabled={propertyBusy} onChange={id=>void move(selected,id)} onRemove={id=>void removeDestination(selected,id)} onReview={()=>openReview(selected.key,selected.operation?.target)}/>}<div><dt>{runtimeCapabilities.mobile?"发布时间":"收集时间"}</dt><dd title={"收集于 "+date(selected.collectedAt)}>{date(runtimeCapabilities.mobile?selected.post.publishedAt:selected.collectedAt)}</dd></div>{runtimeCapabilities.mobile&&<div><dt>创建日期</dt><dd>{date(selected.collectedAt)}</dd></div>}</dl><CollectionPostBody post={selected.post} itemKey={selected.key} open={open} inlineMedia={!runtimeCapabilities.mobile} savedMedia={selected.savedMedia} onInspect={()=>inspectorRef.current?.open()}/>
        {!runtimeCapabilities.mobile&&<footer className="reading-end-actions" aria-label="读完处理">
          <button type="button" aria-pressed={readingStatus(selected)==="read"} disabled={propertyBusy} onClick={()=>void saveProperties(selected,readingStatus(selected)==="read"?"unread":"read",selected.tags||[])}><Check size={14}/>{readingStatus(selected)==="read"?"已读":"标为已读"}</button>
          <span aria-hidden="true">·</span>
          <button type="button" disabled={propertyBusy} onClick={()=>void lifecycle(selected,selected.lifecycle==="archived"?"active":"archived")}><Archive size={14}/>{selected.lifecycle==="archived"?"恢复到阅读":"归档"}</button>
        </footer>}
      </div>
      {/* Reading items (provider="hub") are excluded from external-library favorites/context menus
          (ResultList.tsx:97, RecentResultList.tsx:119, SearchResultsPane.tsx:131), so snippet favorite
          is intentionally omitted here rather than creating orphaned hub entries in hub-desktop-favorites-v2. */}
      <PreviewSelectionActions
        scrollRef={readingContentRef}
        contentKey={selected.key}
        title={fullTitle(selected)}
        agentEntry={{ itemKey: selected.key, title: fullTitle(selected) }}
        onNotify={(message, tone) => {
          if (tone === "error") setError(message);
          else setNotice(message);
          publishCodexNotice(message, tone === "error" ? "error" : "success", tone === "error" ? 6000 : 2500);
        }}
        enabled={!runtimeCapabilities.mobile}
      />
      </PreviewFrame></>}
    </div>
    </div>

    {review&&<CollectionConversionPreview operation={review} busy={conversionBusy} error={conversionError} onApprove={()=>void approveConversion()} onCancel={()=>void cancelConversion()} onClose={()=>setReviewKey(null)} onAttachmentLogin={()=>void openAttachmentLogin()} onRegenerate={goal=>void regenerateConversion(goal)} onResolve={id=>void resolveConversion(id)} onResume={()=>void resumeReview()}/>}
    {deleting&&<dialog ref={deleteDialog} className="collections-dialog" onCancel={e=>{if(propertyBusy)e.preventDefault();else setDeleting(null);}} onClose={()=>setDeleting(null)}><header><h2>删除收藏</h2><button aria-label="关闭删除确认" disabled={propertyBusy} onClick={()=>setDeleting(null)}><X size={18}/></button></header><p>{deleting&&title(deleting)}</p><p>删除 Hub 中的正文，以及已关联资料库中的对应页面和附件。其他内容仍引用的附件会保留。删除后，这条内容不会因再次同步而重新导入。</p>{!!deleteFiles.length&&<details><summary>查看将清理的位置（{deleteFiles.length}）</summary><ul>{deleteFiles.map((file,i)=><li key={i}>{file}</li>)}</ul></details>}<footer><button disabled={propertyBusy} onClick={()=>setDeleting(null)}>取消</button><button disabled={propertyBusy} className="collections-primary" onClick={()=>void confirmDelete()}>删除页面和附件</button></footer></dialog>}
    <dialog ref={dialog} className="collections-dialog" onCancel={e => { if (busy) e.preventDefault(); else setConnecting(false); }} onClose={() => setConnecting(false)}>
      <header><h2>{connectionSource==="telegram"?"连接 Telegram 机器人":`连接 X ${connectionLabel}`}</h2><button type="button" disabled={busy} aria-label="关闭连接设置" onClick={() => setConnecting(false)}><X size={18} /></button></header>
      {connectionSource==="telegram"?<>
        <p>把文字、链接、图片、视频或文件发送／转发给自己的机器人，新内容会收进同一个阅读资料库。</p>
        <ol><li>在 Telegram 的 <button type="button" onClick={()=>void open("https://t.me/BotFather")}>BotFather</button> 创建专用收集机器人，取得 Token。</li><li>保存后点击“打开机器人确认”，发送开始消息，绑定你的账号。只有你发来的内容会收集。</li></ol>
        <label htmlFor="telegram-token">机器人 Token</label><input id="telegram-token" type="password" value={request} disabled={busy} onChange={e=>setRequest(e.target.value)} placeholder="填写 BotFather 提供的 Token" autoComplete="new-password" spellCheck={false}/>
        <p className="collections-note">Token 仅保存在这台设备的系统凭据库。Telegram 未接收的消息更新最多保留 24 小时，请定期运行 Hub；云端附件下载上限为 20 MB。已有 webhook 的机器人需要由原接收服务转存，Hub 会保留现有设置。</p>
      </>:<>
      <p>使用已登录浏览器中的{connectionLabel}请求。登录凭据只保存在这台设备的凭据库中。</p>
      <ol><li><button type="button" onClick={() => void open(connectionSource === "likes" ? "https://x.com/i/history/likes" : "https://x.com/i/bookmarks")}>用默认浏览器打开 X {connectionLabel}<ArrowUpRight size={14} /></button></li><li>{connectionSource === "likes" && "先切换到“喜欢”标签，"}打开开发者工具的 Network，刷新{connectionLabel}页，搜索 <code>{connectionSource === "likes" ? "Likes" : "Bookmarks"}</code>。</li><li>选择返回帖子列表的请求，右键 → Copy → Copy as cURL (bash)。请选择 <code>{connectionSource === "likes" ? "Likes" : "Bookmarks"}</code>，不要选择 ViewerBadgeCounts。</li><li>粘贴到下方保存。Hub 只解析请求，不执行命令。</li></ol>
      <label htmlFor="x-bookmark-request">{connectionLabel}请求</label>
      <textarea id="x-bookmark-request" value={request} disabled={busy} onChange={e => setRequest(e.target.value)} placeholder="在这里粘贴完整的 cURL (bash) 请求" spellCheck={false} autoComplete="off" autoCorrect="off" autoCapitalize="off" />
      <p className="collections-note">其中包含登录凭据，请勿发到聊天或公开分享。连接失效时，在这里更新请求。</p>
      </>}
      {busy&&<p className="collections-note collection-connection-status" role="status"><LoaderCircle className="spin" size={16}/>{connectionSource==="telegram"?"正在校验 Telegram 机器人连接，请稍候…":"正在保存连接，请稍候…"}</p>}
      {!busy&&connectionRunning&&<p className="collections-note collection-connection-status" role="status">{connectionSource==="telegram"?"Telegram 正在收件，本轮结束后即可保存连接。":"当前来源正在同步或保存，本轮结束后即可更新连接。"}</p>}
      {error && <p className="collections-error" role="alert">{error}</p>}
      <footer>
        {connection?.connected&&<button type="button" disabled={busy||connectionRunning} onClick={()=>void disconnect()}>断开连接</button>}
        <button type="button" className="collections-primary" disabled={!request.trim()||busy||connectionRunning} aria-busy={busy} onClick={()=>void save()}>
          {busy&&<LoaderCircle className="spin" size={15}/>}{busy?connectionSource==="telegram"?"校验并保存…":"正在保存…":"保存连接"}
        </button>
      </footer>
    </dialog>
    <dialog ref={settingsDialog} className="collections-dialog" onCancel={e => { if (savingStorage) e.preventDefault(); else setSettings(false); }} onClose={() => setSettings(false)}>
      <header><h2>保存位置与同步频率</h2><button type="button" disabled={savingStorage} aria-label="关闭保存位置设置" onClick={() => setSettings(false)}><X size={18} /></button></header>
      <p>设置新收集内容的默认保存位置。已有内容可在预览的“保存到”中添加多个资料库副本，默认本地内容保留。</p>
      <p>X 原始笔记和附件只保存在 Obsidian，Hub 保留阅读状态与引用；Obsidian 库需在本机可用。Craft、滴答的本地内容和附件由 Hub 数据目录保存。</p>
      {storageRunning&&<p className="collections-note" role="status">当前任务仍在写入，结束后可切换保存位置和附件设置；同步频率可以立即修改。</p>}
      <label className="collections-option"><input type="radio" name="collection-storage" checked={draft.mode === "database"} disabled={savingStorage||storageRunning} onChange={() => setDraft(d => ({ ...d, mode: "database" }))} />Hub 本地数据库</label>
      <label className="collections-option"><input type="radio" name="collection-storage" checked={draft.mode === "obsidian"} disabled={savingStorage||storageRunning} onChange={() => setDraft(d => ({ ...d, mode: "obsidian" }))} />Obsidian 库</label>
      {draft.mode === "obsidian" && <div className="collections-vault">
        <label htmlFor="collection-vault">Obsidian 库根目录</label>
        <div><input id="collection-vault" value={draft.vaultPath} disabled={savingStorage||storageRunning} onChange={e => setDraft(d => ({ ...d, vaultPath: e.target.value }))} placeholder="选择已有的 Obsidian 库" /><button type="button" disabled={savingStorage||storageRunning} onClick={() => void selectVault()}><FolderOpen size={16} />选择文件夹</button></div>
        {storage.config.mode==="obsidian"&&storage.config.vaultPath.trim()&&<div className="collection-vault-recovery">
          <p className="collections-note" role={storage.vaultRelocation?.rootExists===false?"status":undefined}>{storage.vaultRelocation?.rootExists===false?"原库位置不可用，已保存的内容和关联仍保留。请重新定位改名或移动后的原库。":"库改名或移动后，请重新定位原库；上方“选择文件夹”用于更换新内容的默认保存位置。"}</p>
          <button type="button" disabled={savingStorage||storageRunning} onClick={()=>void relocateVault()}><FolderOpen size={16}/>重新定位原库</button>
          {storage.vaultRelocation?.rootExists===false&&storage.vaultRelocation.candidates.length>0&&<div className="collection-vault-candidates"><p className="collections-note">找到可能的原库，请选择正确的位置：</p>{storage.vaultRelocation.candidates.map(candidate=><button type="button" key={candidate.path} title={candidate.path} disabled={savingStorage||storageRunning} onClick={()=>void relocateVault(candidate.path)}><FolderOpen size={15}/><span>{candidate.name}</span><small>{candidate.path}</small></button>)}</div>}
        </div>}
        <pre>{"X/书签/每条推文.md\nX/喜欢/每条推文.md\nTelegram/收集/每条内容.md\n99_Meta/assets/X_assets/\n99_Meta/assets/Telegram_assets/"}</pre>
        <p className="collections-note">缺少的文件夹会自动创建。本库 X、Telegram 目录中的本地素材可接入阅读；加入 Hub 资料库后还可在主界面搜索，两者引用同一份原件。重复检查、改名和重启保留已有阅读状态。本地原件与附件保持只读，附件晚到后会自动补上。Hub 导出的页面继续保留手动修改，不反向覆盖阅读正文。</p>
        <label className="collection-schedule" htmlFor="local-sources-interval">本地素材检查间隔（分钟）<input id="local-sources-interval" type="number" min="0" max="1440" value={draft.localSourcesMinutes} disabled={savingStorage} onChange={e=>setDraft(d=>({...d,localSourcesMinutes:Number(e.target.value)}))}/></label>
        <p className="collections-note">默认仅手动；填写 0 关闭定时检查，支持 5–1440 分钟。移动或新增素材后可立即检查。与下方联网同步频率分别设置；定时检查仅在 Hub 运行时执行。</p>
        <button type="button" disabled={savingStorage||checkingSources||storage.localSources?.running||storage.config.mode!=="obsidian"||draft.vaultPath!==storage.config.vaultPath} aria-busy={checkingSources||storage.localSources?.running} onClick={()=>void checkLocalSources()}>{checkingSources||storage.localSources?.running?"正在检查本地素材…":"立即检查本地素材"}</button>
        {storage.localSources?.lastCheckedAt&&<p className="collections-note" role="status">本地素材：已检查 {storage.localSources.files??0} 个文件{storage.localSources.remaining?`，还有 ${storage.localSources.remaining} 个待接入`:""}{storage.localSources.errors?`，${storage.localSources.errors} 个文件待重试`:""}{storage.localSources.error?` · ${storage.localSources.error}`:""}</p>}
      </div>}
      <label className="collections-option"><input type="checkbox" checked={draft.downloadMedia} disabled={savingStorage||storageRunning} onChange={e => setDraft(d => ({ ...d, downloadMedia: e.target.checked }))} />自动保存图片、视频与附件原件</label>
      <p className="collections-note">X 附件使用接口返回的原图与最高码率 MP4，不设本地大小上限；Telegram 超过 20 MB 的附件可在同步菜单中登录 tdl 并补取。下载失败可补写重试，正文会先保存。</p>
      <label className="collection-schedule" htmlFor="collection-interval">联网同步间隔（分钟）<input id="collection-interval" type="number" min="0" max="1440" value={draft.autoSyncMinutes} disabled={savingStorage} onChange={e => setDraft(d => ({ ...d, autoSyncMinutes: Number(e.target.value) }))} /></label>
      <p className="collections-note">默认 30 分钟；填写 0 关闭自动同步。支持 5–1440 分钟。Hub 运行时自动读取已连接的书签、喜欢和 Telegram 收件，退出应用后停止；限流时等待冷却，登录失效时提示更新连接。Telegram 账号确认期间会检查确认消息，退出应用后停止。</p>
      {error && <p className="collections-error" role="alert">{error}</p>}
      <footer><button type="button" className="collections-primary" disabled={savingStorage || (draft.mode === "obsidian" && !draft.vaultPath.trim())} onClick={() => void store(true)}>{savingStorage ? "正在保存设置…" : storageRunning?"保存同步频率":"保存设置"}</button></footer>
    </dialog>
    <TelegramTdlLogin running={!!storage.tdl?.running&&storage.tdl.phase==="qrlogin"} reload={load}/>
  </section>;
}
