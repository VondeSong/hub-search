import { BookOpenCheck, Bookmark, CalendarDays, ChevronRight, Clock3, FolderOpen, ListTodo, Search, Star, Tags } from "lucide-react";
import type { DesktopSidebarView } from "./DesktopSidebar";
import { MobileTabBar } from "./MobileTabBar";

export type MobileDestination = "search" | "browse" | "tasks" | "review";
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
  onOpenLibraries: () => void;
  onOpenSettings: () => void;
  onOpenSyncHealth: () => void;
  syncNeedsAttention: boolean;
};

export function MobileBrowse({ favoriteCount, historyCount, journalCount, tagCount, onOpen, onOpenLibraries, onOpenSettings, onOpenSyncHealth, syncNeedsAttention }: MobileBrowseProps) {
  const destinations = [
    { key: "favorites", label: "收藏", detail: "页面与片段", count: favoriteCount, icon: Star },
    { key: "collections", label: "阅读", detail: "保存的外部内容", count: null, icon: Bookmark },
    { key: "history", label: "最近浏览", detail: "继续阅读", count: historyCount, icon: Clock3 },
    { key: "journals", label: "日志", detail: "按日期浏览", count: journalCount, icon: CalendarDays },
    { key: "tags", label: "标签", detail: "按主题查找", count: tagCount, icon: Tags },
  ] as const;
  return <section className="mobile-browse-screen" aria-label="浏览">
    <header><span>浏览</span><button type="button" onClick={onOpenSettings}>设置</button></header>
    <div className="mobile-browse-scroll">
      <h1>你的内容</h1>
      <div className="mobile-browse-group">
        <button type="button" onClick={onOpenLibraries}><FolderOpen size={20} aria-hidden="true" /><span><strong>资料库</strong><small>选择搜索范围</small></span><ChevronRight size={18} aria-hidden="true" /></button>
        {destinations.map(({ key, label, detail, count, icon: Icon }) => <button type="button" key={key} onClick={() => onOpen(key)}>
          <Icon size={20} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><em>{count}</em><ChevronRight size={18} aria-hidden="true" />
        </button>)}
      </div>
      <h2>同步与数据</h2>
      <div className="mobile-browse-group">
        <button type="button" onClick={onOpenSyncHealth}><span className={`mobile-sync-dot${syncNeedsAttention ? " attention" : ""}`} aria-hidden="true" /><span><strong>同步状态</strong><small>{syncNeedsAttention ? "有事项需要查看" : "查看资料库与索引状态"}</small></span><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
  </section>;
}
