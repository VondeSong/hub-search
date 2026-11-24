import { JournalVoiceHost } from "./JournalVoice";
import { MobileJournal } from "./MobileJournal";
import { MobileHeader } from "./MobileHeader";
import { filterMobileFavorites, matchesMobileCollection } from "./MobileCollectionSearch";
import { invoke } from "@tauri-apps/api/core";
import { OPEN_QUICK_JOURNAL } from "./QuickJournalEvents";
import type { QuickJournalSaved } from "./QuickJournal";
import { AgentPanelProvider } from "./StandaloneAgentLauncher";
import { useMobileOverlayHistory } from "./useMobileOverlayHistory";
import { useAgentConditionNotices } from "./useAgentConditionNotices";
import { useMarkdownLinkOpening } from "./useMarkdownLinkOpening";
import { normalizeResults } from "./SearchResultNormalization";
import { useLibraryRegistry } from "./useLibraryRegistry";
import { useLibraryConnections } from "./useLibraryConnections";
import { useManagedLibraryOperations } from "./useManagedLibraryOperations";
import { useSearchResultData } from "./useSearchResultData";
import { useWorkspaceIndexing } from "./useWorkspaceIndexing";
import { useJournalCreation } from "./useJournalCreation";
import { useResultActions } from "./useResultActions";
import { useNavigationBadges } from "./useNavigationBadges";
import { useWindowLifecycleControls } from "./useWindowLifecycleControls";
import { useStorageMaintenance } from "./useStorageMaintenance";
import { useSavedResults } from "./useSavedResults";
import { useSearchWorkspaceState, updatedAfter } from "./useSearchWorkspaceState";
import { useSidebarTags } from "./useSidebarTags";
import { canOpenResultSource } from "./ResultOpening";
import IsolatedRuntimeProbe from "./IsolatedRuntimeProbe";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import "./App.css";
import { shortcutFromKeyboardEvent } from "./KeyboardShortcut";
import { canHandleSearchWorkspaceKeyboard, isInsideKeyboardDialog } from "./AppKeyboardScope";
import "./WorkspaceRefresh.css";
import "./InterfaceSelection.css";
import "./LiquidWorkspace.css";
import "./BaseWhiteTheme.css";
import "./DisplayPreferences.css";
import "./JournalWorkspace.css";
import "./MobileExperience.css";
import "./MobileDesign.css";
import "./MobileGlass.css";
import "./MobileNavigationDesign.css";
import "./MobilePrototype.css";
import "./MobileV13.css";
import { GlobalExclusionReviewProvider } from "./GlobalExclusionReviewReminder";
import { CollectionViewsProvider } from "./CollectionViews";
import { JournalRecordsProvider } from "./JournalRecords";
import { JournalViewsContext, useJournalViewStore } from "./JournalViews";
import { UnifiedTaskProvider, useUnifiedTasks } from "./UnifiedTaskData";
import { readAdjacentJournalPreview } from "./JournalPreviewNavigation";
import { appShellStyle } from "./AppSettings";
import { DesktopAppLayout, MobileAppLayout, type AppLayoutProps } from "./AppLayout";
import { CommandPalette } from "./CommandPalette";
import type { CommandPaletteItem, CommandPaletteMode, ShortcutHelpGroup } from "./CommandPaletteTypes";
import { CreateJournalDialog } from "./CreateJournalDialog";
import type { DesktopSidebarView, SidebarTagSummary } from "./DesktopSidebar";
import { formatFileSize } from "./FileFormatting";
import { useMobileSearch } from "./useMobileSearch";
import type { ObsidianWatchStatus } from "./IndexStatusTypes";
import { LibraryIcon } from "./LibraryIcon";
import { LibraryIconCrop } from "./LibraryIconCrop";
import { MobileBrowse, MobileConnections, MobileNavigation, type MobileBrowseView, type MobileDestination } from "./MobileNavigation";
import { providerName, providerUnavailableLabel } from "./ProviderLabels";
import { EMPTY_PREVIEW_NAVIGATION, movePreviewNavigation, pushPreviewNavigation } from "./PreviewNavigation";
import { pageFavoriteKey } from "./PageFavorites";
import { runtimeCapabilities } from "./RuntimePlatform";
import { queryTerms, resultDisplayTitle, resultSectionTitle } from "./SearchResultPresentation";
import { resultMatchTerms, searchResultSummary } from "./QuickSearchGrouping";
import { deriveSearchWorkspaceResults, findMatchingResultIndex, journalDateKey } from "./SearchWorkspacePresentation";
import { buildSearchSuggestions, searchSyntaxHints, type SearchSuggestion } from "./SearchSuggestions";
import { type SmartCollection } from "./SmartCollections";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { resolveTagColor } from "./TagProperties";
import type { SettingsContentProps } from "./SettingsContent";
import type { SettingsCategory } from "./SettingsDialog";
import type { WorkspaceProps } from "./Workspace";
import { useIndexStatus } from "./useIndexStatus";
import { useAppSettings } from "./useAppSettings";
import { TaskStatusStyleProvider } from "./TaskCompletionIcon";
import { useOperationStatus } from "./useOperationStatus";
import { useLibraryManagement } from "./LibraryManagement";
import { useExternalLinkOpener } from "./useExternalLinkOpener";
import { usePreviewController } from "./usePreviewController";
import { useResultOpener } from "./useResultOpener";
import { browseSubpage, LibraryBrowse, useLibraryBrowseNavigation } from "./LibraryBrowse";
import { PreviewPane } from "./PreviewPane";
import { journalDataVersion, useJournalData } from "./useJournalData";
const LazyPreviewRenderer = lazy(() => import("./PreviewRenderer").then((module) => ({ default: module.PreviewRenderer })));
const LazyMobileQuickCapture = lazy(() => import("./MobileQuickCapture").then(m => ({ default: m.MobileQuickCapture })));
const LazySettingsDialog = lazy(() => import("./SettingsDialog").then((module) => ({ default: module.SettingsDialog })));
const LazySettingsContent = lazy(() => import("./SettingsContent").then((module) => ({ default: module.SettingsContent })));
const LazyInsightsWorkspace = lazy(() => import("./InsightsWorkspace").then((module) => ({ default: module.InsightsWorkspace })));
const LazyTaskWorkspace = lazy(() => import("./TaskWorkspace").then((module) => ({ default: module.TaskWorkspace })));
const LazyCollectionsWorkspace = lazy(() => import("./CollectionsWorkspace").then((module) => ({ default: module.CollectionsWorkspace })));
const LazyCloudAgents = lazy(() => import("./CloudAgents"));
const LazyFlashcardsWorkspace = lazy(() => import("./FlashcardsWorkspace").then((module) => ({ default: module.FlashcardsWorkspace })));

function indexJobTypeLabel(jobType: string): string {
  const labels: Record<string, string> = {
    download_source: "下载远程内容",
    import_local_source: "导入本地内容",
    extract_source: "提取正文",
    ocr_page: "图片 / PDF OCR",
    upsert_lexical: "写入全文索引",
    delete_lexical: "清理全文索引",
    discover_sources: "发现图片和附件",
  };
  return labels[jobType] ?? jobType.replace(/_/g, " ");
}

function syncPhaseLabel(phase?: string): string {
  if (!phase) return "空闲";
  if (phase === "listing") return "枚举远端文档";
  if (phase === "fetching") return "读取变更内容";
  if (phase === "committing") return "提交本地快照";
  if (phase === "failed") return "上次同步失败";
  if (phase === "completed:full") return "完整核对完成";
  if (phase === "completed:incremental") return "轻量同步完成";
  return phase;
}

function obsidianWatchLabel(status?: ObsidianWatchStatus): string {
  if (!status) return "正在读取监听状态";
  if (!status.watching) return status.lastError ? "监听中断" : "未建立监听";
  if (status.pendingPaths) return `监听中 · 待处理 ${status.pendingPaths} 个文件`;
  if (status.lastSuccessAt) {
    const time = new Date(status.lastSuccessAt * 1000).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    return `监听中 · 最近增量 ${time}`;
  }
  if (status.lastEventAt) return "监听中 · 已收到文件变化";
  return "监听中 · 等待文件变化";
}

function AppContent() {
  useAgentConditionNotices();
  const journalViewStore = useJournalViewStore();
  const [error, setError] = useState("");
  const { appSettings, loadAppSettings, saveSettings, updatingShortcut, shortcutMessage, changeToggleShortcut, changeAutoSync, changeRecentGroupingSetting, changeCraftOpenMode } = useAppSettings(setError);
  const { operationStatus, showOperationStatus } = useOperationStatus();
  const { searchHistory, favoriteResults, viewHistory, favoriteFilter, setFavoriteFilter, filteredFavorites, snippetFavoriteIds, favoriteIds, rememberQuery, clearSearchHistory, removeSearchHistoryItem, toggleFavorite, rememberViewedResult } = useSavedResults({ searchHistoryEnabled: appSettings.searchHistoryEnabled });
  const { spaces, ready, reloadSpaces, reconcileCounts, registryError } = useLibraryRegistry();
  const { prepareResultLink, copyResultValue, revealResult, dragResult } = useResultActions({ showOperationStatus });

  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);
  const [folderMenuOpen, setFolderMenuOpen] = useState(false);
  const [dateMenuOpen, setDateMenuOpen] = useState(false);
  const [searchScopeMenuOpen, setSearchScopeMenuOpen] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<CommandPaletteMode>("commands");
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("libraries");
  const { query, setQuery, selectedLibraryIds, selectedLibraryIdSet, activeSpaces, currentSpaceIds, currentStatusSpaceArg, folders, folderId, setFolderId, dateFilter, setDateFilter, sourceFilters, setSourceFilters, searchScope, setSearchScope, desktopSidebarEnabled, changeDesktopSidebarSetting, smartCollections, currentSpaceName, selectedFolder, activeSmartCollectionId, filterSummary, activeFilterCount, effectiveSpaceIds, effectiveFolderId, toggleLibrarySelection, selectLibraries, removeLibrarySelection, selectOnlyLibrary, selectAllLibraries, toggleAllLibraries, addSmartCollection, applySmartCollectionFilters, renameSmartCollection, deleteSmartCollection } = useSearchWorkspaceState({ spaces, ready, registryAvailable: !registryError, showOperationStatus });

  const [searchFocused, setSearchFocused] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const [previewNavigation, setPreviewNavigation] = useState(EMPTY_PREVIEW_NAVIGATION);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [previewHistoryActive, setPreviewHistoryActive] = useState(false);
  const [previewFocusMode, setPreviewFocusMode] = useState(false);
  const isMobileLayout = runtimeCapabilities.mobile;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [desktopSidebarView, setDesktopSidebarView] = useState<DesktopSidebarView>("home");
  const { position: libraryPosition, setPosition: setLibraryPosition, preview: libraryPreview, setPreview: setLibraryPreview } = useLibraryBrowseNavigation();
  const [mobileBrowseOpen, setMobileBrowseOpen] = useState(false);
  const [mobileAgentsOpen, setMobileAgentsOpen] = useState(false);
  const [mobileConnectionsOpen, setMobileConnectionsOpen] = useState(false);
  const [quickCaptureOpen, setQuickCaptureOpen] = useState(false);
  const [journalTarget,setJournalTarget]=useState("");
  useEffect(() => {
    if (!runtimeCapabilities.mobile) return;
    const open = () => setQuickCaptureOpen(true);
    window.addEventListener(OPEN_QUICK_JOURNAL, open);
    return () => window.removeEventListener(OPEN_QUICK_JOURNAL, open);
  }, []);
  const [flashcardsStandaloneOpen, setFlashcardsStandaloneOpen] = useState(false);
  const [tagOverviewMode, setTagOverviewMode] = useState<"all" | "cleanup">("all");
  const [selectedJournalDate, setSelectedJournalDate] = useState("");
  const [indexDetailsOpen, setIndexDetailsOpen] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const { resultsPanePercent, setResultsPanePercent, savePreviewSplit, resetPreviewSplit, startWindowDrag, hideWindow } = useWindowLifecycleControls({ appSettings, loadAppSettings, searchInput });

  const mobileSearch = useMobileSearch({ enabled: isMobileLayout, query, setQuery, input: searchInput });
  const workspaceRef = useRef<HTMLElement>(null);
  const openExternalLink = useExternalLinkOpener({ showStatus: showOperationStatus });

  useEffect(() => {
    const openCodexSettings = () => {
      if (runtimeCapabilities.mobile) return;
      setSettingsCategory("codex");
      setShowConnection(true);
    };
    window.addEventListener("hub:open-codex-settings", openCodexSettings);
    return () => window.removeEventListener("hub:open-codex-settings", openCodexSettings);
  }, [runtimeCapabilities.mobile]);

  useEffect(() => {
    const openCloudSettings = () => {
      setSettingsCategory("cloud");
      setShowConnection(true);
    };
    window.addEventListener("hub:open-cloud-sync-settings", openCloudSettings);
    return () => window.removeEventListener("hub:open-cloud-sync-settings", openCloudSettings);
  }, []);

  const moduleQueries = useRef<Partial<Record<DesktopSidebarView, string>>>({});
  const selectDesktopSidebarView = useCallback((view: DesktopSidebarView) => {
    if (view === desktopSidebarView) return;
    moduleQueries.current[desktopSidebarView] = query;
    setPreviewHistoryActive(false);
    setQuery(moduleQueries.current[view] ?? "");
    setDesktopSidebarView(view);
    setSelectedIndex(0);
    setSpaceMenuOpen(false);
  }, [desktopSidebarView, query]);

  const openHubSearch = useCallback(() => {
    setCommandPaletteOpen(false);
    setSpaceMenuOpen(false);
    setSearchScopeMenuOpen(false);
    setFolderMenuOpen(false);
    setDateMenuOpen(false);
    setFlashcardsStandaloneOpen(false);
    selectDesktopSidebarView("home");
    setSelectedSidebarTag("");
    setSelectedJournalDate("");
    setSelectedIndex(0);
    if (spaces.length > 0) setShowConnection(false);
    window.setTimeout(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    }, 50);
  }, [spaces.length, selectDesktopSidebarView]);

  const resizePreviewPanes = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const workspace = workspaceRef.current;
    if (!workspace) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    handle.setPointerCapture?.(pointerId);
    const bounds = workspace.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const minimum = Math.min(42, Math.max(25, (320 / bounds.width) * 100));
    const clamp = (clientX: number) =>
      Math.min(100 - minimum, Math.max(minimum, ((clientX - bounds.left) / bounds.width) * 100));
    let dragged = false;
    let latest = resultsPanePercent;
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (!dragged) {
        if (Math.abs(moveEvent.clientX - startX) < 3) return;
        dragged = true;
        document.body.classList.add("resizing-panes");
      }
      latest = clamp(moveEvent.clientX);
      setResultsPanePercent(latest);
    };
    const cleanup = () => {
      document.body.classList.remove("resizing-panes");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (dragged) {
        latest = clamp(upEvent.clientX);
        setResultsPanePercent(latest);
        savePreviewSplit(latest);
      }
      cleanup();
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== pointerId) return;
      if (dragged) savePreviewSplit(latest);
      cleanup();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }, [resultsPanePercent, savePreviewSplit, setResultsPanePercent]);
  const { indexStatus, refreshStatus } = useIndexStatus(ready, currentStatusSpaceArg);
  const { storageInfo, storageMode, setStorageMode, storageCustomPath, setStorageCustomPath, changingStorage, chooseStorageFolder, applyStorageLocation, revealStorageLocation, cleaning, cleanupLocalData, retryingOcr, retryFailedOcr, retryingFailedJobs, retryFailedJobs, dismissingFailedJobs, dismissFailedJobs, restartingWatcher, restartWatcher, exportingLibraryId, exportProgress, lastExportPath, exportError, exportCraftVault, chooseExportDirectory, openExportInObsidian, openExportPath, maintenanceMessage, setMaintenanceMessage } = useStorageMaintenance({ statusSpaceId: currentStatusSpaceArg, refreshStatus, settingsOpen: showConnection });
  useEffect(() => { if (maintenanceMessage) showOperationStatus(maintenanceMessage, "success", 6000); }, [maintenanceMessage, showOperationStatus]);

  const { sidebarTags, selectedSidebarTag, setSelectedSidebarTag, selectWorkspaceTopic, tagResults, tagResultsFor, tagsLoading, dynamicFacets, favoriteSidebarTags, recentSidebarTags, sidebarTagGroups, tagProperties, selectedTagTaxonomy, tagTaxonomyRevision, tagResultContext, displayedSidebarTags, cleanupSidebarTags, selectedSidebarTagSummary, selectedSidebarTagGroup, selectedSidebarTagLibraryCount, selectedSidebarTagLastUpdated, selectedSidebarTagRelated, toggleFavoriteSidebarTag, rememberSidebarTag, createSidebarTagGroup, deleteSidebarTagGroup, assignSidebarTagToGroup, updateSidebarTagProperty, createSidebarTopic, refreshSidebarTags } = useSidebarTags({ ready, libraryCount: spaces.length, currentSpaceIds, effectiveSpaceIds, effectiveFolderId, query, dateFilter, sourceFilters, searchScope, documentCount: indexStatus?.documentCount, dynamicFacetCountsEnabled: appSettings.dynamicFacetCountsEnabled, activeView: desktopSidebarView, normalizeResults, setError });
  const libraryManagement = useLibraryManagement(ready, async () => { await reloadSpaces(); refreshSidebarTags(); });
  const { syncing, refreshIndex } = useWorkspaceIndexing({ ready, spaces, activeSpaces, selectedLibraryIds, documentCount: indexStatus?.documentCount, libraryManagement, reloadSpaces, refreshStatus, setError, showOperationStatus });
const searchUpdatedAfter = useMemo(() => updatedAfter(dateFilter), [dateFilter]);
const showingLocalSearch = useRef(false);
showingLocalSearch.current = !desktopSidebarEnabled || isMobileLayout || !!query.trim() || desktopSidebarView === "home";
const { results, searching, resultsCurrent, selectedIndex, setSelectedIndex } = useSearchResultData({
    selectionActive: showingLocalSearch.current,
    refreshRevision: tagTaxonomyRevision,
    ready,
    hasSpaces: spaces.length > 0,
    syncing,
    isComposing,
    query,
    spaceIds: effectiveSpaceIds,
    folderId: effectiveFolderId,
    updatedAfter: searchUpdatedAfter,
    sourceFilters,
    searchScope,
    recentPageLimit: appSettings.recentPageLimit,
    recentTaskLimit: appSettings.recentTaskLimit,
    normalizeResults,

    setError,
  });
  const { createJournalDate, setCreateJournalDate, creatingJournal, createSelectedJournals } = useJournalCreation({ reloadSpaces, refreshStatus, setError });
  const { mcpUrl,setMcpUrl,craftApiUrl,setCraftApiUrl,craftApiKey,setCraftApiKey,obsidianPath,setObsidianPath,connectingAction,connectionError,setConnectionError,connectionErrorProvider,setConnectionErrorProvider,feishuAppId,setFeishuAppId,feishuAppSecret,setFeishuAppSecret,feishuAuthorization,setFeishuAuthorization,selectedFeishuSpaceIds,setSelectedFeishuSpaceIds,feishuBitableUrl,setFeishuBitableUrl,feishuBitableSourceId,setFeishuBitableSourceId,connect,saveCraftApiConnection,connectDida365,connectFeishu,addSelectedFeishuSpaces,addFeishuBitable,addObsidian } = useLibraryConnections({ ready, spaces, registryError, reloadSpaces, refreshStatus, libraryManagement, selectOnlyLibrary, selectLibraries, searchInput, showOperationStatus });
  const { editingExclusions,setEditingExclusions,exclusionDraft,setExclusionDraft,savingExclusions,renamingLibraryId,setRenamingLibraryId,libraryNameDraft,setLibraryNameDraft,iconCrop,setIconCrop,relocatingLibraryId,relocateObsidian,removeSpace,editExclusions,saveExclusions,updateLibraryIcon,resetLibraryIcon,beginRenameLibrary,saveLibraryName,commitLibraryIcon } = useManagedLibraryOperations({ libraryManagement, reloadSpaces, refreshStatus, removeLibrarySelection, setConnectionError, setConnectionErrorProvider, setMaintenanceMessage });
  useEffect(() => { if (connectionError) showOperationStatus(connectionError, "error", 10000); }, [connectionError, showOperationStatus]);
  const { openFlashcards: openStandaloneFlashcards, closeFlashcards: closeStandaloneFlashcards, openPreview: openMobilePreview, closePreview: closeMobilePreview, bindRoute: bindMobileRoute, openRouteFromPreview, openRouteFromFlashcards } = useMobileOverlayHistory({
    enabled: isMobileLayout, filtersOpen, settingsOpen: showConnection, captureOpen: quickCaptureOpen, setCaptureOpen: setQuickCaptureOpen,
    setFiltersOpen, setSettingsOpen: setShowConnection, setPreviewOpen: setMobilePreviewOpen,
    setFlashcardsOpen: setFlashcardsStandaloneOpen, setSelectedTag: setSelectedSidebarTag,
    consumeSearchBack: mobileSearch.consumeBack,
  });
  const initialLibrariesPresented = useRef(false);
  useEffect(() => { if (!ready || initialLibrariesPresented.current) return; initialLibrariesPresented.current = true; setShowConnection((!isMobileLayout && spaces.length === 0) || Boolean(registryError)); }, [ready, registryError, spaces.length, isMobileLayout]);


  const { summary: journalSummary, results: journalResults, loading: journalsLoading } = useJournalData({
    enabled: ready && (desktopSidebarEnabled || isMobileLayout),
    active: false,
    spaceIds: currentSpaceIds,
    dataVersion: journalDataVersion(indexStatus, currentSpaceIds),
    selectedDate: selectedJournalDate,
    normalize: normalizeResults,
  });
  const journalDates = journalSummary.dates;
  const [mobileCollectionQueries, setMobileCollectionQueries] = useState({ favorites: "", tags: "" });
  const mobileFavorites = useMemo(() => isMobileLayout ? filterMobileFavorites(filteredFavorites, mobileCollectionQueries.favorites) : filteredFavorites, [filteredFavorites, isMobileLayout, mobileCollectionQueries.favorites]);
  const searchWorkspacePresentation = useMemo(() => deriveSearchWorkspaceResults({
    desktopSidebarEnabled,
    isMobileLayout,
    query,
    view: desktopSidebarView === "collections" || desktopSidebarView === "insights" || desktopSidebarView === "libraries" ? "home" : desktopSidebarView,
    results,
    journalResults,
    favoriteResults: mobileFavorites,
    historyResults: viewHistory,
    tagResults,
    selectedLibraryIdSet,
    selectedJournalDate,
    dateFilter,
    groupRecentByDateWhenUnlimited: appSettings.groupRecentByDateWhenUnlimited,
  }), [appSettings.groupRecentByDateWhenUnlimited, dateFilter, desktopSidebarEnabled, desktopSidebarView, mobileFavorites, isMobileLayout, journalResults, query, results, selectedJournalDate, selectedLibraryIdSet, tagResults, viewHistory]);
  const { visibleResults, groups: recentGroups, journalDayCount } = searchWorkspacePresentation;
  const selected = visibleResults[selectedIndex];
  const flashcardsActive = flashcardsStandaloneOpen || desktopSidebarView === "flashcards";
  const { flashcardDueCount, taskOpenCount, updateFlashcardDueCount, updateTaskOpenCount } = useNavigationBadges({ ready, flashcardsActive });

  const insightsActive = desktopSidebarView === "insights" && !flashcardsStandaloneOpen;
  const tasksActive = desktopSidebarView === "tasks" && !flashcardsStandaloneOpen;
  const collectionsActive = desktopSidebarView === "collections" && !flashcardsStandaloneOpen;
  const librariesActive = !isMobileLayout && desktopSidebarView === "libraries" && !flashcardsStandaloneOpen;
  const browseLibraries = spaces;
  const browsingPreview = browseLibraries.some(space => space.id === libraryPreview?.libraryId) ? libraryPreview : undefined;
  const sharedTasks = useUnifiedTasks({ enabled: ready && !flashcardsStandaloneOpen && (tasksActive || desktopSidebarView === "journals") });
  useEffect(() => { if (sharedTasks.ready && !sharedTasks.loading) updateTaskOpenCount(sharedTasks.dashboard.open); }, [sharedTasks.dashboard.open, sharedTasks.ready, sharedTasks.loading, updateTaskOpenCount]);
  const taskRegistryKey = JSON.stringify(spaces.map(space => [space.id, space.name, space.provider, space.connected]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  const taskRegistryVersion = useRef("");
  useEffect(() => {
    if (!ready) return;
    const previous = taskRegistryVersion.current;
    taskRegistryVersion.current = taskRegistryKey;
    if (previous && previous !== taskRegistryKey && sharedTasks.ready) void sharedTasks.refresh();
  }, [ready, taskRegistryKey, sharedTasks.ready, sharedTasks.refresh]);

  const previewHistoryResult = previewNavigation.index >= 0 ? previewNavigation.entries[previewNavigation.index] : undefined;
  const previewSelected = librariesActive ? browsingPreview : (previewPinned || previewHistoryActive) && previewHistoryResult ? previewHistoryResult : selected;
  const pushPreviewHistory = useCallback((result: SearchResult) => {
    setPreviewNavigation((current) => pushPreviewNavigation(current, result));
  }, []);
  const navigatePreviewHistory = useCallback((direction: -1 | 1) => {
    const next = movePreviewNavigation(previewNavigation, direction);
    const target = next.index >= 0 ? next.entries[next.index] : undefined;
    setPreviewNavigation(next);
    setPreviewHistoryActive(true);
    setSelectedIndex(findMatchingResultIndex(visibleResults, target));
  }, [previewNavigation, visibleResults]);
  const togglePreviewPinned = useCallback(() => {
    setPreviewPinned((current) => {
      if (!current && previewSelected) pushPreviewHistory(previewSelected);
      if (current) {
        if (selected) pushPreviewHistory(selected);
        setPreviewHistoryActive(desktopSidebarView === "journals" && !selected && !!previewSelected);
      }
      return !current;
    });
  }, [previewSelected, pushPreviewHistory, selected, desktopSidebarView]);
  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(visibleResults.length - 1, 0)));
  }, [visibleResults.length]);
  const showingTagOverview = (desktopSidebarEnabled || isMobileLayout)
    && desktopSidebarView === "tags"
    && !selectedSidebarTag
    && !query.trim();
  const preservePreviewOnViewSwitch = useRef(false);
  const preserveHistoryOnQueryChange = useRef(false);
  const pendingSelectionSyncRef = useRef<SearchResult | null>(null);
  const prevQueryRef = useRef(query);
  useEffect(() => {
    if (prevQueryRef.current === query) return;
    prevQueryRef.current = query;
    if (preserveHistoryOnQueryChange.current) {
      preserveHistoryOnQueryChange.current = false;
      return;
    }
    pendingSelectionSyncRef.current = null;
    setPreviewHistoryActive(false);
  }, [query]);
  useEffect(() => {
    if (preservePreviewOnViewSwitch.current) {
      preservePreviewOnViewSwitch.current = false;
      return;
    }
    if (desktopSidebarEnabled && desktopSidebarView === "home" && !query.trim()) {
      setSelectedIndex(-1);
      setPreviewOpen(false);
    }
  }, [desktopSidebarEnabled, desktopSidebarView, query]);
  useEffect(() => {
    const target = pendingSelectionSyncRef.current;
    if (!target) return;
    if (desktopSidebarView === "tasks" || desktopSidebarView === "collections" || desktopSidebarView === "insights" || desktopSidebarView === "flashcards" || desktopSidebarView === "libraries") {
      return;
    }
    pendingSelectionSyncRef.current = null;
    const matchedIndex = findMatchingResultIndex(visibleResults, target);
    setSelectedIndex(matchedIndex);
    if (matchedIndex >= 0 && (visibleResults[matchedIndex].entityKey === target.entityKey || visibleResults[matchedIndex].id === target.id)) {
      setPreviewHistoryActive(false);
    }
  }, [desktopSidebarView, visibleResults]);
  const showPreviewPane = librariesActive ? Boolean(browsingPreview) : previewOpen && (!isMobileLayout || mobilePreviewOpen) && (!showingTagOverview || previewHistoryActive) && (!!previewSelected || visibleResults.length > 0);
  const activeResult = (showPreviewPane ? previewSelected : undefined) ?? selected;
  useEffect(() => {
    if (!showPreviewPane) setPreviewFocusMode(false);
  }, [showPreviewPane]);
  useEffect(() => {
    setPreviewFocusMode(false);
  }, [desktopSidebarView]);
  const togglePreviewFocus = useCallback(() => setPreviewFocusMode((current) => !current), []);
  const toggleSnippetFavorite = useCallback((result: SearchResult) => toggleFavorite({ ...result, favoriteKind: "snippet" }), [toggleFavorite]);
  const notifyPreviewAction = useCallback((message: string, tone: "success" | "error" = "success") => showOperationStatus(message, tone, tone === "error" ? 6000 : 2500), [showOperationStatus]);
  const selectedMatchTerms = useMemo(
    () => previewSelected ? resultMatchTerms(previewSelected, query) : queryTerms(query),
    [previewSelected, query],
  );
  const selectedHasSectionContext = Boolean(
    previewSelected?.documentTitle?.trim()
      && previewSelected.documentTitle.trim() !== previewSelected.title.trim(),
  );
  const selectedSectionTitle = previewSelected ? resultSectionTitle(previewSelected) : undefined;
  const libraryById = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  useEffect(() => { if (indexStatus && reconcileCounts(indexStatus.libraryHealth)) refreshSidebarTags(); }, [indexStatus, reconcileCounts, refreshSidebarTags]);

  const searchSuggestions = useMemo(() => appSettings.searchSuggestionsEnabled
    ? buildSearchSuggestions({
        query,
        history: appSettings.searchHistoryEnabled ? searchHistory : [],
        results,
        tags: sidebarTags,
        folders,
      })
    : [], [appSettings.searchHistoryEnabled, appSettings.searchSuggestionsEnabled, folders, query, results, searchHistory, sidebarTags]);
  const syntaxHints = useMemo(
    () => appSettings.searchSuggestionsEnabled ? searchSyntaxHints(query) : [],
    [appSettings.searchSuggestionsEnabled, query],
  );

  const applySmartCollection = useCallback((collection: SmartCollection) => {
    applySmartCollectionFilters(collection);
    setDesktopSidebarView("home");
    setSelectedSidebarTag("");
    setSelectedJournalDate("");
    setSelectedIndex(0);
    setSpaceMenuOpen(false);
    setMobilePreviewOpen(false);

  }, [applySmartCollectionFilters, setSelectedSidebarTag]);

  const applySearchSuggestion = useCallback((suggestion: SearchSuggestion) => {
    if (suggestion.folderId) {
      setFolderId(suggestion.folderId);
      setFiltersOpen(true);
    } else if (suggestion.query !== undefined) {
      setQuery(suggestion.query);
    }
    setDesktopSidebarView("home");
    setSelectedSidebarTag("");
    setSelectedJournalDate("");
    setSelectedIndex(0);
  }, []);

  const selectResultForPreview = useCallback((index: number) => {
    setSelectedIndex(index);
    const result = visibleResults[index];
    if (result) {
      rememberViewedResult(result);
      if (!previewPinned) {
        pushPreviewHistory(result);
        setPreviewHistoryActive(false);
      }
    }
    setPreviewOpen(true);
    if (!isMobileLayout) return;
    openMobilePreview();
    setFiltersOpen(false);
    setSpaceMenuOpen(false);
  }, [isMobileLayout, openMobilePreview, previewPinned, pushPreviewHistory, rememberViewedResult, visibleResults]);

  const [moduleTarget,setModuleTarget]=useState<{kind:"reading"|"flashcard";id:string}>();
  const moduleOpenSequence=useRef(0);
  const clearModuleTarget=useCallback(()=>setModuleTarget(undefined),[]);
  const openResult = useResultOpener({
    settings: appSettings,
    showOperationStatus,
  });
  const openSelectedResult = useCallback((result?: SearchResult, source: "result" | "preview" = "result") => {
    const ticket=++moduleOpenSequence.current;
    if(result?.provider==="hub"&&(result.contentType==="reading"||result.contentType==="flashcard")){
      const kind=result.contentType,id=result.documentId;
      void invoke<string>("module_search_document",{kind,id}).then(()=>{
        if(moduleOpenSequence.current===ticket)setModuleTarget({kind,id});
      }).catch(e=>showOperationStatus(String(e),"error"));return;
    }
    if (result) rememberViewedResult(result);
    openResult(result, source);
  }, [openResult, rememberViewedResult,showOperationStatus]);

  const {
    preview,
    ocrImagePreview,
    pdfPreview,
    pdfPreviewPage,
    setPdfPreviewPage,
    previewLoading,
    previewMatchCount,
    previewMatchIndex,
    copiedResultId,
    previewCard,
    pendingPreviewDirection,
    navigatePreviewMatch,
    copySelectedLink,
  } = usePreviewController({
    selected: previewSelected,
    results: visibleResults,
    selectedIndex,
    selectedMatchTerms,
    showPreviewPane,
    showOperationStatus,
  });
  const previewInlinePage = useCallback((result: SearchResult) => {
    pushPreviewHistory(result);
    setPreviewHistoryActive(true);
    setPreviewOpen(true);
  }, [pushPreviewHistory]);
  const openMarkdownLink = useMarkdownLinkOpening({ previewSelected, openResult, openExternalLink, showOperationStatus, previewInApp: isMobileLayout ? previewInlinePage : undefined });
  const previewLibraryResult = useCallback((result: SearchResult) => {
    rememberViewedResult(result);
    setLibraryPreview(result);
  }, [rememberViewedResult]);
  const openLibraryPreviewLink = (href?: string, title?: string) => {
    const subpage = browseSubpage(browsingPreview, href, title);
    if (subpage) previewLibraryResult(subpage);
    else openMarkdownLink(href, title);
  };


useEffect(() => {
    if (filtersOpen) return;
    setDateMenuOpen(false);
    setFolderMenuOpen(false);
    setSearchScopeMenuOpen(false);
  }, [filtersOpen]);

  useEffect(() => {
    if (!isMobileLayout) setMobilePreviewOpen(false);
  }, [isMobileLayout]);

  useEffect(() => {
    if (query.trim() && desktopSidebarView !== "home") {
      setDesktopSidebarView("home");
      setSelectedIndex(0);
    }
  }, [desktopSidebarView, query]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.target as HTMLElement | null)?.closest(".shortcut-setting-control")) return;
      if (event.defaultPrevented || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        event.stopImmediatePropagation();
        window.dispatchEvent(new Event("hub-close-result-context-menu"));
        setCommandPaletteMode("commands");
        setCommandPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "Escape") {
        if (document.querySelector(".result-context-menu")) {
          window.dispatchEvent(new Event("hub-close-result-context-menu"));
          return;
        }
        if (isInsideKeyboardDialog(event.target)) return;
        if (!commandPaletteOpen && document.querySelector(".agent-panel:not([hidden])")) return;
        event.preventDefault();
        if (commandPaletteOpen) {
          setCommandPaletteOpen(false);
          return;
        }
        if (document.activeElement === searchInput.current) {
          setQuery("");
          return;
        }
        if (previewFocusMode) {
          if (document.querySelector(".preview-toc-popover, details.preview-more-menu[open]")) return;
          setPreviewFocusMode(false);
          return;
        }
        if (isMobileLayout && mobilePreviewOpen) setMobilePreviewOpen(false);
        else if (spaceMenuOpen) setSpaceMenuOpen(false);
        else if (searchScopeMenuOpen) setSearchScopeMenuOpen(false);
        else if (folderMenuOpen) setFolderMenuOpen(false);
        else if (dateMenuOpen) setDateMenuOpen(false);
        else if (filtersOpen) setFiltersOpen(false);
        else if (showConnection && spaces.length) setShowConnection(false);
        else void hideWindow();
        return;
      }
      if (commandPaletteOpen) return;
      if (document.querySelector(".result-context-menu")) return;
      const target = event.target as HTMLElement | null;
      const editing = Boolean(target?.closest("input, textarea, select, [contenteditable='true'], .flashcards-table-text-cell"));
      if (event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !editing && !showConnection) {
        event.preventDefault();
        setCommandPaletteMode("shortcuts");
        setCommandPaletteOpen(true);
        return;
      }
      if (showConnection) return;
      const searchWorkspaceActive = !insightsActive && !collectionsActive && !tasksActive && !flashcardsActive && !librariesActive
        && !(isMobileLayout && mobileBrowseOpen) && !showingTagOverview;
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        if (searchWorkspaceActive) {
          event.preventDefault();
          setFiltersOpen((open) => !open);
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openHubSearch();
        return;
      }
      if (!canHandleSearchWorkspaceKeyboard(event, searchWorkspaceActive)) return;
      if (searchFocused && ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(event.key)) return;
      if (event.key === "F12" && previewOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const direction = event.shiftKey ? -1 : 1;
        if (previewMatchCount) navigatePreviewMatch(direction);
        else pendingPreviewDirection.current = direction;
      } else if (event.key === "F12" && activeResult) {
        event.preventDefault();
        event.stopImmediatePropagation();
        pendingPreviewDirection.current = event.shiftKey ? -1 : 1;
        setPreviewOpen(true);
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowLeft" && previewNavigation.index > 0) {
        event.preventDefault();
        navigatePreviewHistory(-1);
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key === "ArrowRight" && previewNavigation.index >= 0 && previewNavigation.index < previewNavigation.entries.length - 1) {
        event.preventDefault();
        navigatePreviewHistory(1);
      } else if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setPreviewOpen((open) => !open);
      } else if (event.key === "ArrowDown" || event.key === "PageDown") {
        event.preventDefault();
        if (visibleResults.length === 0) return;
        setPreviewHistoryActive(false);
        setPreviewOpen(true);
        const step = event.key === "PageDown" ? 8 : 1;
        setSelectedIndex((index) => index < 0 ? 0 : Math.min(index + step, visibleResults.length - 1));
      } else if (event.key === "ArrowUp" || event.key === "PageUp") {
        event.preventDefault();
        if (visibleResults.length === 0) return;
        setPreviewHistoryActive(false);
        setPreviewOpen(true);
        const step = event.key === "PageUp" ? 8 : 1;
        setSelectedIndex((index) => index < 0 ? 0 : Math.max(index - step, 0));
      } else if (event.key === "Home") {
        event.preventDefault();
        if (visibleResults.length === 0) return;
        setPreviewHistoryActive(false);
        setPreviewOpen(true);
        setSelectedIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        if (visibleResults.length === 0) return;
        setPreviewHistoryActive(false);
        setPreviewOpen(true);
        setSelectedIndex(visibleResults.length - 1);
      } else if (event.key === "Enter" && activeResult && !searchFocused && !editing) {
        event.preventDefault();
        rememberQuery(query);
        openSelectedResult(activeResult);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !searchFocused && !editing) {
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeResult, insightsActive, collectionsActive, commandPaletteOpen, dateMenuOpen, filtersOpen, flashcardsActive, folderMenuOpen, isMobileLayout, librariesActive, mobileBrowseOpen, mobilePreviewOpen, navigatePreviewHistory, navigatePreviewMatch, openHubSearch, openSelectedResult, previewFocusMode, previewMatchCount, previewNavigation.entries.length, previewNavigation.index, previewOpen, query, rememberQuery, searchFocused, searchScopeMenuOpen, showConnection, showingTagOverview, spaceMenuOpen, spaces.length, tasksActive, visibleResults.length]);

  const restoredResultIndex = useRef<number | null>(null);
  const restoreResultSelection = useCallback((index: number) => {
    if (previewHistoryActive || pendingSelectionSyncRef.current) return;
    restoredResultIndex.current = index;
    setSelectedIndex(index);
  }, [previewHistoryActive]);
  useEffect(() => {
    if (restoredResultIndex.current !== null) {
      if (selectedIndex === restoredResultIndex.current) restoredResultIndex.current = null;
      return;
    }
    document.querySelector<HTMLElement>(".quick-craft-result-block.selected, .result-group.selected .result-row, .recent-item.selected .recent-row")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);
  const resultLabel = useMemo(() => {
    if (!query.trim() && (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView === "tags" && !selectedSidebarTagSummary) {
      return tagOverviewMode === "cleanup"
        ? `待整理标签 · ${cleanupSidebarTags.length}`
        : `标签 · ${sidebarTags.length}`;
    }
    if (syncing) return "正在更新本地索引";
    if (journalsLoading && desktopSidebarView === "journals") return "正在读取日志";
    if (searching) return "正在搜索";
    if (!query.trim() && (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView === "journals") {
      return `日志 · ${journalDayCount} 天`;
    }
    if (!query.trim() && (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView === "favorites") return `收藏 · ${visibleResults.length}`;
    if (!query.trim() && (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView === "history") return `最近浏览 · ${visibleResults.length}`;
    if (!query.trim() && (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView === "tags") {
      if (selectedSidebarTagSummary) return `搜索结果 · ${visibleResults.length}`;
      return tagOverviewMode === "cleanup"
        ? `待整理标签 · ${cleanupSidebarTags.length}`
        : `标签 · ${sidebarTags.length}`;
    }
    if (query.trim()) return searchResultSummary(visibleResults, query);
    return "";
  }, [cleanupSidebarTags.length, desktopSidebarEnabled, desktopSidebarView, isMobileLayout, journalDayCount, journalsLoading, query, searching, selectedSidebarTagSummary, sidebarTags.length, syncing, tagOverviewMode, visibleResults]);

  const renderedPreviewMarkdown = useMemo(() => {
    if (!previewSelected || !preview) return null;
    return <Suspense fallback={<div className="preview-lazy-loading">正在准备预览…</div>}>
      <LazyPreviewRenderer
        selected={previewSelected}
        markdown={preview}
        matchTerms={selectedMatchTerms}
        hasSectionContext={selectedHasSectionContext}
        onOpenLink={openMarkdownLink}
      />
    </Suspense>;
  }, [openMarkdownLink, preview, previewSelected, selectedHasSectionContext, selectedMatchTerms]);

  const previewJournalDate = desktopSidebarView === "journals" ? journalDateKey(previewSelected) : "";
  const journalPreviewRequest = useRef(0);
  useEffect(() => { journalPreviewRequest.current += 1; }, [previewSelected?.entityKey, desktopSidebarView]);
  const navigatePreviewJournalDate = useCallback((direction: -1 | 1) => {
    const current = journalDateKey(previewSelected) || selectedJournalDate || journalDates[0]?.date;
    const request = ++journalPreviewRequest.current;
    const view = journalViewStore.view;
    const scope = currentSpaceIds === null ? view.libraries : view.libraries === null ? currentSpaceIds : currentSpaceIds.filter(id => view.libraries!.includes(id));
    void readAdjacentJournalPreview(current, direction, journalDates, scope, view.query).then(next => {
      if (!next || request !== journalPreviewRequest.current) return;
      const date = journalDateKey(next);
      setSelectedJournalDate(date);
      journalViewStore.navigate(date);
      rememberViewedResult(next);
      pushPreviewHistory(next);
      setPreviewHistoryActive(true);
      setPreviewOpen(true);
    }).catch(reason => { if (request === journalPreviewRequest.current) setError(String(reason)); });
  }, [journalDates, previewSelected, selectedJournalDate, currentSpaceIds, journalViewStore, pushPreviewHistory, rememberViewedResult]);

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const openCollectionView = (view: "journals" | "favorites" | "tags" | "collections") => {
      if (!desktopSidebarEnabled) changeDesktopSidebarSetting(true);
      setQuery("");
      setDesktopSidebarView(view);
      setSelectedSidebarTag("");
      if (view !== "journals") setSelectedJournalDate("");
      setSelectedIndex(0);
      setSpaceMenuOpen(false);
    };
    const items: CommandPaletteItem[] = [
      { id: "navigation:collections", label: "打开阅读", description: "同步 X、Telegram 和滴答稍后读，阅读保存的内容", category: "navigation", keywords: ["X", "书签", "bookmark", "待读"], run: () => openCollectionView("collections") },
      {
        id: "navigation:favorites",
        label: "打开收藏",
        description: `${favoriteResults.length} 个收藏文档`,
        category: "navigation",
        keywords: ["星标", "favorite", "star"],
        run: () => openCollectionView("favorites"),
      },
      {
        id: "navigation:journals",
        label: "打开日志",
        description: `${journalSummary.count} 个日志页面`,
        category: "navigation",
        keywords: ["日期", "journal", "daily"],
        run: () => openCollectionView("journals"),
      },
      {
        id: "navigation:tags",
        label: "打开标签",
        description: `${sidebarTags.length} 个标签`,
        category: "navigation",
        keywords: ["tag", "分类"],
        run: () => openCollectionView("tags"),
      },
      {
        id: "library:all",
        label: "切换到全部资料库",
        description: `搜索全部 ${spaces.length} 个资料库`,
        category: "library",
        keywords: ["library", "来源", "全部"],
        run: () => {
          selectAllLibraries();
          setFolderId("");
          setDesktopSidebarView("home");
        },
      },
      ...spaces.map((space): CommandPaletteItem => ({
        id: `library:${space.id}`,
        label: `切换资料库 · ${space.name}`,
        description: `${providerName(space.provider)} · ${space.documentCount} ${space.provider === "dida365" ? "项" : "篇"}`,
        category: "library",
        keywords: ["library", "来源", providerName(space.provider), space.name],
        disabled: !space.connected,
        run: () => {
          selectOnlyLibrary(space.id);
          setFolderId("");
          setDesktopSidebarView("home");
        },
      })),
      {
        id: "search:focus",
        label: "聚焦搜索框",
        description: "返回搜索并开始输入",
        category: "search",
        shortcut: "Ctrl+F",
        keywords: ["find", "query", "查找"],
        run: () => {
          window.requestAnimationFrame(() => searchInput.current?.focus());
        },
      },
      {
        id: "search:clear-filters",
        label: "清除筛选",
        description: activeFilterCount ? `清除 ${activeFilterCount} 组当前筛选` : "当前没有生效的筛选",
        category: "search",
        keywords: ["reset", "过滤", "类型", "时间", "文件夹"],
        disabled: activeFilterCount === 0,
        run: () => {
          setFolderId("");
          setDateFilter("any");
          setSearchScope("all");
          setSourceFilters({ craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true });
          setFiltersOpen(false);
          showOperationStatus("已清除搜索筛选", "success");
        },
      },
      {
        id: "search:sync",
        label: selectedLibraryIds === null ? "同步全部资料库" : "同步所选资料库",
        description: syncing ? "同步正在进行" : `${activeSpaces.length} 个资料库将更新本地索引`,
        category: "search",
        keywords: ["更新", "refresh", "index", "索引"],
        disabled: syncing || !spaces.some((space) => space.connected),
        run: () => void refreshIndex(),
      },
      {
        id: "result:copy-link",
        label: "复制当前结果链接",
        description: activeResult ? resultDisplayTitle(activeResult) : "尚未选择搜索结果",
        category: "result",
        keywords: ["copy", "link", "链接"],
        disabled: !activeResult,
        run: () => void copySelectedLink(),
      },
      {
        id: "result:open-original",
        label: "在原应用中打开",
        description: activeResult ? `${providerName(activeResult.provider)} · ${resultDisplayTitle(activeResult)}` : "尚未选择搜索结果",
        category: "result",
        shortcut: "Enter",
        keywords: ["open", "original", "原文"],
        disabled: !canOpenResultSource(activeResult, spaces, runtimeCapabilities.platform),
        run: () => openSelectedResult(activeResult),
      },
      {
        id: "view:preview",
        label: previewOpen ? "隐藏预览" : "显示预览",
        description: previewOpen ? "关闭右侧预览窗格" : "打开右侧预览窗格",
        category: "view",
        shortcut: "Alt+P",
        keywords: ["preview", "窗格", "阅读"],
        run: () => setPreviewOpen((open) => !open),
      },
      {
        id: "view:filters",
        label: filtersOpen ? "收起筛选栏" : "展开筛选栏",
        description: activeFilterCount ? `${activeFilterCount} 组筛选正在生效` : "查看搜索范围与内容类型",
        category: "view",
        shortcut: "Ctrl+Shift+F",
        keywords: ["filter", "过滤", "范围"],
        run: () => setFiltersOpen((open) => !open),
      },
    ];
    return items;
  }, [
    activeFilterCount, activeResult, activeSpaces.length, changeDesktopSidebarSetting, copySelectedLink,
    desktopSidebarEnabled, favoriteResults.length, filtersOpen, journalSummary.count,
    openSelectedResult, previewOpen, refreshIndex, selectedLibraryIds,
    showOperationStatus, sidebarTags.length, spaces, syncing,
  ]);
  const shortcutHelpGroups = useMemo<ShortcutHelpGroup[]>(() => [
    {
      title: "全局与导航",
      items: [
        { keys: ["Ctrl", "P"], label: "打开命令面板" },
        { keys: ["?"], label: "打开快捷键帮助" },
        { keys: appSettings.toggleShortcut.split("+"), label: "显示或隐藏 Hub" },
        { keys: ["Esc"], label: "关闭菜单、返回或隐藏 Hub" },
      ],
    },
    {
      title: "搜索与结果",
      items: [
        { keys: ["Ctrl", "F"], label: "聚焦搜索框" },
        { keys: ["Ctrl", "Shift", "F"], label: "展开或收起筛选" },
        { keys: ["↑", "↓"], label: "选择上一项或下一项" },
        { keys: ["PageUp", "PageDown"], label: "按页浏览结果" },
        { keys: ["Home", "End"], label: "跳到首个或末个结果" },
        { keys: ["Enter"], label: "打开当前结果" },
      ],
    },
    {
      title: "预览",
      items: [
        { keys: ["Alt", "P"], label: "显示或隐藏预览" },
        { keys: ["Alt", "←"], label: "后退到上一个预览" },
        { keys: ["Alt", "→"], label: "前进到下一个预览" },
        { keys: ["F12"], label: "下一个预览命中" },
        { keys: ["Shift", "F12"], label: "上一个预览命中" },
      ],
    },
  ], [appSettings.toggleShortcut]);

  const renderResultLibraryIcon = useCallback((result: SearchResult, name: string) => (
    <LibraryIcon
      provider={result.provider}
      name={name}
      iconSvg={libraryById.get(result.libraryId)?.iconSvg}
      defaultIconUrl={libraryById.get(result.libraryId)?.defaultIconUrl}
      compact
    />
  ), [libraryById]);

  const renderCompactLibraryIcon = useCallback((space: LibrarySummary) => (
    <LibraryIcon
      provider={space.provider}
      name={space.name}
      iconSvg={space.iconSvg}
      defaultIconUrl={space.defaultIconUrl}
      compact
    />
  ), []);

  const locateInLibrary = (result: SearchResult) => {
    setLibraryPosition({ libraryId: result.libraryId, folderId: result.folderId ?? "", documentId: result.documentId });
    previewLibraryResult(result);
    selectDesktopSidebarView("libraries");
  };

  const applyMobileRoute = useCallback((route: string) => {
    setFiltersOpen(false);
    setSpaceMenuOpen(false);
    setMobileBrowseOpen(route === "browse");
    setMobileAgentsOpen(route === "agents");
    setMobileConnectionsOpen(route === "connections");
    if (route === "search" || route === "browse" || route === "agents" || route === "connections") selectDesktopSidebarView("home");
    else if (route === "tasks" || route === "favorites" || route === "history" || route === "journals" || route === "tags" || route === "collections" || route === "insights") {
      selectDesktopSidebarView(route);
      if (route !== "tasks") setQuery("");
      if (route === "tags") {
        setSelectedSidebarTag("");
        setTagOverviewMode("all");
      }
    }
  }, [selectDesktopSidebarView]);
  bindMobileRoute(applyMobileRoute);

  const pushMobileRoute = useCallback((route: string) => {
    if (openRouteFromFlashcards(route)) return;
    if (window.history.state?.hubMobileRoute !== route) {
      if (window.history.state?.hubReadingPreview || window.history.state?.hubQuickCapture) {
        window.history.replaceState({ hubMobileRoute: route }, "");
      } else {
        window.history.pushState({ hubMobileRoute: route }, "");
      }
    }
    applyMobileRoute(route);
  }, [applyMobileRoute, openRouteFromFlashcards]);

  useEffect(()=>{
    if(!runtimeCapabilities.mobile||!ready)return;
    let consuming=false;
    const consume=async()=>{if(consuming)return;consuming=true;try{const result=await invoke<{action:string;recordId:string}>("journal_mobile_action");if(result.action==="capture"){setQuickCaptureOpen(true);window.dispatchEvent(new Event("hub:journal-capture-focus"));}else if(result.action==="record"&&/^[a-f0-9]{32}$/.test(result.recordId)){pushMobileRoute("journals");setJournalTarget(result.recordId);}}catch{}finally{consuming=false;}};
    void consume();window.addEventListener("hub:journal-action-available",consume);window.addEventListener("focus",consume);
    return()=>{window.removeEventListener("hub:journal-action-available",consume);window.removeEventListener("focus",consume);};
  },[ready,pushMobileRoute]);

  const closeMobileAgents = useCallback(() => {
    mobileSearch.consumeBack();
    window.history.replaceState({ hubMobileRoute: "search" }, "");
    applyMobileRoute("search");
  }, [applyMobileRoute, mobileSearch.consumeBack]);

  const navigateMobile = useCallback((destination: MobileDestination) => {
    if (destination === "review") {
      openStandaloneFlashcards();
      return;
    }
    pushMobileRoute(destination);
    if (destination === "search") mobileSearch.open();
  }, [openStandaloneFlashcards, pushMobileRoute, mobileSearch.open]);
  useEffect(()=>{
    if(!moduleTarget)return;
    if(moduleTarget.kind==="reading"){
      if(isMobileLayout){if(!openRouteFromPreview("collections"))pushMobileRoute("collections");}
      else selectDesktopSidebarView("collections");
    }else openStandaloneFlashcards();
  },[moduleTarget,isMobileLayout,openRouteFromPreview,pushMobileRoute,selectDesktopSidebarView,openStandaloneFlashcards]);

  const openMobileCollection = useCallback((view: MobileBrowseView) => {
    pushMobileRoute(view);
  }, [pushMobileRoute]);

  const openDesktopLibraryManagement = useCallback(() => {
    setSettingsCategory("libraries");
    setShowConnection(true);
  }, []);

  const openPinnedLibrary = useCallback((libraryId: string) => {
    setFlashcardsStandaloneOpen(false);
    setLibraryPosition({ libraryId, folderId: "" });
    selectDesktopSidebarView("libraries");
  }, [selectDesktopSidebarView, setLibraryPosition]);

  const openPinnedResult = useCallback((result: SearchResult) => {
    rememberViewedResult(result);
    pushPreviewHistory(result);
    setPreviewPinned(false);
    setPreviewOpen(true);
    setFlashcardsStandaloneOpen(false);
    const switchingFromStandalone = desktopSidebarView === "tasks" || desktopSidebarView === "collections" || desktopSidebarView === "insights" || desktopSidebarView === "flashcards" || desktopSidebarView === "libraries";
    if (switchingFromStandalone) {
      preservePreviewOnViewSwitch.current = true;
      if (query) preserveHistoryOnQueryChange.current = true;
      pendingSelectionSyncRef.current = result;
      setSelectedIndex(-1);
      setPreviewHistoryActive(true);
      moduleQueries.current[desktopSidebarView] = query;
      setQuery("");
      setDesktopSidebarView("home");
      return;
    }
    const matchedIndex = findMatchingResultIndex(visibleResults, result);
    setSelectedIndex(matchedIndex);
    const exactMatch = matchedIndex >= 0 && (visibleResults[matchedIndex].entityKey === result.entityKey || visibleResults[matchedIndex].id === result.id);
    setPreviewHistoryActive(!exactMatch);
    if (desktopSidebarView === "history") {
      pendingSelectionSyncRef.current = result;
    }
  }, [desktopSidebarView, pushPreviewHistory, query, rememberViewedResult, setQuery, visibleResults]);

  const hoverResult = useCallback((index: number) => {
    if (!previewPinned && !previewHistoryActive) setSelectedIndex(index);
  }, [previewHistoryActive, previewPinned]);

  const selectDesktopJournalDate = useCallback((date: string) => {
    setSelectedJournalDate(date);
    setSelectedIndex(0);
  }, []);

  const selectSidebarTagOverview = useCallback(() => {
    setPreviewHistoryActive(false);
    setQuery("");
    setDesktopSidebarView("tags");
    setSelectedSidebarTag("");
    setTagOverviewMode("all");
    setSelectedIndex(0);
  }, []);

  const selectSidebarTagCleanup = useCallback(() => {
    setPreviewHistoryActive(false);
    setQuery("");
    setDesktopSidebarView("tags");
    setSelectedSidebarTag("");
    setTagOverviewMode("cleanup");
    setSelectedIndex(0);
  }, []);

  const selectDesktopSidebarTag = useCallback((tag: SidebarTagSummary) => {
    setPreviewHistoryActive(false);
    setQuery("");
    setDesktopSidebarView("tags");
    setSelectedSidebarTag(tag.normalizedName);
    rememberSidebarTag(tag.normalizedName);
    setSelectedIndex(0);
  }, [rememberSidebarTag]);

  const collapseDesktopSidebar = useCallback(() => {
    changeDesktopSidebarSetting(false);
  }, [changeDesktopSidebarSetting]);

  const shellStyle = appShellStyle(appSettings);
  const workspaceProps: WorkspaceProps = {
    workspaceRef,
    desktopTopicCatalog: desktopSidebarView === "tags" && !isMobileLayout ? {
      tags: sidebarTags,
      groups: sidebarTagGroups,
      properties: tagProperties,
      favorites: favoriteSidebarTags,
      recent: recentSidebarTags,
      cleanupCount: cleanupSidebarTags.length,
      onCloseCleanup: selectSidebarTagOverview,
      onSearch: (name) => { selectDesktopSidebarView("home"); setQuery(name); },
      onCreate: createSidebarTopic,
    } : undefined,
    showPreviewPane,
    previewFocusMode,
    resultsPanePercent,
    onResizePreviewPanes: resizePreviewPanes,
    onResetPreviewSplit: resetPreviewSplit,
    resultsPaneProps: {
      resultLabel: resultLabel,
      navigationContext: JSON.stringify([desktopSidebarView, query, desktopSidebarView === "tags" ? selectedSidebarTag : "", desktopSidebarView === "journals" ? selectedJournalDate : "", selectedLibraryIds, folderId, dateFilter, searchScope, sourceFilters]),
      contextReady: query.trim() || desktopSidebarView === "home" ? resultsCurrent : desktopSidebarView === "journals" ? !journalsLoading : desktopSidebarView === "tags" ? !selectedSidebarTag || tagResultsFor === tagResultContext : true,
      onRestoreSelection: restoreResultSelection,
      selectionManagedByData: showingLocalSearch.current,
      scopeLabel: desktopSidebarView === "home" && !query.trim() && selectedLibraryIds === null
        ? undefined
        : selectedLibraryIds === null
          ? "全部资料库"
          : activeSpaces.map(space => `${space.name} · ${providerName(space.provider)}`).join("、") || "未选择资料库",
      tagLibraries: spaces,
      tagsLoading,
      selectedTagLibraryIds: selectedLibraryIds,
      onChangeTagLibraries: selectLibraries,
      onClearScope: selectedLibraryIds === null ? undefined : () => selectAllLibraries(),
      error,
      searching: searching || (journalsLoading && desktopSidebarView === "journals"),
      query,
      results: visibleResults,
      recentGroups,
      selectedIndex,
      showSelection: previewOpen || Boolean(query.trim()) || desktopSidebarView !== "home",
      isMobileLayout,
      semanticRecentDates: appSettings.semanticRecentDates,
      onHoverResult: hoverResult,
      onSelectResult: selectResultForPreview,
      onOpenResult: openSelectedResult,
      onPreviewEvidence: (result) => {
        rememberViewedResult(result);
        pushPreviewHistory(result);
        const matchedIndex = findMatchingResultIndex(visibleResults, result);
        setSelectedIndex(matchedIndex);
        setPreviewHistoryActive(true);
        setPreviewPinned(false);
        setPreviewOpen(true);
        if (isMobileLayout) {
          openMobilePreview();
        }
      },
      onPrepareResultLink: prepareResultLink,
      onDragResult: dragResult,
      onCopyResultLink: (result) => copyResultValue(result, "link"),
      onCopyResultMarkdown: (result) => copyResultValue(result, "markdown"),
      onCopyResultTitle: (result) => copyResultValue(result, "title"),
      onCopyResultSummary: (result) => copyResultValue(result, "summary"),
      onRevealResult: revealResult,
      canRevealResult: (result) => result.provider === "obsidian" && Boolean(libraryById.get(result.libraryId)?.location),
      onLocateInLibrary: !isMobileLayout && desktopSidebarEnabled ? locateInLibrary : undefined,
      renderLibraryIcon: renderResultLibraryIcon,
      collectionView: (desktopSidebarEnabled || isMobileLayout) && desktopSidebarView !== "home" && desktopSidebarView !== "flashcards" && desktopSidebarView !== "tasks" && desktopSidebarView !== "collections" && desktopSidebarView !== "insights" && desktopSidebarView !== "libraries" && !query.trim() ? desktopSidebarView : undefined,
      selectedCollectionTag: desktopSidebarView === "tags" ? selectedSidebarTagSummary : undefined,
      collectionQuery: isMobileLayout && (desktopSidebarView === "tags" || desktopSidebarView === "favorites") ? mobileCollectionQueries[desktopSidebarView] : undefined,
      selectedTagColor: selectedSidebarTagSummary
        ? resolveTagColor(tagProperties, selectedSidebarTagSummary.normalizedName)
        : undefined,
      selectedTagDescription: selectedSidebarTagSummary
        ? tagProperties[selectedSidebarTagSummary.normalizedName]?.description
        : undefined,
      selectedTagParent: selectedSidebarTagSummary
        ? tagProperties[selectedSidebarTagSummary.normalizedName]?.parent
        : undefined,
      selectedTagAliases: selectedSidebarTagSummary
        ? tagProperties[selectedSidebarTagSummary.normalizedName]?.aliases
        : undefined,
      selectedTagTaxonomy,
      selectedTagGroup: selectedSidebarTagGroup,
      selectedTagLibraryCount: selectedSidebarTagLibraryCount,
      selectedTagLastUpdated: selectedSidebarTagLastUpdated,
      selectedTagRelated: selectedSidebarTagRelated,
      selectedTagFavorite: selectedSidebarTagSummary
        ? favoriteSidebarTags.includes(selectedSidebarTagSummary.normalizedName)
        : false,
      onChangeSelectedTagColor: selectedSidebarTagSummary
        ? (color) => updateSidebarTagProperty(selectedSidebarTagSummary.normalizedName, { color })
        : undefined,
      onChangeSelectedTagDescription: selectedSidebarTagSummary
        ? (description) => updateSidebarTagProperty(selectedSidebarTagSummary.normalizedName, { description })
        : undefined,
      onToggleSelectedTagFavorite: selectedSidebarTagSummary
        ? () => toggleFavoriteSidebarTag(selectedSidebarTagSummary.normalizedName)
        : undefined,
      onSelectedTagTaxonomyChanged: () => refreshSidebarTags(),
      collectionTags: desktopSidebarView === "tags"
        ? (tagOverviewMode === "cleanup" ? cleanupSidebarTags : sidebarTags).filter(tag => !isMobileLayout || matchesMobileCollection(mobileCollectionQueries.tags, tag.name))
        : undefined,
      collectionTagColors: desktopSidebarView === "tags"
        ? Object.fromEntries(sidebarTags.map((tag) => [tag.normalizedName, resolveTagColor(tagProperties, tag.normalizedName)]))
        : undefined,
      tagOverviewMode,
      onSelectCollectionTag: (tag) => {
        if (isMobileLayout) {
          window.history.pushState({ ...(window.history.state ?? {}), hubMobileRoute: "tags", hubMobileTag: tag.normalizedName }, "");
          setSelectedSidebarTag(tag.normalizedName);
        } else {
          setPreviewHistoryActive(false);
          selectWorkspaceTopic(tag);
        }
        rememberSidebarTag(tag.normalizedName);
        setSelectedIndex(0);
      },
      favoriteIds: desktopSidebarEnabled || isMobileLayout ? favoriteIds : undefined,
      snippetFavoriteIds,
      onToggleSnippetFavorite: (result) => toggleFavorite({ ...result, favoriteKind: "snippet" }),
      favoriteFilter,
      onFavoriteFilterChange: setFavoriteFilter,
      onToggleFavorite: desktopSidebarEnabled || isMobileLayout ? toggleFavorite : undefined,
      selectedJournalDate,
      journalDataVersion: journalDataVersion(indexStatus, currentSpaceIds),
      journalSelectedKey: desktopSidebarView === "journals" ? previewSelected?.entityKey : undefined,
      onNavigateJournalDate: setSelectedJournalDate,
      onCreateJournalDate: setCreateJournalDate,
      onClearJournalDate: () => setSelectedJournalDate(""),
      onCreateJournal: selectedJournalDate.length === 10
        ? () => setCreateJournalDate(selectedJournalDate)
        : undefined,
    },
    previewPaneProps: {
      selected: previewSelected,
      canGoBack: !librariesActive && previewNavigation.index > 0,
      canGoForward: !librariesActive && previewNavigation.index >= 0 && previewNavigation.index < previewNavigation.entries.length - 1,
      previewPinned: !librariesActive && previewPinned,
      onNavigatePreviewHistory: navigatePreviewHistory,
      onTogglePreviewPinned: librariesActive ? undefined : togglePreviewPinned,
      selectedMatchTerms,
      selectedSectionTitle,
      previewMatchCount,
      previewMatchIndex,
      copiedResultId,
      spaces,
      pdfPreview,
      pdfPreviewPage,
      pdfQuery: query,
      ocrImagePreview,
      previewLoading,
      previewMarkdown: preview,
      renderedPreviewMarkdown,
      onOpenLink: librariesActive ? openLibraryPreviewLink : openMarkdownLink,
      previewCard,
      startWindowDrag,
      onCloseMobilePreview: closeMobilePreview,
      setPdfPreviewPage,
      navigatePreviewMatch,
      copySelectedLink,
      openSelectedResult,
      providerName,
      journalDate: previewJournalDate,
      canNavigateJournalOlder: desktopSidebarView === "journals" && journalDates.some((item) => item.date < previewJournalDate),
      canNavigateJournalNewer: desktopSidebarView === "journals" && journalDates.some((item) => item.date > previewJournalDate),
      onNavigateJournalDate: navigatePreviewJournalDate,
      isFavorite: previewSelected ? favoriteIds.has(pageFavoriteKey(previewSelected)) : false,
      snippetFavoriteIds: !isMobileLayout ? snippetFavoriteIds : undefined,
      onToggleFavorite: !isMobileLayout ? toggleFavorite : undefined,
      onToggleSnippetFavorite: !isMobileLayout ? toggleSnippetFavorite : undefined,
      previewFocusMode,
      onTogglePreviewFocus: !isMobileLayout ? togglePreviewFocus : undefined,
      onNotify: notifyPreviewAction,
    },
  };
  const settingsContentProps: SettingsContentProps = {
    category: settingsCategory,
    managedSpaces: {
      allowVaultExport: runtimeCapabilities.localVault,
      spaces,
      renderLibraryIcon: (space) => (
        <LibraryIcon provider={space.provider} name={space.name} iconSvg={space.iconSvg} defaultIconUrl={space.defaultIconUrl} />
      ),
      indexStatus,
      renamingLibraryId,
      libraryRuntime: libraryManagement.libraries,
      acceptingLibrary: libraryManagement.accepting,
      controlLibrary: (space, action) => libraryManagement.act(space.id, action),
      libraryNameDraft,
      exportingLibraryId,
      exportProgress,
      lastExportPath,
      exportError,
      maintenanceMessage,
      editingExclusions,
      exclusionDraft,
      savingExclusions,
      restartingWatcher,
      relocatingLibraryId,
      relocateObsidian,
      providerName,
      providerUnavailableLabel,
      obsidianWatchLabel,
      beginRenameLibrary,
      saveLibraryName,
      updateLibraryIcon,
      resetLibraryIcon,
      chooseExportDirectory,
      exportCraftVault,
      editExclusions,
      restartWatcher,
      removeSpace,
      saveExclusions,
      openExportPath,
      openExportInObsidian,
      setRenamingLibraryId,
      setLibraryNameDraft,
      setEditingExclusions,
      setExclusionDraft,
    },
    storageSync: {
      runtimeCapabilities,
      storageInfo,
      storageMode,
      storageCustomPath,
      changingStorage,
      autoSyncMinutes: appSettings.autoSyncMinutes,
      formatFileSize,
      revealStorageLocation,
      chooseStorageFolder,
      applyStorageLocation,
      changeAutoSync,
      setStorageMode,
      setStorageCustomPath,
    },
    display: {
      mobile: isMobileLayout,
      appSettings,
      saveSettings,
      changeRecentGroupingSetting,
      desktopSidebarEnabled,
      changeDesktopSidebarSetting,
    },
    behavior: {
      shortcutMessage,
      runtimeCapabilities,
      appSettings,
      updatingShortcut,
      saveSettings,
      changeToggleShortcut,
      clearSearchHistory,
      changeCraftOpenMode,
      shortcutFromKeyboardEvent,
    },
    indexMaintenance: {
      runtimeCapabilities,
      indexStatus,
      cleaning,
      retryingOcr,
      syncPhaseLabel,
      reloadAppSettings: loadAppSettings,
      cleanupLocalData,
      retryFailedOcr,
    },
    connections: {
      runtimeCapabilities,
      spaces,
      feishuAuthorization,
      feishuAppId,
      feishuAppSecret,
      selectedFeishuSpaceIds,
      feishuBitableSourceId,
      feishuBitableUrl,
      obsidianPath,
      mcpUrl,
      craftApiUrl,
      craftApiKey,
      connectingAction,
      connectionError,
      connectionErrorProvider,
      setFeishuAuthorization,
      setFeishuAppId,
      setFeishuAppSecret,
      setSelectedFeishuSpaceIds,
      setFeishuBitableSourceId,
      setFeishuBitableUrl,
      setObsidianPath,
      setMcpUrl,
      setCraftApiUrl,
      setCraftApiKey,
      connectFeishu,
      addSelectedFeishuSpaces,
      addFeishuBitable,
      connectDida365,
      addObsidian,
      connect,
      saveCraftApiConnection,
    },
  };
  const AppLayout = isMobileLayout ? MobileAppLayout : DesktopAppLayout;
  const savedMobileCapture = (record: QuickJournalSaved) => {
    setShowConnection(false);
    selectAllLibraries(); setQuery("");
    journalViewStore.update({ layout: "records", period: "day", day: record.date, month: record.date.slice(0, 7), libraries: null, query: "" });
    pushMobileRoute("journals"); setQuickCaptureOpen(false);
    showOperationStatus(record.notice, "success", 5000);
  };
  const openCaptureSyncSettings = () => {
    if (window.history.state?.hubQuickCapture) window.history.replaceState({ hubMobileRoute: window.history.state.hubMobileRoute || "browse", hubSettings: true }, "");
    setQuickCaptureOpen(false); setSettingsCategory("cloud"); setShowConnection(true);
  };
  const appLayoutProps: AppLayoutProps = {
    filtersOpen,
    mobilePreviewOpen,
    onSelectMobileLibraries: selectLibraries,
    mobileCollectionSearch: isMobileLayout && (desktopSidebarView === "favorites" || (desktopSidebarView === "tags" && !selectedSidebarTag)) ? {
      label: desktopSidebarView === "favorites" ? "搜索收藏" : "搜索标签",
      value: mobileCollectionQueries[desktopSidebarView as "favorites" | "tags"],
      onChange: (value: string) => setMobileCollectionQueries(current => ({ ...current, [desktopSidebarView]: value })),
    } : undefined,
    mobileHeader: isMobileLayout && !mobilePreviewOpen && !mobileAgentsOpen && desktopSidebarView!=="journals" ? <MobileHeader title={flashcardsActive?"复习":mobileConnectionsOpen?"连接总览":mobileBrowseOpen?"浏览":({home:"搜索",tasks:"任务",collections:"阅读",favorites:"收藏",history:"最近浏览",tags:"标签",insights:"洞察"} as {[key:string]:string})[desktopSidebarView]} onBack={!flashcardsActive && ((!["home", "tasks"].includes(desktopSidebarView) && !mobileBrowseOpen) || mobileConnectionsOpen) ? () => navigateMobile("browse") : undefined} onSettings={() => setShowConnection(true)} spaceActions={{
      onLibraries: () => { navigateMobile("search"); setSpaceMenuOpen(true); },
      onConnections: () => pushMobileRoute("connections"),
      onAppearance: () => { setSettingsCategory("display"); setShowConnection(true); },
    }} /> : undefined,
    style: shellStyle,
    startWindowDrag,
    mainContent: isMobileLayout && mobileAgentsOpen && !flashcardsActive ? <Suspense fallback={<div className="workspace-lazy-loading">正在打开助手…</div>}><LazyCloudAgents onClose={closeMobileAgents} /></Suspense> : isMobileLayout && mobileConnectionsOpen && !flashcardsActive ? <MobileConnections onContent={() => { setSettingsCategory("cloud"); setShowConnection(true); }} onAgents={() => navigateMobile("agents")} /> : isMobileLayout && mobileBrowseOpen && !flashcardsActive ? <MobileBrowse
      favoriteCount={favoriteResults.length}
      historyCount={viewHistory.length}
      journalCount={journalDates.length}
      tagCount={sidebarTags.length}
      onOpen={openMobileCollection}
      onOpenInsights={() => pushMobileRoute("insights")}
      onOpenLibraries={() => { navigateMobile("search"); setSpaceMenuOpen(true); }}
      onOpenSettings={() => setShowConnection(true)}
      onOpenSyncHealth={() => pushMobileRoute("connections")}
      syncNeedsAttention={Boolean(indexStatus?.failedJobs)}
    /> : isMobileLayout && desktopSidebarView==="journals" ? <MobileJournal onBack={()=>navigateMobile("browse")} onInsights={()=>pushMobileRoute("insights")} targetId={journalTarget} onTargetHandled={()=>setJournalTarget("")}/> : librariesActive ? <LibraryBrowse
      libraries={browseLibraries}
      favorites={favoriteResults}
      onToggleFavorite={toggleFavorite}
      position={libraryPosition}
      onPosition={setLibraryPosition}
      selected={browsingPreview}
      onPreview={previewLibraryResult}
      onClosePreview={() => setLibraryPreview(undefined)}
      onExit={() => selectDesktopSidebarView("home")}
      focusMode={previewFocusMode}
      onExitFocusMode={() => setPreviewFocusMode(false)}
      preview={browsingPreview && <PreviewPane {...workspaceProps.previewPaneProps} label="文档预览" onClose={() => setLibraryPreview(undefined)} />}
    /> : insightsActive ? <Suspense fallback={<div className="workspace-lazy-loading">正在打开洞察…</div>}><LazyInsightsWorkspace/></Suspense> : collectionsActive ? <Suspense fallback={<div className="workspace-lazy-loading">正在打开阅读…</div>}><LazyCollectionsWorkspace
      initialItemKey={moduleTarget?.kind==="reading"?moduleTarget.id:undefined}
      onSearchTargetHandled={clearModuleTarget}
      onOpenLibrarySettings={() => { setSettingsCategory("libraries"); setShowConnection(true); }}
      onToggleDesktopSidebar={!isMobileLayout ? () => changeDesktopSidebarSetting(!desktopSidebarEnabled) : undefined}
    /></Suspense> : tasksActive ? <Suspense fallback={<div className="workspace-lazy-loading">正在打开任务…</div>}><LazyTaskWorkspace
      libraries={spaces}
      selectedLibraryIds={selectedLibraryIds}
      onClearLibraryScope={selectAllLibraries}
      desktopSidebarVisible={desktopSidebarEnabled && !isMobileLayout}
      onCountChange={updateTaskOpenCount}
      onOpenResult={openSelectedResult}
      onStatusMessage={showOperationStatus}
      onToggleDesktopSidebar={!isMobileLayout ? () => changeDesktopSidebarSetting(!desktopSidebarEnabled) : undefined}
      favoriteIds={favoriteIds}
      snippetFavoriteIds={snippetFavoriteIds}
      onToggleFavorite={toggleFavorite}
      onToggleSnippetFavorite={toggleSnippetFavorite}
    /></Suspense> : flashcardsActive ? <Suspense fallback={<div className="workspace-lazy-loading">正在打开闪卡…</div>}><LazyFlashcardsWorkspace
      initialCardId={moduleTarget?.kind==="flashcard"?moduleTarget.id:undefined}
      onSearchTargetHandled={clearModuleTarget}
      onDueCountChange={updateFlashcardDueCount}
      desktopSidebarVisible={desktopSidebarEnabled && !isMobileLayout}
      sourceOpenMode={appSettings.craftResultOpenMode}
      onStatusMessage={showOperationStatus}
      onToggleDesktopSidebar={!isMobileLayout ? () => changeDesktopSidebarSetting(!desktopSidebarEnabled) : undefined}
      onClose={() => {
        closeStandaloneFlashcards();
        if (desktopSidebarView === "flashcards") setDesktopSidebarView("home");
      }}
    /></Suspense> : undefined,
    headerProps: {
      activeFilterCount,
      activeSpaces,
      currentSpaceName,
      filtersOpen,
      isComposing,
      isMobileLayout,
      mobilePreviewOpen,
      query,
      searchFocused,
      mobileSearchExpanded: mobileSearch.expanded,
      onCancelMobileSearch: mobileSearch.cancel,
      searchHistory,
      searchHistoryEnabled: appSettings.searchHistoryEnabled,
      searchSuggestionsEnabled: appSettings.searchSuggestionsEnabled,
      searchInput,
      suggestions: searchSuggestions,
      syntaxHints,
      filterSummary,
      searching,
      selected: activeResult,
      selectedLibraryIds,
      showPreviewPane,
      spaceMenuOpen,
      spaces,
      libraryFacetCounts: appSettings.dynamicFacetCountsEnabled ? dynamicFacets.libraries : undefined,
      facetCountsTruncated: appSettings.dynamicFacetCountsEnabled && dynamicFacets.truncated,
      clearSearchHistory,
      openSelectedResult,
      providerName,
      providerUnavailableLabel,
      rememberQuery,
      removeSearchHistoryItem,
      onApplySuggestion: applySearchSuggestion,
      renderLibraryIcon: renderCompactLibraryIcon,
      setFiltersOpen,
      setIsComposing,
      setMobilePreviewOpen,
      setPreviewOpen,
      setQuery,
      setSearchFocused,
      setShowConnection,
      setSpaceMenuOpen,
      startWindowDrag,
      toggleAllLibraries,
      toggleLibrarySelection,
      desktopSidebarEnabled,
      toggleDesktopSidebar: () => changeDesktopSidebarSetting(!desktopSidebarEnabled),
      flashcardsActive,
      onOpenFlashcards: isMobileLayout || !desktopSidebarEnabled ? openStandaloneFlashcards : undefined,
    },
    filterBarProps: {
      activeSpaces,
      dateFilter,
      dateMenuOpen,
      folderId,
      folderMenuOpen,
      folders,
      searchScope,
      searchScopeMenuOpen,
      selectedFolder,
      selectedLibraryIds,
      sourceFilters,
      spaces,
      syncing,
      sourceFacetCounts: appSettings.dynamicFacetCountsEnabled ? dynamicFacets.sources : undefined,
      folderFacetCounts: appSettings.dynamicFacetCountsEnabled ? dynamicFacets.folders : undefined,
      facetTotal: dynamicFacets.total,
      facetCountsTruncated: appSettings.dynamicFacetCountsEnabled && dynamicFacets.truncated,
      refreshIndex,
      setDateFilter,
      setDateMenuOpen,
      setFolderId,
      setFolderMenuOpen,
      setSearchScope,
      setSearchScopeMenuOpen,
      setSourceFilters,
      startWindowDrag,
    },
    workspaceProps,
    footerStatusProps: {
      statusSpaceId: currentStatusSpaceArg,
      refreshStatus,
      dismissFailedJobs,
      dismissingFailedJobs,
      indexDetailsOpen,
      indexJobTypeLabel,
      indexStatus,
      operationStatus,
      refreshIndex,
      retryFailedJobs,
      retryingFailedJobs,
      spaces,
      setIndexDetailsOpen,
      setShowConnection,
      startWindowDrag,
      syncing,
      versionLabel: "v85",
      flashcardsActive,
      mobileNavigation: isMobileLayout ? <MobileNavigation
        active={flashcardsActive ? "review" : mobileAgentsOpen ? "agents" : mobileBrowseOpen || mobileConnectionsOpen || (["favorites", "history", "journals", "tags", "collections", "insights"] as DesktopSidebarView[]).includes(desktopSidebarView) ? "browse" : tasksActive ? "tasks" : "search"}
        onSelect={navigateMobile}
        dueCount={flashcardDueCount}
      /> : undefined,
    },
    settingsDialog: <>
      {isMobileLayout && <JournalVoiceHost onOpen={() => setQuickCaptureOpen(false)} />}
      {isMobileLayout && quickCaptureOpen && <Suspense fallback={null}><LazyMobileQuickCapture onClose={() => setQuickCaptureOpen(false)} onSaved={savedMobileCapture} onSyncSettings={openCaptureSyncSettings} /></Suspense>}
      {showConnection ? (
      <Suspense fallback={<div className="connection-overlay"><div className="settings-lazy-loading">正在打开设置…</div></div>}>
        <LazySettingsDialog
          mobile={isMobileLayout}
          canClose={!iconCrop}
          externalModalOpen={Boolean(iconCrop)}
          category={settingsCategory}
          onCategoryChange={setSettingsCategory}
          onClose={() => setShowConnection(false)}
        >
          <LazySettingsContent {...settingsContentProps} />
          {iconCrop && <LibraryIconCrop source={iconCrop.source} name={iconCrop.space.name} onCancel={()=>setIconCrop(null)} onSave={iconSvg => commitLibraryIcon(iconCrop.space, iconSvg)}/>}
        </LazySettingsDialog>
      </Suspense>
      ) : null}
      {createJournalDate && <CreateJournalDialog
        date={createJournalDate}
        spaces={spaces}
        creating={creatingJournal}
        onClose={() => setCreateJournalDate("")}
        onCreate={(libraryIds) => void createSelectedJournals(libraryIds)}
      />}
      <CommandPalette
        open={commandPaletteOpen}
        mode={commandPaletteMode}
        commands={commandPaletteItems}
        shortcutGroups={shortcutHelpGroups}
        onModeChange={setCommandPaletteMode}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </>,
    desktopSidebarProps: desktopSidebarEnabled && !isMobileLayout ? {
      activeView: desktopSidebarView,
      smartCollections,
      activeSmartCollectionId,
      currentSearchCanBeSaved: Boolean(query.trim() || activeFilterCount > 0 || selectedLibraryIds !== null),
      spaces,
      selectedLibraryIds,
      libraryFacetCounts: appSettings.dynamicFacetCountsEnabled ? dynamicFacets.libraries : undefined,
      facetCountsTruncated: appSettings.dynamicFacetCountsEnabled && dynamicFacets.truncated,
      renderLibraryIcon: renderCompactLibraryIcon,
      onSelectView: selectDesktopSidebarView,
      onToggleLibrary: toggleLibrarySelection,
      onToggleAllLibraries: toggleAllLibraries,
      onSelectLibraryOnly: selectOnlyLibrary,
      onSelectAllLibrariesOnly: selectAllLibraries,
      onManageLibraries: openDesktopLibraryManagement,
      favoriteCount: favoriteResults.length,
      favoriteResults,
      viewHistory,
      onOpenPinnedLibrary: openPinnedLibrary,
      onOpenPinnedResult: openPinnedResult,
      taskOpenCount,
      journalCount: journalSummary.count,
      journalDates,
      selectedJournalDate,
      onSelectJournalDate: selectDesktopJournalDate,
      historyCount: viewHistory.length,
      flashcardDueCount,
      tags: displayedSidebarTags,
      selectedTag: selectedSidebarTag,
      tagOverviewMode,
      favoriteTags: favoriteSidebarTags,
      recentTags: recentSidebarTags,
      customTagGroups: sidebarTagGroups,
      tagProperties,
      tagsLoading,
      onSelectTagsOverview: selectSidebarTagOverview,
      onSelectCleanupTags: selectSidebarTagCleanup,
      onSelectTag: selectDesktopSidebarTag,
      onToggleFavoriteTag: toggleFavoriteSidebarTag,
      onCreateTagGroup: createSidebarTagGroup,
      onDeleteTagGroup: deleteSidebarTagGroup,
      onAssignTagToGroup: assignSidebarTagToGroup,
      onCreateSmartCollection: addSmartCollection,
      onApplySmartCollection: applySmartCollection,
      onRenameSmartCollection: renameSmartCollection,
      onDeleteSmartCollection: deleteSmartCollection,
      onCollapse: collapseDesktopSidebar,
    } : undefined,
  };

  return <AgentPanelProvider><TaskStatusStyleProvider style={appSettings.taskStatusStyle}><JournalViewsContext.Provider value={journalViewStore}><JournalRecordsProvider enabled={runtimeCapabilities.desktop && desktopSidebarView === "journals"} dataVersion={journalDataVersion(indexStatus, currentSpaceIds)} scope={currentSpaceIds}><IsolatedRuntimeProbe /><CollectionViewsProvider><GlobalExclusionReviewProvider active={runtimeCapabilities.desktop}><AppLayout {...appLayoutProps} /></GlobalExclusionReviewProvider></CollectionViewsProvider></JournalRecordsProvider></JournalViewsContext.Provider></TaskStatusStyleProvider></AgentPanelProvider>;
}

function App() {
  return <UnifiedTaskProvider dataVersion="app-session"><AppContent /></UnifiedTaskProvider>;
}

export default App;

