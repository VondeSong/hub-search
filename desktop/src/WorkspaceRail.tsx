import {libraryDragType} from "./AgentLibraryScope";
import { LibraryStatusIcon } from "./LibraryStatusIcon";
import { StandaloneAgentLauncher } from "./StandaloneAgentLauncher";
import { CloudAgentsLauncher } from "./CloudAgentsLauncher";
import { providerUnavailableHint } from "./ProviderLabels";
import {
  BookOpenCheck,
  Bookmark,
  CalendarDays,
  Clock3,
  FolderTree,
  ListTodo,
  Settings,
  Search,
  Star,
  Tags,
  Layers,
  PanelLeft,
  Sparkles,
} from "lucide-react";
import type { ReactNode } from "react";
import type { DesktopSidebarView } from "./DesktopSidebar";
import type { LibrarySummary } from "./SearchTypes";


type WorkspaceRailProps = {
  onTogglePanel?: () => void;
  panelExpanded?: boolean;
  activeView: DesktopSidebarView;
  spaces: LibrarySummary[];
  selectedLibraryIds: string[] | null;
  renderLibraryIcon: (space: LibrarySummary) => ReactNode;
  favoriteCount: number;
  taskOpenCount: number;
  journalCount: number;
  historyCount: number;
  tagCount: number;
  flashcardDueCount: number;
  onSelectView: (view: DesktopSidebarView) => void;
  onSelectAllLibraries: () => void;
  onSelectLibrary: (libraryId: string) => void;
  onToggleLibrary?: (libraryId: string) => void;
  onManageLibraries: () => void;
};

function providerLabel(provider: LibrarySummary["provider"]): string {
  if (provider === "obsidian") return "Obsidian";
  if (provider === "craft") return "Craft";
  if (provider === "feishu") return "飞书";
  return "滴答清单";
}

export function WorkspaceRail({
  onTogglePanel,
  panelExpanded = true,
  activeView,
  spaces,
  selectedLibraryIds,
  renderLibraryIcon,
  favoriteCount,
  taskOpenCount,
  journalCount,
  historyCount,
  tagCount,
  flashcardDueCount,
  onSelectView,
  onSelectAllLibraries,
  onSelectLibrary,
  onToggleLibrary,
  onManageLibraries,
}: WorkspaceRailProps) {
  const allSelected = selectedLibraryIds === null;
  const selectedCount = spaces.filter(space => allSelected || selectedLibraryIds?.includes(space.id)).length;
  const navigation: Array<{ view: DesktopSidebarView; label: string; icon: ReactNode; count: number }> = [
    { view: "home", label: "全部内容", icon: <Search size={17} />, count: 0 },
    { view: "libraries", label: "资料库", icon: <FolderTree size={17} />, count: 0 },
    { view: "collections", label: "阅读", icon: <Bookmark size={17} />, count: 0 },
    { view: "tasks", label: "任务", icon: <ListTodo size={17} />, count: taskOpenCount },
    { view: "journals", label: "日志", icon: <CalendarDays size={17} />, count: journalCount },
    { view: "insights", label: "洞察", icon: <Sparkles size={17} />, count: 0 },
    { view: "favorites", label: "收藏", icon: <Star size={17} />, count: favoriteCount },
    { view: "history", label: "最近浏览", icon: <Clock3 size={17} />, count: historyCount },
    { view: "tags", label: "标签", icon: <Tags size={17} />, count: tagCount },
    { view: "flashcards", label: "闪卡复习", icon: <BookOpenCheck size={17} />, count: flashcardDueCount },
  ];

  return (
    <nav className="workspace-rail" aria-label="全局导航" onContextMenu={(event) => event.preventDefault()}>
      {onTogglePanel && <><button
        className="workspace-panel-toggle"
        onClick={onTogglePanel}
        title={panelExpanded ? "收起模块侧栏" : "展开模块侧栏"}
        aria-label={panelExpanded ? "收起模块侧栏" : "展开模块侧栏"}
        aria-expanded={panelExpanded}
      >
        <PanelLeft size={17} />
      </button>

      <div className="workspace-rail-divider" aria-hidden="true" /></>}

      <div className="workspace-rail-navigation" aria-label="浏览视图">
        <StandaloneAgentLauncher />
        <CloudAgentsLauncher />
        {navigation.map((item) => (
          <button
            key={item.view}
            className={`workspace-rail-navigation-item${activeView === item.view ? " active" : ""}`}
            onClick={() => onSelectView(item.view)}
            title={item.count > 0 ? `${item.label} · ${item.count}` : item.label}
            aria-label={item.count > 0 ? `${item.label}，${item.count}` : item.label}
            aria-current={activeView === item.view ? "page" : undefined}
          >
            {item.icon}
          </button>
        ))}
      </div>

      <div className="workspace-rail-spacer" aria-hidden="true" />
      <div className="workspace-rail-divider workspace-rail-library-divider" aria-hidden="true" />


      <div className="workspace-rail-libraries" aria-label={activeView === "flashcards" ? "来源资料库（闪卡使用独立牌库）" : "来源资料库"}>
        <button draggable={activeView !== "flashcards"} onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData(libraryDragType,JSON.stringify(spaces.map(({id,name})=>({id,name}))));}} className={`workspace-library-all${allSelected && activeView !== "flashcards" ? " active" : ""}`} disabled={activeView === "flashcards"} aria-label="全部资料库" title={activeView === "flashcards" ? "闪卡使用独立牌库" : `当前${allSelected ? "全部" : `已选 ${selectedCount} 个`}资料库 · 点击恢复全部`} aria-pressed={allSelected && activeView !== "flashcards"} onClick={onSelectAllLibraries}><Layers size={17} />{!allSelected && activeView !== "flashcards" && <span className="workspace-library-count">{selectedCount}</span>}</button>
        {spaces.map((space) => {
          const active = activeView !== "flashcards" && !allSelected && selectedLibraryIds?.includes(space.id);
          const documentCount = space.documentCount ?? 0;
          const label = `${space.name} · ${providerLabel(space.provider)} · ${documentCount} 篇${space.connected ? "" : ` · ${providerUnavailableHint(space.provider)}`}`;
          return (
            <button
              key={space.id}
              draggable={activeView !== "flashcards"}
              onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData(libraryDragType,JSON.stringify([{id:space.id,name:space.name}]));}}
              className={`workspace-rail-library provider-${space.provider}${active ? " active" : ""}`}
              onClick={event => { if (onToggleLibrary && (event.ctrlKey || event.metaKey)) onToggleLibrary(space.id); else onSelectLibrary(space.id); }}
              disabled={activeView === "flashcards"}
              title={activeView === "flashcards" ? `${label} · 闪卡使用独立牌库` : `${label}\n点击单独查看 · Ctrl / ⌘ 点击多选`}
              aria-label={label}
              aria-pressed={active}
            >
              <span className="workspace-rail-library-icon"><LibraryStatusIcon space={space}>{renderLibraryIcon(space)}</LibraryStatusIcon></span>
            </button>
          );
        })}
      </div>
      <span className="workspace-library-status" role="status">{activeView === "flashcards" ? "闪卡使用独立牌库" : allSelected ? "范围：全部资料库" : `范围：已选 ${selectedCount} 个资料库`}</span>

      <button
        className="workspace-rail-settings"
        onClick={onManageLibraries}
        title="设置"
        aria-label="设置"
      >
        <Settings size={17} />
      </button>
    </nav>
  );
}
