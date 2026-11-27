import { AgentCitationBody } from "./StandaloneAgentLauncher";
import type { ComponentProps, ComponentType, CSSProperties, ReactNode } from "react";
import type { AppEntryProps } from "./AppEntryTypes";
import { DesktopAppEntry } from "./DesktopAppEntry";
import { DesktopSidebar } from "./DesktopSidebar";
import { CollectionNavigation } from "./CollectionNavigation";
import { FilterBar, SearchFilterSummary } from "./FilterBar";
import { FooterStatus } from "./FooterStatus";
import { MobileAppEntry } from "./MobileAppEntry";
import { SearchHeader } from "./SearchHeader";
import { activeDesktopTopicCatalog, DesktopWorkspace, MobileWorkspace, type WorkspaceProps } from "./Workspace";
import { WorkspaceChrome, WorkspaceHeaderContext, WorkspaceModeControl } from "./WorkspaceChrome";
import { useSidebarLayout } from "./useSidebarLayout";
import { PanelRight } from "lucide-react";
import "./SearchToolbar.css";
import { SearchFilterReveal } from "./SearchFilterReveal";
import { MobileSearchControls, MobileSearchFilterForm } from "./MobileSearchControls";
import { MobileFilterSheet } from "./MobileFilterSheet";
import { MobileCollectionSearch, type MobileCollectionSearchProps } from "./MobileCollectionSearch";

export type AppLayoutProps = {
  filtersOpen: boolean;
  mobilePreviewOpen: boolean;
  style: CSSProperties;
  startWindowDrag: ComponentProps<typeof SearchHeader>["startWindowDrag"];
  headerProps: ComponentProps<typeof SearchHeader>;
  filterBarProps: ComponentProps<typeof FilterBar>;
  workspaceProps: WorkspaceProps;
  footerStatusProps: ComponentProps<typeof FooterStatus>;
  settingsDialog: ReactNode;
  mainContent?: ReactNode;
  mobileHeader?: ReactNode;
  mobileOverview?: ReactNode;
  mobileCollectionSearch?: MobileCollectionSearchProps;
  onSelectMobileLibraries?: (ids: string[] | null) => void;
  desktopSidebarProps?: ComponentProps<typeof DesktopSidebar>;
};

type AppLayoutContentProps = AppLayoutProps & {
  AppEntry: ComponentType<AppEntryProps>;
  Workspace: ComponentType<WorkspaceProps>;
  mobile?: boolean;
};

function AppLayoutContent({
  filtersOpen,
  mobilePreviewOpen,
  style,
  startWindowDrag,
  headerProps,
  filterBarProps,
  workspaceProps,
  footerStatusProps,
  settingsDialog,
  mainContent,
  mobileHeader,
  mobileOverview,
  mobileCollectionSearch,
  onSelectMobileLibraries,
  AppEntry,
  Workspace,
  mobile = false,
}: AppLayoutContentProps) {
  return (
    <AppEntry filtersOpen={filtersOpen} previewOpen={mobilePreviewOpen} style={style}>
      <div className="drag-strip" onMouseDown={startWindowDrag} />
      {mainContent ? <>{mobile && mobileHeader}<div className="main-content-override">{mainContent}</div><FooterStatus {...footerStatusProps} /></> : <>
        {mobile ? <div className="mobile-top-area">{mobileHeader}{mobileCollectionSearch ? <MobileCollectionSearch {...mobileCollectionSearch}/> : <SearchHeader {...headerProps} />}{!workspaceProps.resultsPaneProps.collectionView && <MobileSearchControls results={headerProps.query.trim() && workspaceProps.resultsPaneProps.contextReady ? workspaceProps.resultsPaneProps.results : undefined} filters={filterBarProps} onSelectLibraries={onSelectMobileLibraries} onOpenFilters={()=>headerProps.setFiltersOpen(true)} />}{mobileOverview}</div> : <SearchHeader {...headerProps} />}
        {mobile ? <MobileFilterSheet open={filtersOpen} onClose={() => headerProps.setFiltersOpen(false)} draft>{filtersOpen && <MobileSearchFilterForm filters={filterBarProps} onSelectLibraries={onSelectMobileLibraries} onApply={() => headerProps.setFiltersOpen(false)} />}</MobileFilterSheet> : filtersOpen && <FilterBar {...filterBarProps} />}
        <Workspace {...workspaceProps} />
        <FooterStatus {...footerStatusProps} />
      </>}
      {settingsDialog}
    </AppEntry>
  );
}

export function DesktopAppLayout(props: AppLayoutProps) {
  const {
    mode: sidebarMode, drawerOpen, togglePanel, panelExpanded, collapsePanel,
    readingPanelExpanded, toggleReadingPanel,
    sidebarWidth, sidebarWidthMin, sidebarWidthMax, resizeSidebar, resizeSidebarWithKeyboard, resetSidebarWidth,
  } = useSidebarLayout(props.desktopSidebarProps?.activeView);
  if (props.desktopSidebarProps) {
    const {
      filtersOpen, mobilePreviewOpen, style, startWindowDrag, headerProps,
      filterBarProps, workspaceProps, footerStatusProps, settingsDialog, mainContent, desktopSidebarProps,
    } = props;
    const insightsLayout = desktopSidebarProps.activeView === "insights";
    const journalLayout = desktopSidebarProps.activeView === "journals" && !headerProps.query.trim();
    const librariesLayout = Boolean(mainContent) && desktopSidebarProps.activeView === "libraries";
    const readingLayout = Boolean(mainContent) && desktopSidebarProps.activeView === "collections";
    const integratedHeader = Boolean(mainContent) && (readingLayout || insightsLayout || librariesLayout);
    return (
      <DesktopAppEntry filtersOpen={filtersOpen} previewOpen={mobilePreviewOpen} style={{ ...style, "--context-sidebar-width": `${sidebarWidth}px` } as CSSProperties} sidebarEnabled sidebarMode={drawerOpen ? "standard" : sidebarMode} workspaceView={desktopSidebarProps.activeView} sidebarDrawerOpen={drawerOpen}>
        <div className="drag-strip" onMouseDown={startWindowDrag} />
        <DesktopSidebar {...desktopSidebarProps} hideJournalNavigation={journalLayout} hideTagNavigation={!mainContent && Boolean(activeDesktopTopicCatalog(workspaceProps))} onCollapse={collapsePanel} />
        <div
          className="context-sidebar-resizer"
          role="separator"
          aria-label="调整中间栏宽度"
          aria-orientation="vertical"
          aria-valuemin={sidebarWidthMin}
          aria-valuemax={sidebarWidthMax}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          title="拖动调整中间栏宽度；双击恢复默认"
          onPointerDown={resizeSidebar}
          onDoubleClick={resetSidebarWidth}
          onKeyDown={resizeSidebarWithKeyboard}
        />
        <div className={`desktop-main-layout ${filtersOpen ? "filters-open" : ""}`}>
          <AgentCitationBody/>
          {!integratedHeader && !journalLayout && <WorkspaceChrome search={!mainContent && <SearchHeader {...headerProps} hideLibrarySwitcher hidePreviewToggle />} actions={!mainContent && <button className={`workspace-preview-toggle ${headerProps.showPreviewPane ? "active" : ""}`} aria-label="显示预览窗格" title="显示预览窗格" aria-pressed={headerProps.showPreviewPane} onClick={() => headerProps.setPreviewOpen(value => !value)}><PanelRight size={17} /></button>} onTogglePanel={togglePanel} panelExpanded={panelExpanded} view={desktopSidebarProps.activeView} spaces={desktopSidebarProps.spaces} selectedLibraryIds={desktopSidebarProps.selectedLibraryIds} onToggleLibrary={desktopSidebarProps.onToggleLibrary} onSelectAll={desktopSidebarProps.onSelectAllLibrariesOnly ?? desktopSidebarProps.onToggleAllLibraries} onManage={desktopSidebarProps.onManageLibraries} />}
          {mainContent ? <><div className="main-content-override"><WorkspaceHeaderContext.Provider value={integratedHeader ? {
            actions: <WorkspaceModeControl expanded={panelExpanded} onToggle={togglePanel} />,
            onMouseDown: startWindowDrag,
            readingNavigation: readingLayout && readingPanelExpanded ? <aside className="reading-context-navigation" id="reading-context-navigation"><CollectionNavigation libraries={desktopSidebarProps.spaces} /></aside> : undefined,
            onToggleReadingNavigation: readingLayout ? toggleReadingPanel : undefined,
            readingNavigationExpanded: readingLayout ? readingPanelExpanded : undefined,
            navigationResizer: librariesLayout || (readingLayout && readingPanelExpanded && panelExpanded) ? <div className="context-sidebar-resizer" role="separator"
              aria-label={readingLayout ? "调整阅读导航宽度" : "调整资料库导航宽度"} aria-orientation="vertical" tabIndex={0}
              aria-valuemin={sidebarWidthMin} aria-valuemax={sidebarWidthMax} aria-valuenow={sidebarWidth}
              title={readingLayout ? "拖动调整阅读导航宽度；双击恢复默认" : "拖动调整资料库导航宽度；双击恢复默认"}
              onPointerDown={resizeSidebar} onDoubleClick={resetSidebarWidth} onKeyDown={resizeSidebarWithKeyboard} /> : undefined,
          } : null}>{mainContent}</WorkspaceHeaderContext.Provider></div><FooterStatus {...footerStatusProps} /></> : <>
            {!journalLayout&&<SearchFilterReveal open={filtersOpen}><FilterBar {...filterBarProps} visible={filtersOpen} /></SearchFilterReveal>}
            {(!journalLayout&&(desktopSidebarProps.activeView === "home" || headerProps.query.trim())) && <SearchFilterSummary {...filterBarProps} />}
            <WorkspaceHeaderContext.Provider value={journalLayout?{actions:<><WorkspaceModeControl expanded={panelExpanded} onToggle={togglePanel}/><button className={`workspace-preview-toggle ${headerProps.showPreviewPane ? "active" : ""}`} aria-label="显示预览窗格" aria-pressed={headerProps.showPreviewPane} onClick={()=>headerProps.setPreviewOpen(value=>!value)}><PanelRight size={17}/></button></>,onMouseDown:startWindowDrag,
              journalNavigation:{dates:desktopSidebarProps.journalDates,onSelectDate:desktopSidebarProps.onSelectJournalDate},
            }:null}><DesktopWorkspace {...workspaceProps}/></WorkspaceHeaderContext.Provider>
            <FooterStatus {...footerStatusProps} />
          </>}
        </div>
        {settingsDialog}
      </DesktopAppEntry>
    );
  }
  return <AppLayoutContent {...props} AppEntry={DesktopAppEntry} Workspace={DesktopWorkspace} />;
}

export function MobileAppLayout(props: AppLayoutProps) {
  return <AppLayoutContent {...props} AppEntry={MobileAppEntry} Workspace={MobileWorkspace} mobile />;
}
