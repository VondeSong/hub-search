import type { AppEntryProps } from "./AppEntryTypes";

export function DesktopAppEntry({ children, filtersOpen, style, sidebarEnabled, sidebarMode, workspaceView, sidebarDrawerOpen }: AppEntryProps) {
  return (
    <main className={`app-shell desktop-app-shell ${filtersOpen ? "filters-open" : ""} ${sidebarEnabled ? "sidebar-enabled" : ""} ${sidebarMode ? `unified-shell mode-${sidebarMode} module-${workspaceView}` : ""} ${sidebarDrawerOpen ? "module-drawer-open" : ""}`} style={style}>
      {children}
    </main>
  );
}
