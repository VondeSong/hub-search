import { Layers, Bookmark, BookOpen, ChevronDown, Compass, SquareCheck, ChevronRight, Clock3, Cloud, FolderOpen, MessageSquare, Search, Sparkles, Star, Tags } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { todayKey } from "./ActionEvidence";
import type { QuickJournalItem } from "./JournalRecords";
import { rootResult, groupBrowseContents } from "./LibraryBrowse";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { QUICK_JOURNAL_UPDATED, openQuickJournalCapture } from "./QuickJournalEvents";
import type { DesktopSidebarView } from "./DesktopSidebar";
import type { MobileLinkStatus } from "./MobileHeader";
import { getLatestMobileConnectionSnapshot, subscribeMobileConnectionSnapshot, type QuickJournalReceiptSummary } from "./MobileConnectionSheet";
import { MobileTabBar } from "./MobileTabBar";

const providerBadge = (provider: string, name: string): { glyph: string; tone: string } => {
  switch (provider) {
    case "craft": return { glyph: "C", tone: "craft" };
    case "obsidian": return { glyph: "O", tone: "obsidian" };
    case "feishu": return { glyph: "飞", tone: "feishu" };
    case "dida365": return { glyph: "✓", tone: "dida" };
    case "x": return { glyph: "X", tone: "x" };
    case "telegram": return { glyph: "TG", tone: "telegram" };
    default: return { glyph: (name.trim()[0] || "库").toUpperCase(), tone: "default" };
  }
};

export type MobileDestination = "search" | "browse" | "tasks" | "review" | "agents";
export type MobileBrowseView = Extract<DesktopSidebarView, "favorites" | "history" | "journals" | "tags" | "collections">;

type MobileNavigationProps = {
  active: MobileDestination;
  onSelect: (destination: MobileDestination) => void;
  dueCount: number;
};

export function MobileNavigation({ active, onSelect, dueCount }: MobileNavigationProps) {
  const destinations = [
    { key: "search", label: "搜索", icon: Search },
    { key: "browse", label: "浏览", icon: Compass },
    { key: "agents", label: "助手", icon: Sparkles },
    { key: "tasks", label: "任务", icon: SquareCheck },
    { key: "review", label: "复习", icon: Layers, count: dueCount, countLabel: "今天待复习" },
  ] as const;
  return <MobileTabBar items={destinations} active={active} onSelect={(key) => onSelect(key as MobileDestination)} label="主要导航" />;
}

type MobileBrowseProps = {
  favoriteCount: number;
  historyCount: number;
  journalCount: number;
  tagCount: number;
  onOpen: (view: MobileBrowseView) => void;
  libraries?: LibrarySummary[];
  selectedLibraryIds?: string[] | null;
  hasActiveFolder?: boolean;
  scopeLabel?: string;
  linkStatus?: MobileLinkStatus;
  onScope?: (id: string, folder?: string) => void;
  onDocument?: (result: SearchResult) => void;
  onOpenInsights?: () => void;
  onOpenLibraries: () => void;
  onOpenSettings: () => void;
  onOpenSyncHealth: () => void;
  syncNeedsAttention: boolean;
};

export function MobileBrowse({
  favoriteCount,
  historyCount,
  journalCount,
  tagCount,
  onOpen,
  onOpenInsights,
  onOpenLibraries,
  onOpenSyncHealth,
  syncNeedsAttention,
  libraries = [],
  selectedLibraryIds = null,
  hasActiveFolder = false,
  scopeLabel,
  linkStatus,
  onScope,
  onDocument,
}: MobileBrowseProps) {
  const readLocation = () => {
    const state=window.history.state;
    const saved=state?.hubMobileRoute==="browse" && state.hubBrowseLocation;
    return saved && typeof saved.id==="string" && typeof saved.folder==="string" ? {id:saved.id as string,folder:saved.folder as string} : {id:"",folder:""};
  };
  const [location,setLocation]=useState(readLocation);
  const locationRef = useRef(location);
  locationRef.current = location;
  const [expandedId,setExpandedId]=useState("");
  const [libFilter,setLibFilter]=useState("");
  const [trees,setTrees]=useState<Record<string,{tree?:ReturnType<typeof groupBrowseContents>;error?:string;sync?:string|null}>>({});
  const [limit,setLimit]=useState(40);
  const [journalSummary,setJournalSummary]=useState<QuickJournalReceiptSummary | null>(() => getLatestMobileConnectionSnapshot().journalSummary);
  const [attentionInsights,setAttentionInsights]=useState<string | null>(null);
  const journalEpoch = useRef(0);
  useEffect(() => {
    let live=true;
    const unsub = subscribeMobileConnectionSnapshot(snap => {
      if (live && snap.journalSummary !== null) {
        journalEpoch.current++;
        setJournalSummary(snap.journalSummary);
      }
    });
    const loadJournal = () => {
      const ticket = ++journalEpoch.current;
      invoke<{items:QuickJournalItem[]}>("list_quick_journal").then(result => {
        if(!live || journalEpoch.current !== ticket) return;
        const rows = result.items.filter(item => !item.deleted);
        const today = rows.filter(item => item.record.date === todayKey()).length;
        const applied = rows.filter(item => item.applied).length;
        const uploadedOnly = rows.filter(item => item.uploaded && !item.applied).length;
        const localOnly = rows.length - applied - uploadedOnly;
        setJournalSummary({ today, localOnly, uploadedOnly, applied });
      }).catch(() => {});
    };
    if (getLatestMobileConnectionSnapshot().journalSummary === null) loadJournal();
    window.addEventListener(QUICK_JOURNAL_UPDATED, loadJournal);
    invoke<{ items: { processingState?: string }[]; hasMore?: boolean }>("agent_investigation", { args: { action: "insightList" } })
      .then(result => {
        if (!live) return;
        const count = result.items.filter(item => item.processingState === "attention").length;
        setAttentionInsights(
          result.hasMore
            ? (count > 0 ? `至少 ${count} 条待关注 · 查看依据与关联任务` : "当前页 0 条待关注（更多待读取）")
            : `${count} 条待关注 · 查看依据与关联任务`,
        );
      })
      .catch(() => {});
    return () => {
      live=false;
      unsub();
      window.removeEventListener(QUICK_JOURNAL_UPDATED, loadJournal);
    };
  }, []);
  const activeLibId = location.id || expandedId;
  const activeLibrary = libraries.find(lib=>lib.id===activeLibId);
  useEffect(()=>{
    if(!activeLibId)return;
    let live=true;
    invoke<Parameters<typeof groupBrowseContents>[0]>("library_contents",{libraryId:activeLibId}).then(contents=>{
      if(live)setTrees(current=>({...current,[activeLibId]:{tree:groupBrowseContents(contents),sync:activeLibrary?.lastSync ?? null}}));
    },e=>{if(live)setTrees(current=>({...current,[activeLibId]:{error:String(e),sync:activeLibrary?.lastSync ?? null}}));});
    return ()=>{live=false;};
  },[activeLibId,activeLibrary?.lastSync]);
  useEffect(()=>{
    const restore=()=>{
      const next = readLocation();
      const prev = locationRef.current;
      if (next.id !== prev.id || next.folder !== prev.folder) {
        setLocation(next);
        setLibFilter("");
        setLimit(40);
      }
    };
    window.addEventListener("popstate",restore);return ()=>window.removeEventListener("popstate",restore);
  },[]);
  function drill(id:string,folder="") {
    const next={id,folder};
    if(window.history.state?.hubMobileRoute==="browse"){
      if(id) window.history.pushState({...window.history.state,hubBrowseLocation:next},"");
      else if(window.history.state?.hubBrowseLocation?.id) { window.history.back(); return; }
    }
    setLocation(next);setLibFilter("");setLimit(40);
  }
  const activeEntry = location.id ? trees[location.id] : undefined;
  const activeTree = activeEntry?.tree;
  const libraryDocuments = useMemo(() => activeTree
    ? Array.from(activeTree.pages.values()).flat().sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0))
    : [], [activeTree]);
  if (location.id) {
    const lib = libraries.find(item => item.id === location.id);
    const breadcrumbs: { id: string; name: string }[] = [];
    let cursor = location.folder;
    while (cursor && activeTree?.nodes.get(cursor)) {
      breadcrumbs.unshift({ id: cursor, name: activeTree.nodes.get(cursor)!.name });
      cursor = activeTree.parents.get(cursor) || "";
    }
    const q = libFilter.trim().toLowerCase();
    const rawFolders = activeTree?.children.get(location.folder) || [];
    const rawDocs = location.folder ? activeTree?.pages.get(location.folder) || [] : libraryDocuments;
    const folders = q ? rawFolders.filter(folder => folder.name.toLowerCase().includes(q)) : rawFolders;
    const docs = q ? rawDocs.filter(doc => doc.title.toLowerCase().includes(q)) : rawDocs;
    const header = document.querySelector(".mobile-hub-header");
    const subhead = (
      <div className="bw-task-subhead">
        <button type="button" aria-label={location.folder ? "返回上一级" : "返回浏览"} onClick={() => window.history.state?.hubBrowseLocation?.id ? window.history.back() : setLocation({ id: "", folder: "" })}>‹ 返回</button>
        <strong>{lib?.name || "资料库"}</strong>
        <span className="bw-subhead-actions">
          <button type="button" className="bw-subhead-action" onClick={() => onScope?.(location.id, location.folder)}>{location.folder ? "仅搜此夹" : "仅搜此库"}</button>
        </span>
      </div>
    );
    return (
      <section className="bw-browse bw-library-screen" aria-label={lib ? `${lib.name} 目录浏览` : "资料库浏览"}>
        {header ? createPortal(subhead, header) : subhead}
        <label className="bw-lib-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label="筛选当前目录内容"
            placeholder={`筛选「${breadcrumbs[breadcrumbs.length - 1]?.name || lib?.name || "此库"}」中的文件夹或文档…`}
            value={libFilter}
            onChange={e => setLibFilter(e.target.value)}
          />
        </label>
        <nav className="bw-breadcrumbs" aria-label="文件夹路径">
          <button type="button" aria-current={!location.folder ? "page" : undefined} onClick={() => location.folder && drill(location.id, "")}>全部目录</button>
          {(activeTree?.children.get("") ?? []).map(folder => <button key={folder.id} type="button" aria-pressed={breadcrumbs[0]?.id === folder.id} onClick={() => drill(location.id, folder.id)}>{folder.name}</button>)}
          {breadcrumbs.slice(1).map((crumb, idx) => (
            <button key={crumb.id} type="button" aria-current={idx === breadcrumbs.length - 2 ? "page" : undefined} onClick={() => idx < breadcrumbs.length - 2 && drill(location.id, crumb.id)}>
              › {crumb.name}
            </button>
          ))}
        </nav>
        <div className="bw-card bw-lib-list">
          {activeEntry?.error ? <p role="alert">{activeEntry.error}</p> : !activeTree ? <p>正在读取目录…</p> : <>
            {!!folders.length && <h2>文件夹层级 ({folders.length})</h2>}
            {folders.map(folder => (
              <button key={folder.id} type="button" className="bw-row" onClick={() => drill(location.id, folder.id)}>
                <FolderOpen /><span><b>{folder.name}</b><small>文件夹</small></span><ChevronRight />
              </button>
            ))}
            {!!docs.length && <h2>{location.folder ? "文档" : "最新同步文档"} ({docs.length})</h2>}
            {docs.slice(0, limit).map(doc => (
              <button key={doc.nodeId || doc.id} type="button" className="bw-row bw-doc-row" onClick={() => lib && onDocument?.(rootResult(lib, doc))}>
                <span><b>{doc.title}</b></span><ChevronRight />
              </button>
            ))}
            {docs.length > limit && <button type="button" className="bw-row" onClick={() => setLimit(n => n + 40)}>显示更多文档（还有 {docs.length - limit} 篇）</button>}
            {!folders.length && !docs.length && <p>{q ? "当前目录没有匹配的文件夹或文档" : "此层暂无内容"}</p>}
          </>}
        </div>
      </section>
    );
  }
  const inlineEntry = expandedId ? trees[expandedId] : undefined;
  const inlineTree = inlineEntry?.tree;
  const scopeFiltered = selectedLibraryIds !== null || hasActiveFolder;
  const receiptBadge = journalSummary
    ? journalSummary.localOnly > 0
      ? { tone: "is-local", text: `待上传 ${journalSummary.localOnly} 条` }
      : journalSummary.uploadedOnly > 0
        ? { tone: "is-cloud", text: `已上传 ${journalSummary.uploadedOnly} 条` }
        : journalSummary.applied > 0
          ? { tone: "is-os", text: "已写入 OS" }
          : null
    : null;
  const connectionSummary = linkStatus
    ? `OSS（${linkStatus.pendingUpload ? `待上传 ${linkStatus.pendingUpload} 条` : linkStatus.oss ? "已配置" : "未开启"}）· VPS（${linkStatus.vpsLabel || (linkStatus.vps ? "在线" : "未连接")}）`
    : syncNeedsAttention
      ? "有事项需要查看"
      : "内容同步与云端助手";
  return <section className="bw-browse" aria-label="浏览">
    <header><h2>创作与个人收集</h2><button onClick={openQuickJournalCapture}>＋ 记一条</button></header>
    <div className="bw-card"><button className="bw-row" onClick={()=>onOpen("journals")}><BookOpen className="bw-row-icon is-journal"/><span><b className="bw-row-title-line"><span>日志 · 按天</span>{receiptBadge && <em className={`bw-receipt-pill ${receiptBadge.tone}`}>{receiptBadge.text}</em>}</b><small>{journalSummary !== null ? `今日已记 ${journalSummary.today} 条 · 支持多段语音补录与 OS 回执` : journalCount ? `${journalCount} 个记录日期` : "按日期查看记录"}</small></span><ChevronRight/></button>
    <button className="bw-row" onClick={()=>onOpen("collections")}><Bookmark className="bw-row-icon is-reading"/><span><b>阅读 · 稍后读</b><small>阅读资料与上次阅读位置</small></span><ChevronRight/></button>
    <div className="bw-three">{([[Star,"收藏",favoriteCount,"favorites"],[Clock3,"最近",historyCount,"history"],[Tags,"标签",tagCount,"tags"]] as const).map(([Icon,label,count,key])=><button key={key} onClick={()=>onOpen(key)}><Icon size={14}/> {label}<small>{count} 项</small></button>)}</div></div>
    <header><h2>我的资料库 · 结构浏览与范围 ({libraries.length})</h2><button onClick={onOpenLibraries}>{scopeFiltered && scopeLabel ? `已筛：${scopeLabel}` : "筛选搜索范围"}</button></header>
    <div className="bw-card">{!libraries.length&&<p>暂无已接入的资料库</p>}{libraries.map(lib=>{
      const isExpanded = lib.id === expandedId;
      const isInScope = selectedLibraryIds !== null && selectedLibraryIds.includes(lib.id);
      const badge = providerBadge(lib.provider, lib.name);
      const rootFolders = isExpanded ? (inlineTree?.children.get("") || []) : [];
      const rootDocs = isExpanded ? (inlineTree?.pages.get("") || []) : [];
      return <div key={lib.id}>
        <div className="bw-lib-row-wrap">
          <button type="button" className="bw-row bw-lib-main" onClick={()=>drill(lib.id,"")}>
            <span className={`bw-lib-badge is-${badge.tone}`} aria-hidden="true">{badge.glyph}</span>
            <span>
              <b className="bw-row-title-line">
                <span>{lib.name}</span>
                {isInScope && <em className="bw-scope-tag">已选范围</em>}
              </b>
              <small>{lib.lastSync ? `已同步 · ${lib.documentCount} 篇文档` : `${lib.documentCount} 篇本地索引文档`}</small>
            </span>
          </button>
          <span className="bw-lib-count">{lib.documentCount}</span>
          <button type="button" className={`bw-lib-expand${isExpanded ? " is-open" : ""}`} aria-expanded={isExpanded} aria-label={`${isExpanded ? "收起" : "展开"} ${lib.name} 文件夹树`} onClick={() => setExpandedId(isExpanded ? "" : lib.id)}>
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>
        {isExpanded && <div className="bw-tree">
          <div className="bw-tree-bar">
            <button type="button" onClick={() => drill(lib.id, "")}>进入目录页 ›</button>
            <button type="button" onClick={() => onScope?.(lib.id, "")}>仅搜此库 →</button>
          </div>
          {inlineEntry?.error ? <p role="alert">{inlineEntry.error}</p> : !inlineTree ? <p>正在读取目录…</p> : <>
            {rootFolders.map(folder => <button type="button" key={folder.id} onClick={() => drill(lib.id, folder.id)}>📁 {folder.name} ›</button>)}
            {rootDocs.slice(0, 8).map(doc => <button type="button" key={doc.nodeId || doc.id} onClick={() => onDocument?.(rootResult(lib, doc))}>{doc.title}</button>)}
            {rootDocs.length > 8 && <button type="button" onClick={() => drill(lib.id, "")}>查看全部 {rootDocs.length} 篇文档 ›</button>}
            {!rootFolders.length && !rootDocs.length && <small>此层暂无内容</small>}
          </>}
        </div>}
      </div>;
    })}</div>
    <header><h2>发现与连接</h2></header><div className="bw-card"><button className="bw-row" onClick={onOpenInsights}><Sparkles className="bw-row-icon is-insights"/><span><b>洞察 · 发现与阶段回顾</b><small>{attentionInsights ?? "发现与稍后再看"}</small></span><ChevronRight/></button><button className="bw-row" onClick={onOpenSyncHealth}><Cloud className="bw-row-icon is-sync"/><span><b>连接总览 · 内容同步与云端助手</b><small>{connectionSummary}</small></span><ChevronRight/></button></div>
  </section>;
}

export function MobileConnections({ onContent, onAgents }: { onContent: () => void; onAgents: () => void }) {
  return <section className="mobile-browse-screen" aria-label="连接总览"><div className="mobile-browse-scroll">
    <h1>连接总览</h1><p className="mobile-browse-intro">内容同步和云端对话各自连接、分别查看状态。</p>
    <h2>内容同步</h2><div className="mobile-browse-group"><button onClick={onContent}><Cloud size={20} aria-hidden="true"/><span><strong>阿里云内容同步</strong><small>速记、阅读、闪卡与上传队列</small></span><ChevronRight size={18} aria-hidden="true"/></button></div>
    <h2>云端助手</h2><div className="mobile-browse-group"><button onClick={onAgents}><MessageSquare size={20} aria-hidden="true"/><span><strong>助手会话</strong><small>服务连接、设备与对话状态</small></span><ChevronRight size={18} aria-hidden="true"/></button></div>
    <p className="mobile-connection-help">内容已上传不代表电脑已写入日记；助手连接正常也不代表内容同步已经开启。</p>
  </div></section>;
}
