import { userProfileStorage } from "./UserProfileStorage";
import { createContext, type MouseEventHandler, type ReactNode } from "react";
import { Columns3, PanelLeft, Square } from "lucide-react";
import type { LibrarySummary } from "./SearchTypes";
import type { DesktopSidebarView } from "./DesktopSidebar";

export type SidebarMode = "standard" | "compact" | "focus";
export const workspaceLabels: Record<DesktopSidebarView, string> = {
  home: "全部内容", tasks: "任务", journals: "日志", favorites: "收藏",
  history: "最近浏览", tags: "标签", flashcards: "闪卡复习",
  collections: "阅读",
};
export function loadSidebarMode(): SidebarMode {
  try { const value = userProfileStorage.getItem("hub.sidebar.mode"); return value === "standard" || value === "focus" ? value : "compact"; }
  catch { return "compact"; }
}

export function WorkspaceChrome({ mode, onModeChange, actions, search, view }: {
  search?: ReactNode;
  actions?: ReactNode;
  onTogglePanel?: () => void; panelExpanded?: boolean;
  mode: SidebarMode; onModeChange: (mode: SidebarMode) => void; view: DesktopSidebarView;
  spaces: LibrarySummary[]; selectedLibraryIds: string[] | null;
  onToggleLibrary: (id: string) => void; onSelectAll: () => void; onManage: () => void;
}) {
  return <header className="workspace-chrome">
    {search && <div className="workspace-top-search">{search}</div>}
    <div className="workspace-chrome-actions">{view === "flashcards" && <span id="flashcards-chrome-actions" />}<WorkspaceModeControl mode={mode} onModeChange={onModeChange} />{actions}</div>
  </header>;
}

// Modules with their own header can host the same shell controls in that row.
export const WorkspaceHeaderContext = createContext<{
  actions: ReactNode;
  onMouseDown: MouseEventHandler<HTMLElement>;
} | null>(null);

export function WorkspaceModeControl({ mode, onModeChange }: {
  mode: SidebarMode; onModeChange: (mode: SidebarMode) => void;
}) {
  const nextMode: SidebarMode = mode === "focus" ? "compact" : mode === "compact" ? "standard" : "focus";
  const labels = { focus: "专注", compact: "紧凑", standard: "标准" };
  const ModeIcon = mode === "focus" ? Square : mode === "compact" ? Columns3 : PanelLeft;
  const modeLabel = `当前布局：${labels[mode]}；点击切换为${labels[nextMode]}`;
  return <button className="workspace-mode-cycle" title={modeLabel} aria-label={modeLabel} onClick={() => onModeChange(nextMode)}><ModeIcon size={17} /></button>;
}
