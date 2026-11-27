import { Layers, Bookmark, BookOpen, Compass, SquareCheck, ChevronRight, Clock3, Cloud, FolderOpen, MessageSquare, Search, Sparkles, Star, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { todayKey } from "./ActionEvidence";
import type { QuickJournalItem } from "./JournalRecords";
import { rootResult, groupBrowseContents } from "./LibraryBrowse";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { openQuickJournalCapture } from "./QuickJournalEvents";
import type { DesktopSidebarView } from "./DesktopSidebar";
import { MobileTabBar } from "./MobileTabBar";

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
  libraries?:LibrarySummary[];
  onScope?:(id:string, folder?:string)=>void;
  onDocument?:(result:SearchResult)=>void;
  onOpenInsights?: () => void;
  onOpenLibraries: () => void;
  onOpenSettings: () => void;
  onOpenSyncHealth: () => void;
  syncNeedsAttention: boolean;
};

export function MobileBrowse({favoriteCount,historyCount,journalCount,tagCount,onOpen,onOpenInsights,onOpenLibraries,onOpenSyncHealth,syncNeedsAttention,libraries=[],onScope,onDocument}: MobileBrowseProps) {
  const [location,setLocation]=useState({id:"",folder:""});
  const [data,setData]=useState<{id:string;tree?:ReturnType<typeof groupBrowseContents>;error?:string}>({id:""});
  const [limit,setLimit]=useState(40);
  const [todayRecords,setTodayRecords]=useState<number | null>(null);
  useEffect(() => {
    let live=true;
    invoke<{items:QuickJournalItem[]}>("list_quick_journal").then(result => {
      if(live) setTodayRecords(result.items.filter(item => !item.deleted && item.record.date === todayKey()).length);
    }).catch(() => {});
    return () => {live=false;};
  }, []);
  const library=libraries.find(lib=>lib.id===location.id);
  useEffect(()=>{
    if(!location.id)return;
    let live=true;
    invoke<Parameters<typeof groupBrowseContents>[0]>("library_contents",{libraryId:location.id}).then(contents=>{
      if(live)setData({id:location.id,tree:groupBrowseContents(contents)});
    },e=>{if(live)setData({id:location.id,error:String(e)});});
    return ()=>{live=false;};
  },[location.id,library?.lastSync]);
  const tree=data.id===location.id?data.tree:undefined;
  function drill(id:string,folder="") {setLocation({id,folder});setLimit(40);}
  const docs=tree?.pages.get(location.folder)||[];
  return <section className="bw-browse" aria-label="浏览">
    <header><h2>创作与个人收集</h2><button onClick={openQuickJournalCapture}>＋ 记一条</button></header>
    <div className="bw-card"><button className="bw-row" onClick={()=>onOpen("journals")}><BookOpen/><span><b>日志 · 按天</b><small>{todayRecords !== null ? `今日已记 ${todayRecords} 条` : journalCount ? `${journalCount} 个记录日期` : "按日期查看记录"}</small></span><ChevronRight/></button>
    <button className="bw-row" onClick={()=>onOpen("collections")}><Bookmark/><span><b>阅读 · 稍后读</b><small>阅读资料与上次阅读位置</small></span><ChevronRight/></button>
    <div className="bw-three">{([[Star,"收藏",favoriteCount,"favorites"],[Clock3,"最近",historyCount,"history"],[Tags,"标签",tagCount,"tags"]] as const).map(([Icon,label,count,key])=><button key={key} onClick={()=>onOpen(key)}><Icon size={14}/> {label}<small>{count} 项</small></button>)}</div></div>
    <header><h2>我的资料库 · 结构浏览与范围 ({libraries.length})</h2><button onClick={onOpenLibraries}>选范围</button></header>
    <div className="bw-card">{!libraries.length&&<p>暂无已接入的资料库</p>}{libraries.map(lib=><div key={lib.id}><button className="bw-row" aria-expanded={lib.id===location.id} onClick={()=>drill(lib.id===location.id?"":lib.id)}><FolderOpen/><span><b>{lib.name}</b><small>{lib.documentCount} 篇文档</small></span><ChevronRight/></button>
    {lib.id===location.id&&<div className="bw-tree">{location.folder&&<button onClick={()=>drill(lib.id,tree?.parents.get(location.folder)||"")}>‹ 上一级 · {tree?.nodes.get(location.folder)?.name}</button>}
    <button onClick={()=>onScope?.(lib.id,location.folder)}>在此范围搜索</button>{data.id===lib.id&&data.error?<p role="alert">{data.error}</p>:!tree?<p>正在读取目录…</p>:<>{(tree.children.get(location.folder)||[]).map(folder=><button key={folder.id} onClick={()=>drill(lib.id,folder.id)}>📁 {folder.name} ›</button>)}{docs.slice(0,limit).map(doc=><button key={doc.nodeId||doc.id} onClick={()=>onDocument?.(rootResult(lib,doc))}>{doc.title}</button>)}{docs.length>limit&&<button onClick={()=>setLimit(n=>n+40)}>显示更多文档</button>}{!docs.length&&!tree.children.get(location.folder)?.length&&<small>此层暂无内容</small>}</>}</div>}</div>)}</div>
    <header><h2>发现与连接</h2></header><div className="bw-card"><button className="bw-row" onClick={onOpenInsights}><Sparkles/><span><b>洞察</b><small>发现与稍后再看</small></span><ChevronRight/></button><button className="bw-row" onClick={onOpenSyncHealth}><Cloud/><span><b>连接总览</b><small>{syncNeedsAttention?"有事项需要查看":"内容同步与云端助手"}</small></span><ChevronRight/></button></div>
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
