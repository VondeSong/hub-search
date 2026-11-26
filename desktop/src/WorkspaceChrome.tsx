import { userProfileStorage } from "./UserProfileStorage";
import { createContext, type MouseEventHandler, type ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import type { LibrarySummary } from "./SearchTypes";
import type { DesktopSidebarView } from "./DesktopSidebar";

export type SidebarMode = "standard" | "focus";
export function loadSidebarMode(): SidebarMode {
  try { return userProfileStorage.getItem("hub.sidebar.mode") === "focus" ? "focus" : "standard"; }
  catch { return "standard"; }
}

export function WorkspaceChrome({ onTogglePanel, panelExpanded, actions, search, view }: {
  search?: ReactNode;
  actions?: ReactNode;
  onTogglePanel: () => void; panelExpanded: boolean;
  view: DesktopSidebarView;
  spaces: LibrarySummary[]; selectedLibraryIds: string[] | null;
  onToggleLibrary: (id: string) => void; onSelectAll: () => void; onManage: () => void;
}) {
  return <header className="workspace-chrome">
    {search && <div className="workspace-top-search">{search}</div>}
    <div className="workspace-chrome-actions">{view === "flashcards" && <span id="flashcards-chrome-actions" />}<WorkspaceModeControl expanded={panelExpanded} onToggle={onTogglePanel} />{actions}</div>
  </header>;
}

// Modules with their own header can host the same shell controls in that row.
export const WorkspaceHeaderContext = createContext<{
  actions: ReactNode;
  onMouseDown: MouseEventHandler<HTMLElement>;
  navigationResizer?: ReactNode;
  readingNavigation?: ReactNode;
  onToggleReadingNavigation?: () => void;
  readingNavigationExpanded?: boolean;
  journalNavigation?: { dates: Array<{date: string; sources: number}>; onSelectDate: (date: string) => void };
} | null>(null);

export function WorkspaceModeControl({ expanded, onToggle }: {
  expanded: boolean; onToggle: () => void;
}) {
  const label = expanded ? "收起全局侧边栏" : "展开全局侧边栏";
  return <button type="button" className="workspace-mode-cycle" title={label} aria-label={label} aria-expanded={expanded} onClick={onToggle}><PanelLeft size={17} aria-hidden="true" /></button>;
}
