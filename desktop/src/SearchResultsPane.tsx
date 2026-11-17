import { useContext } from "react";
import { AgentPanelContext, AgentTagRequestContext } from "./StandaloneAgentLauncher";
import { userProfileStorage } from "./UserProfileStorage";
import { CalendarDays, Grid2X2, List, Plus, Search, Tags, TriangleAlert } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import type { CSSProperties, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { tagCleanupReason } from "./DesktopSidebar";
import type { SidebarTagSummary } from "./DesktopSidebar";
import { RecentResultList, type RecentGroup } from "./RecentResultList";
import { QuickSearchResultList } from "./QuickSearchResultList";
import { ResultContextMenu, type ResultContextMenuState } from "./ResultContextMenu";
import type { SearchResult } from "./SearchTypes";
import { TagPropertiesCard } from "./TagPropertiesCard";
import { TagGovernanceInbox } from "./TagGovernanceInbox";
import { TagAssignmentInbox } from "./TagAssignmentInbox";
import type { TagTaxonomySummary } from "./TagTaxonomy";
import { TagLibraryFilter } from "./TagLibraryFilter";
import type { LibrarySummary } from "./SearchTypes";
import { useResultContextMemory } from "./useResultContextMemory";
import { snippetFavoriteKey } from "./PageFavorites";
import { journalScopeTitle } from "./JournalPresentation";
import { JournalWorkspace } from "./JournalWorkspace";
import { useJournalViews } from "./JournalViews";

type SearchResultsPaneProps = {
  snippetFavoriteIds?: Set<string>;
  onToggleSnippetFavorite?: (result: SearchResult) => void;
  favoriteFilter?: "all" | "page" | "snippet";
  onFavoriteFilterChange?: (filter: "all" | "page" | "snippet") => void;
  navigationContext?: string;
  contextReady?: boolean;
  onRestoreSelection?: (index: number) => void;
  selectionManagedByData?: boolean;
  resultLabel: string;
  error: string;
  searching: boolean;
  query: string;
  results: SearchResult[];
  recentGroups: RecentGroup[];
  selectedIndex: number;
  showSelection?: boolean;
  isMobileLayout: boolean;
  semanticRecentDates: boolean;
  onHoverResult: (index: number) => void;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onPrepareResultLink: (result: SearchResult) => void;
  onDragResult: (event: ReactDragEvent, result: SearchResult) => void;
  onCopyResultLink: (result: SearchResult) => void | Promise<void>;
  onCopyResultMarkdown: (result: SearchResult) => void | Promise<void>;
  onCopyResultTitle: (result: SearchResult) => void | Promise<void>;
  onCopyResultSummary: (result: SearchResult) => void | Promise<void>;
  onRevealResult: (result: SearchResult) => void | Promise<void>;
  canRevealResult: (result: SearchResult) => boolean;
  onLocateInLibrary?: (result: SearchResult) => void;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  collectionView?: "journals" | "favorites" | "history" | "tags";
  collectionQuery?: string;
  selectedCollectionTag?: SidebarTagSummary;
  selectedTagColor?: string;
  selectedTagDescription?: string;
  selectedTagParent?: string;
  selectedTagAliases?: string[];
  selectedTagTaxonomy?: TagTaxonomySummary | null;
  selectedTagGroup?: string;
  selectedTagLibraryCount?: number;
  selectedTagLastUpdated?: string;
  selectedTagRelated?: Array<SidebarTagSummary & { color: string }>;
  selectedTagFavorite?: boolean;
  onChangeSelectedTagColor?: (color: string) => void;
  onChangeSelectedTagDescription?: (description: string) => void;
  onToggleSelectedTagFavorite?: () => void;
  onSelectedTagTaxonomyChanged?: () => void;
  collectionTags?: SidebarTagSummary[];
  collectionTagColors?: Record<string, string>;
  onSelectCollectionTag?: (tag: SidebarTagSummary) => void;
  tagOverviewMode?: "all" | "cleanup";
  tagLibraries?: LibrarySummary[];
  tagsLoading?: boolean;
  selectedTagLibraryIds?: string[] | null;
  onChangeTagLibraries?: (ids: string[] | null) => void;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (result: SearchResult) => void;
  onCreateJournal?: () => void;
  selectedJournalDate?: string;
  journalDataVersion?: string;
  journalSelectedKey?: string;
  onNavigateJournalDate?: (date: string) => void;
  onCreateJournalDate?: (date: string) => void;
  onClearJournalDate?: () => void;
  scopeLabel?: string;
  onClearScope?: () => void;
  onTagTabChange?: (management: boolean) => void;
  onPreviewEvidence?: (result: SearchResult) => void;
};

export function SearchResultsPane({
  snippetFavoriteIds, onToggleSnippetFavorite, favoriteFilter = "all", onFavoriteFilterChange,
  selectedJournalDate = "", onClearJournalDate, journalDataVersion = "", journalSelectedKey, onNavigateJournalDate, onCreateJournalDate,
  navigationContext = "", contextReady = true, onRestoreSelection, selectionManagedByData = false,
  resultLabel, error, searching, query, results, recentGroups, selectedIndex, showSelection = true,
  isMobileLayout, semanticRecentDates, onHoverResult, onSelectResult,
  onOpenResult, onPrepareResultLink, onDragResult, onCopyResultLink, onCopyResultMarkdown,
  onCopyResultTitle, onCopyResultSummary, onRevealResult, canRevealResult, onLocateInLibrary, renderLibraryIcon, collectionView, collectionQuery = "", selectedCollectionTag,
  collectionTags, onSelectCollectionTag, tagOverviewMode = "all", favoriteIds, onToggleFavorite,
  collectionTagColors = {},
  tagLibraries = [], tagsLoading = false, selectedTagLibraryIds = null, onChangeTagLibraries,
  selectedTagColor = "#4C8FD4", selectedTagDescription = "", selectedTagGroup = "未分组",
  selectedTagParent = "", selectedTagAliases = [], selectedTagTaxonomy,
  selectedTagLibraryCount = 0, selectedTagLastUpdated = "暂无", selectedTagRelated = [],
  selectedTagFavorite = false, onChangeSelectedTagColor, onChangeSelectedTagDescription,
  onToggleSelectedTagFavorite, onSelectedTagTaxonomyChanged, onCreateJournal,
  scopeLabel, onClearScope, onTagTabChange, onPreviewEvidence,
}: SearchResultsPaneProps) {
  const journalViews = useJournalViews();
  const resultMemory = useResultContextMemory(navigationContext, results, selectedIndex, contextReady && !searching, onRestoreSelection, selectionManagedByData);
  const [tagView, setTagView] = useState<{ tag: string; tab: "content" | "assignment" | "relations" }>({ tag: "", tab: "content" });
  const assistantPanel=useContext(AgentPanelContext),tagAssistant=useContext(AgentTagRequestContext);
  const tab = isMobileLayout ? "content" : tagView.tag === selectedCollectionTag?.normalizedName ? tagView.tab : "content";
  const tagPage = collectionView === "tags" && !!selectedCollectionTag && !query.trim();
  const showContent = !tagPage || tab === "content";
  const [tagSort, setTagSort] = useState<"name" | "count">("name");
  const [compact, setCompact] = useState(() => { try { return userProfileStorage.getItem("hub.results.compact") === "true"; } catch { return false; } });
  const [tagLayout, setTagLayout] = useState<"grid" | "list">("grid");
  const [contextMenu, setContextMenu] = useState<ResultContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openContextMenu = useCallback((event: ReactMouseEvent, result: SearchResult, index: number) => {
    event.preventDefault();
    event.stopPropagation();
    onSelectResult(index);
    if(result.provider==="hub"){setContextMenu(null);return;}
    onPrepareResultLink(result);
    setContextMenu({ result, x: event.clientX, y: event.clientY });
  }, [onPrepareResultLink, onSelectResult]);
  const showTagOverview = collectionView === "tags" && !selectedCollectionTag && !query.trim();
  const sortedCollectionTags = useMemo(() => [...(collectionTags ?? [])].sort((left, right) => (
    tagSort === "name"
      ? left.name.localeCompare(right.name, "zh-CN") || right.count - left.count
      : right.count - left.count || left.name.localeCompare(right.name, "zh-CN")
  )), [collectionTags, tagSort]);
  const emptyTitle = collectionView === "journals"
    ? selectedJournalDate ? `${journalScopeTitle(selectedJournalDate)}还没有日志` : "还没有日志页面"
    : collectionView === "favorites"
    ? collectionQuery.trim() ? "没有匹配的收藏" : favoriteFilter === "snippet" ? "当前范围没有收藏片段" : favoriteFilter === "page" ? "当前范围没有收藏页面" : "当前范围没有收藏"
    : collectionView === "history"
      ? "还没有浏览记录"
      : collectionView === "tags"
        ? selectedCollectionTag ? `#${selectedCollectionTag.name} 暂无匹配文档` : "从左侧选择一个标签"
        : "没有找到匹配内容";
  const emptyHint = collectionView === "journals"
    ? selectedJournalDate ? "选择日历中带圆点的日期，或返回全部日志。" : "Craft 日期页面和 Obsidian Journals 文件会显示在这里"
    : collectionView === "favorites"
    ? "可切换资料库查看其他收藏，或点击内容旁的星标添加收藏"
    : collectionView === "history"
      ? "打开或预览过的文档会出现在这里"
      : collectionView === "tags"
        ? selectedCollectionTag ? "可调整资料库或日期筛选范围" : "这里汇总 Craft、Obsidian 和滴答清单中的标签"
        : "尝试更短的关键词，或清除筛选条件";

  const searchLanding = !query.trim() && !collectionView;
  const collectionList = !query.trim() && (collectionView === "journals" || collectionView === "favorites" || collectionView === "history");
  const emptyResults = showContent && !error && !searching && !showTagOverview && results.length === 0;
  const displayedSelectedIndex = showSelection ? selectedIndex : -1;

  if (collectionView === "journals" && !query.trim() && journalViews) return <JournalWorkspace
    libraries={tagLibraries} scope={selectedTagLibraryIds} dataVersion={journalDataVersion}
    selectedDate={selectedJournalDate} selectedKey={journalSelectedKey} onNavigateDate={onNavigateJournalDate}
    onPreview={onPreviewEvidence ?? onOpenResult} onOpen={onOpenResult} onCreate={onCreateJournalDate}
    renderIcon={renderLibraryIcon} favoriteIds={favoriteIds} onFavorite={onToggleFavorite} />;

  return (
    <div ref={resultMemory.ref} onScroll={resultMemory.onScroll} className={`results-pane ${compact ? "compact-results" : ""} ${collectionView === "journals" ? "journal-results" : ""} ${searchLanding ? "search-home-results" : ""} ${collectionList ? "collection-list-results" : ""} ${emptyResults ? "empty-results" : ""} ${scopeLabel && scopeLabel !== "全部资料库" ? "scoped-results" : ""}`}>
      {collectionView === "favorites" && !query.trim() && <div className="favorite-kind-filter" role="group" aria-label="收藏类型">
        {([['all', '全部'], ['page', '页面'], ['snippet', '片段']] as const).map(([value, label]) => <button key={value} className="result-density" aria-pressed={favoriteFilter === value} onClick={() => onFavoriteFilterChange?.(value)}>{label}</button>)}
      </div>}
      {scopeLabel && scopeLabel !== "全部资料库" && <div className="workspace-scope"><span>当前范围：{scopeLabel}</span>{onClearScope && <button onClick={onClearScope}>查看全部资料库</button>}</div>}
      {collectionView === "tags" && selectedCollectionTag && !query.trim() && (
        <>
        <TagPropertiesCard
          tag={selectedCollectionTag}
          color={selectedTagColor}
          description={selectedTagDescription}
          parent={selectedTagParent}
          aliases={selectedTagAliases}
          taxonomy={selectedTagTaxonomy}
          groupLabel={selectedTagGroup}
          libraryCount={selectedTagLibraryCount}
          lastUpdatedLabel={selectedTagLastUpdated}
          relatedTags={selectedTagRelated}
          favorite={selectedTagFavorite}
          readOnly={isMobileLayout}
          onChangeColor={(color) => onChangeSelectedTagColor?.(color)}
          onChangeDescription={(description) => onChangeSelectedTagDescription?.(description)}
          onToggleFavorite={() => onToggleSelectedTagFavorite?.()}
          onSelectRelatedTag={(tag) => onSelectCollectionTag?.(tag)}
        />
        {!isMobileLayout && <nav className="tag-workspace-tabs" aria-label="标签工作区">
          {assistantPanel&&tagAssistant&&<button type="button" onClick={()=>{tagAssistant.setPending({tagId:selectedCollectionTag.normalizedName,label:selectedCollectionTag.name,task:tab==="relations"?"relations":tab==="assignment"?"missing":"definition"});assistantPanel(null);}}>交给标签助手</button>}
          {([['content', '内容'], ['assignment', '内容补标'], ['relations', '标签关系']] as const).map(([value, label]) => <button key={value} aria-current={tab === value ? 'page' : undefined} onClick={() => { setTagView({ tag: selectedCollectionTag.normalizedName, tab: value }); onTagTabChange?.(value !== "content"); }}>{label}</button>)}
        </nav>}
        {!isMobileLayout && <div hidden={tab !== "relations"}><TagGovernanceInbox tagId={selectedCollectionTag.normalizedName} onOpenEvidence={onPreviewEvidence ?? onOpenResult} onTaxonomyChanged={onSelectedTagTaxonomyChanged} /></div>}
        {!isMobileLayout && <div hidden={tab !== "assignment"}>
        <TagAssignmentInbox key={selectedCollectionTag.normalizedName} tagId={selectedCollectionTag.normalizedName} userDescription={selectedTagDescription} onOpenEvidence={onPreviewEvidence ?? onOpenResult} onChanged={onSelectedTagTaxonomyChanged} onDescriptionSaved={onChangeSelectedTagDescription} />

        </div>}
        </>
      )}
      {!isMobileLayout && showTagOverview && tagOverviewMode === "cleanup" && <TagGovernanceInbox onOpenEvidence={onPreviewEvidence ?? onOpenResult} />}
      {!isMobileLayout && showTagOverview && tagOverviewMode === "cleanup" && <TagAssignmentInbox key="global-assignments" onOpenEvidence={onPreviewEvidence ?? onOpenResult} onChanged={onSelectedTagTaxonomyChanged} />}
      {collectionView === "journals" && !query.trim() && <header className="journal-workspace-heading">
        <div className="journal-workspace-copy">
          <span className="journal-workspace-eyebrow">{selectedJournalDate.length === 10 ? `${selectedJournalDate.slice(0, 4)}年 · ${new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(`${selectedJournalDate}T12:00:00`))}` : "日常记录"}</span>
          <h1>{journalScopeTitle(selectedJournalDate)}</h1>
          <p role="status">{searching ? "正在读取日志…" : `${recentGroups.length} 天 · ${results.length} 篇日志`}</p>
        </div>
        <div className="journal-workspace-actions">
          {selectedJournalDate && onClearJournalDate && <button onClick={onClearJournalDate}>全部日志</button>}
          {results.length > 0 && <button aria-label={`显示模式：${compact ? "紧凑" : "详情"}，切换为${compact ? "详情" : "紧凑"}`} aria-pressed={compact} onClick={() => { setCompact(!compact); try { userProfileStorage.setItem("hub.results.compact", String(!compact)); } catch { /* Session preference remains usable. */ } }}>{compact ? "紧凑" : "详情"}</button>}
          {onCreateJournal && <button className="journal-create-action" onClick={onCreateJournal}><Plus size={15} />写这一天</button>}
        </div>
      </header>}
      {showContent && resultLabel && !(collectionView === "journals" && !query.trim()) && <div className={`section-label ${collectionView === "journals" ? "journal-section-label" : ""}`}>
        <span className="section-label-text">{resultLabel}</span>
        {!showTagOverview && results.length > 0 && <button className="result-density" aria-label={`显示模式：${compact ? "紧凑" : "详情"}，切换为${compact ? "详情" : "紧凑"}`} aria-pressed={compact} onClick={() => { setCompact(!compact); try { userProfileStorage.setItem("hub.results.compact", String(!compact)); } catch { /* Keep the selection for this session. */ } }}>{compact ? "紧凑" : "详情"}</button>}
        {collectionView === "journals" && results.length === 0 && onCreateJournal && (
          <button className="create-journal-trigger" onClick={onCreateJournal} title="新建这一天的日志" aria-label="新建这一天的日志"><Plus size={15} /></button>
        )}
      </div>}
      {error && <div className="message error-message">{error}</div>}
      {emptyResults && (
        <div className="empty-state">{collectionView === "journals" ? <CalendarDays size={30} /> : <Search size={30} />}<strong>{emptyTitle}</strong><span>{emptyHint}</span></div>
      )}
      {showTagOverview ? (
        <section className="tag-overview" aria-label="全部标签" aria-busy={tagsLoading}>
          <div className="tag-overview-heading">
            <div className="tag-overview-title">
              <strong>{tagOverviewMode === "cleanup" ? "待整理标签" : "全部标签"}</strong>
              <small>{collectionTags?.length ?? 0} 个</small>
              {tagOverviewMode === "cleanup" && <span><TriangleAlert size={13} />仅供整理参考，不修改原始资料</span>}
            </div>
            <div className="tag-overview-tools">
              {onChangeTagLibraries && tagLibraries.length > 0 && <TagLibraryFilter libraries={tagLibraries} selectedIds={selectedTagLibraryIds} onChange={onChangeTagLibraries} />}
              <select value={tagSort} onChange={(event) => setTagSort(event.target.value as "name" | "count")} aria-label="标签排序">
                <option value="name">按名称 A-Z</option>
                <option value="count">按使用频率</option>
              </select>
              <div className="tag-layout-switch" role="group" aria-label="标签布局">
                <button className={tagLayout === "grid" ? "active" : ""} onClick={() => setTagLayout("grid")} title="网格视图" aria-label="网格视图"><Grid2X2 size={15} /></button>
                <button className={tagLayout === "list" ? "active" : ""} onClick={() => setTagLayout("list")} title="列表视图" aria-label="列表视图"><List size={16} /></button>
              </div>
            </div>
          </div>
          {collectionTags?.length ? (
            <div className={`tag-overview-grid ${tagLayout}`}>
              {sortedCollectionTags.map((tag) => (
                  <button
                    key={tag.normalizedName}
                    draggable onDragStart={event=>{event.dataTransfer.setData("application/x-hub-tag",JSON.stringify({tagId:tag.normalizedName,label:tag.name}));event.dataTransfer.effectAllowed="copy";}}
                    onClick={() => onSelectCollectionTag?.(tag)}
                    style={{ "--tag-color": collectionTagColors[tag.normalizedName] ?? "#4C8FD4" } as CSSProperties}
                  >
                    <i className="tag-overview-dot" aria-hidden="true" />
                    <span>{tag.name}</span>
                    {tagOverviewMode === "cleanup" && <em>{tagCleanupReason(tag)}</em>}
                    <small>{tag.count}</small>
                  </button>
                ))}
            </div>
          ) : (
            <div className="empty-state"><Tags size={30} /><strong>{collectionQuery.trim() ? "没有匹配的标签" : "当前资料库暂无标签"}</strong></div>
          )}
        </section>
      ) : !showContent ? null : !query.trim() ? (
        <RecentResultList
          recentGroups={recentGroups}
          selectedIndex={displayedSelectedIndex}
          isMobileLayout={isMobileLayout}
          semanticRecentDates={semanticRecentDates}
          onHoverResult={searchLanding || collectionList ? () => undefined : onHoverResult}
          onSelectResult={onSelectResult}
          onOpenResult={onOpenResult}
          onContextResult={openContextMenu}
          onPrepareResultLink={onPrepareResultLink}
          onDragResult={onDragResult}
          renderLibraryIcon={renderLibraryIcon}
          favoriteIds={favoriteIds}
          snippetFavoriteIds={snippetFavoriteIds}
          onToggleFavorite={onToggleFavorite}
        />
      ) : (
        <QuickSearchResultList
          compact={compact}
          query={query}
          results={results}
          selectedIndex={displayedSelectedIndex}
          isMobileLayout={isMobileLayout}
          onHoverResult={onHoverResult}
          onSelectResult={onSelectResult}
          onOpenResult={onOpenResult}
          onContextResult={openContextMenu}
          onPrepareResultLink={onPrepareResultLink}
          onDragResult={onDragResult}
          renderLibraryIcon={renderLibraryIcon}
          favoriteIds={favoriteIds}
          snippetFavoriteIds={snippetFavoriteIds}
          onToggleSnippetFavorite={onToggleSnippetFavorite}
          onToggleFavorite={onToggleFavorite}
        />
      )}
      {contextMenu && <ResultContextMenu
        state={contextMenu}
        snippetSaved={snippetFavoriteIds?.has(snippetFavoriteKey(contextMenu.result))}
        onToggleSnippetFavorite={onToggleSnippetFavorite}
        canReveal={canRevealResult(contextMenu.result)}
        onClose={closeContextMenu}
        onOpen={onOpenResult}
        onCopyLink={onCopyResultLink}
        onCopyMarkdown={onCopyResultMarkdown}
        onCopyTitle={onCopyResultTitle}
        onCopySummary={onCopyResultSummary}
        onReveal={onRevealResult}
        onLocateInLibrary={onLocateInLibrary}
      />}
    </div>
  );
}
