import { BookOpenCheck, Bookmark, CalendarDays, ChevronRight, Clock3, Cloud, FolderOpen, ListTodo, MessageSquare, Search, Sparkles, Star, Tags } from "lucide-react";
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
    { key: "browse", label: "浏览", icon: FolderOpen },
    { key: "agents", label: "Agents", icon: MessageSquare },
    { key: "tasks", label: "任务", icon: ListTodo },
    { key: "review", label: "复习", icon: BookOpenCheck, count: dueCount, countLabel: "今天待复习" },
  ] as const;
  return <MobileTabBar items={destinations} active={active} onSelect={(key) => onSelect(key as MobileDestination)} label="主要导航" />;
}

type MobileBrowseProps = {
  favoriteCount: number;
  historyCount: number;
  journalCount: number;
  tagCount: number;
  onOpen: (view: MobileBrowseView) => void;
  onOpenInsights?: () => void;
  onOpenLibraries: () => void;
  onOpenSettings: () => void;
  onOpenSyncHealth: () => void;
  syncNeedsAttention: boolean;
};

export function MobileBrowse({ favoriteCount, historyCount, tagCount, onOpen, onOpenInsights, onOpenLibraries, onOpenSettings, onOpenSyncHealth, syncNeedsAttention }: MobileBrowseProps) {
  const destinations = [
    { key: "journals", label: "日志", detail: "按天浏览速记", count: null, icon: CalendarDays },
    { key: "collections", label: "阅读", detail: "保存的外部内容", count: null, icon: Bookmark },
    { key: "favorites", label: "收藏", detail: "页面与片段", count: favoriteCount, icon: Star },
    { key: "history", label: "最近浏览", detail: "继续阅读", count: historyCount, icon: Clock3 },
    { key: "tags", label: "标签", detail: "按主题查找", count: tagCount, icon: Tags },
  ] as const;
  return <section className="mobile-browse-screen" aria-label="浏览">
    <header><span>浏览</span><button type="button" onClick={onOpenSettings}>设置</button></header>
    <div className="mobile-browse-scroll">
      <h1>浏览</h1><p className="mobile-browse-intro">从记录、阅读和收藏接着往下走。</p>
      <h2>你的内容</h2>
      <div className="mobile-browse-group">
        {destinations.map(({ key, label, detail, count, icon: Icon }) => <button type="button" key={key} onClick={() => onOpen(key)}>
          <Icon size={20} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><em>{count}</em><ChevronRight size={18} aria-hidden="true" />
        </button>)}
      </div>
      {onOpenInsights && <><h2>发现与回看</h2><div className="mobile-browse-group"><button type="button" onClick={onOpenInsights}><Sparkles size={20} aria-hidden="true" /><span><strong>洞察</strong><small>有依据的发现与下一步</small></span><ChevronRight size={18} aria-hidden="true" /></button></div></>}
      <h2>数据</h2>
      <div className="mobile-browse-group">
        <button type="button" onClick={onOpenLibraries}><FolderOpen size={20} aria-hidden="true" /><span><strong>资料库</strong><small>选择搜索范围</small></span><ChevronRight size={18} aria-hidden="true" /></button>
        <button type="button" onClick={onOpenSyncHealth}><span className={`mobile-sync-dot${syncNeedsAttention ? " attention" : ""}`} aria-hidden="true" /><span><strong>连接总览</strong><small>{syncNeedsAttention ? "有事项需要查看" : "内容同步与 Agents 会话分别查看"}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
  </section>;
}

export function MobileConnections({ onContent, onAgents }: { onContent: () => void; onAgents: () => void }) {
  return <section className="mobile-browse-screen" aria-label="连接总览"><div className="mobile-browse-scroll">
    <h1>连接总览</h1><p className="mobile-browse-intro">内容同步和云端对话各自连接、分别查看状态。</p>
    <h2>内容同步</h2><div className="mobile-browse-group"><button onClick={onContent}><Cloud size={20} aria-hidden="true"/><span><strong>阿里云内容同步</strong><small>速记、阅读、闪卡与上传队列</small></span><ChevronRight size={18} aria-hidden="true"/></button></div>
    <h2>云端助手</h2><div className="mobile-browse-group"><button onClick={onAgents}><MessageSquare size={20} aria-hidden="true"/><span><strong>Agents 会话</strong><small>服务连接、设备与对话状态</small></span><ChevronRight size={18} aria-hidden="true"/></button></div>
    <p className="mobile-connection-help">内容已上传不代表电脑已写入日记；Agents 连接正常也不代表内容同步已经开启。</p>
  </div></section>;
}
