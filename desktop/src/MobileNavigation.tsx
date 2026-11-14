import { BookOpenCheck, Bookmark, CalendarDays, ChevronRight, Clock3, Cloud, FolderOpen, ListTodo, Search, Star, Tags } from "lucide-react";
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
  onOpenAgents?: () => void;
  onOpenLibraries: () => void;
  onOpenSettings: () => void;
  onOpenSyncHealth: () => void;
  syncNeedsAttention: boolean;
};

export function MobileBrowse({ favoriteCount, historyCount, tagCount, onOpen, onOpenAgents, onOpenLibraries, onOpenSettings, onOpenSyncHealth, syncNeedsAttention }: MobileBrowseProps) {
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
      <div className="mobile-browse-group">
        {destinations.map(({ key, label, detail, count, icon: Icon }) => <button type="button" key={key} onClick={() => onOpen(key)}>
          <Icon size={20} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><em>{count}</em><ChevronRight size={18} aria-hidden="true" />
        </button>)}
      </div>
      {onOpenAgents && <div className="mobile-browse-group"><button type="button" onClick={onOpenAgents}><Cloud size={20} aria-hidden="true" /><span><strong>Agents</strong><small>继续云端对话</small></span><ChevronRight size={18} aria-hidden="true" /></button></div>}
      <h2>同步与数据</h2>
      <div className="mobile-browse-group">
        <button type="button" onClick={onOpenLibraries}><FolderOpen size={20} aria-hidden="true" /><span><strong>资料库</strong><small>选择搜索范围</small></span><ChevronRight size={18} aria-hidden="true" /></button>
        <button type="button" onClick={onOpenSyncHealth}><span className={`mobile-sync-dot${syncNeedsAttention ? " attention" : ""}`} aria-hidden="true" /><span><strong>同步状态</strong><small>{syncNeedsAttention ? "有事项需要查看" : "查看资料库与索引状态"}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
  </section>;
}
