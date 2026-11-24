import { userProfileStorage } from "./UserProfileStorage";
import { LibraryStatusIcon } from "./LibraryStatusIcon";
import { providerUnavailableHint } from "./ProviderLabels";
import { GlobalExclusionReviewNotice } from "./GlobalExclusionReviewReminder";
import {
  Check,
  CalendarDays,
  ChevronDown,
  ChevronRight,
  Clock3,
  FolderTree,
  Hash,
  Bookmark,
  BookOpenCheck,
  MoreHorizontal,
  ListTodo,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  ShieldCheck,
  Star,
  Tags,
  Trash2,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { SidebarPinnedSection } from "./SidebarPinnedSection";
import { smartCollectionSourceLabel, type SmartCollection } from "./SmartCollections";
import { CollectionNavigation } from "./CollectionNavigation";
import { resolveTagColor, type TagUserPropertyMap } from "./TagProperties";
import { JournalNavigation } from "./JournalNavigation";
import {
  buildSidebarTagNavigation,
  filterSidebarTags,
  type SidebarTagGroup,
  type SidebarTagSummary,
} from "./DesktopSidebarPresentation";

export { tagCleanupReason } from "./DesktopSidebarPresentation";
export type { SidebarTagGroup, SidebarTagSummary } from "./DesktopSidebarPresentation";

const SIDEBAR_LIBRARIES_COLLAPSED_KEY = "hub.desktop.sidebar.libraries-collapsed";

function loadLibrariesCollapsed(): boolean {
  try {
    return userProfileStorage.getItem(SIDEBAR_LIBRARIES_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

type SidebarLibraryPanelProps = Pick<DesktopSidebarProps,
  | "spaces"
  | "libraryFacetCounts"
  | "facetCountsTruncated"
  | "selectedLibraryIds"
  | "renderLibraryIcon"
  | "onToggleLibrary"
  | "onToggleAllLibraries"
  | "onManageLibraries"
>;

const SidebarLibraryPanel = memo(function SidebarLibraryPanel({
  spaces,
  libraryFacetCounts,
  facetCountsTruncated = false,
  selectedLibraryIds,
  renderLibraryIcon,
  onToggleLibrary,
  onToggleAllLibraries,
  onManageLibraries,
}: SidebarLibraryPanelProps) {
  const [librariesCollapsed, setLibrariesCollapsed] = useState(loadLibrariesCollapsed);
  const [libraryMenuOpen, setLibraryMenuOpen] = useState(false);
  const libraryMenuRef = useRef<HTMLDivElement>(null);
  const selectedLibraryCount = selectedLibraryIds === null ? spaces.length : selectedLibraryIds.length;
  const allLibrariesSelected = spaces.length > 0 && selectedLibraryIds === null;
  const selectedLibraryIdSet = useMemo(
    () => selectedLibraryIds === null ? null : new Set(selectedLibraryIds),
    [selectedLibraryIds],
  );
  const updateLibrariesCollapsed = (next: boolean) => {
    setLibrariesCollapsed(next);
    try {
      userProfileStorage.setItem(SIDEBAR_LIBRARIES_COLLAPSED_KEY, String(next));
    } catch {
      // The sidebar still works when persistent browser storage is unavailable.
    }
  };
  useEffect(() => {
    if (!libraryMenuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!libraryMenuRef.current?.contains(event.target as Node)) setLibraryMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setLibraryMenuOpen(false);
      libraryMenuRef.current?.querySelector<HTMLButtonElement>(".sidebar-library-more")?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [libraryMenuOpen]);

  return (
    <div className={`sidebar-library-panel${librariesCollapsed ? " collapsed" : ""}`}>
      <div className="sidebar-section-heading sidebar-library-heading">
        <button
          className="sidebar-library-disclosure"
          onClick={() => updateLibrariesCollapsed(!librariesCollapsed)}
          title={librariesCollapsed ? "展开资料库" : "折叠资料库"}
          aria-expanded={!librariesCollapsed}
        >
          {librariesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <span>资料库</span>
          <small aria-label={`已选择 ${selectedLibraryCount} 个，共 ${spaces.length} 个`}>{selectedLibraryCount}/{spaces.length}</small>
        </button>
        <span className="sidebar-library-heading-actions">
          {!allLibrariesSelected && spaces.length > 0 && (
            <button className="sidebar-library-select-all-shortcut" onClick={onToggleAllLibraries} title="选择全部资料库">全选</button>
          )}
          <div className="sidebar-library-menu-wrap" ref={libraryMenuRef}>
            <button
              className={`sidebar-library-more${libraryMenuOpen ? " active" : ""}`}
              onClick={() => setLibraryMenuOpen((open) => !open)}
              title="更多资料库操作"
              aria-label="更多资料库操作"
              aria-haspopup="menu"
              aria-expanded={libraryMenuOpen}
            >
              <MoreHorizontal size={15} />
            </button>
            {libraryMenuOpen && (
              <div className="sidebar-library-menu" role="menu" aria-label="资料库操作" data-hub-keyboard-scope="sidebar-library-menu" data-keyboard-open="true">
                <button type="button" role="menuitem" disabled={spaces.length === 0} onClick={() => { onToggleAllLibraries(); setLibraryMenuOpen(false); }}>
                  <Check size={14} aria-hidden="true" />
                  <span>{allLibrariesSelected ? "取消全部选择" : "选择全部"}</span>
                </button>
                <div className="sidebar-library-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => { onManageLibraries(); setLibraryMenuOpen(false); }}>
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  <span>管理资料库…</span>
                </button>
              </div>
            )}
          </div>
        </span>
      </div>
      {!librariesCollapsed && <div className="sidebar-library-list">
        {spaces.map((space) => {
          const isSelected = selectedLibraryIdSet === null || selectedLibraryIdSet.has(space.id);
          return <button
            key={space.id}
            className={isSelected ? "selected" : ""}
            onClick={() => onToggleLibrary(space.id)}
            title={`${space.name} · ${libraryFacetCounts ? libraryFacetCounts[space.id] ?? 0 : space.documentCount ?? 0}${libraryFacetCounts && facetCountsTruncated ? "+" : ""} 篇${space.connected ? "" : ` · ${providerUnavailableHint(space.provider)}`}`}
            aria-pressed={isSelected}
          >
            <LibraryStatusIcon space={space}>{renderLibraryIcon(space)}</LibraryStatusIcon>
            <span className="sidebar-library-copy">
              <strong>{space.name}<em className="sidebar-provider-label">{space.provider === "obsidian" ? "Obsidian" : space.provider === "craft" ? "Craft" : space.provider === "feishu" ? "飞书" : "滴答"}</em></strong>
              <small>{libraryFacetCounts ? libraryFacetCounts[space.id] ?? 0 : space.documentCount ?? 0}{libraryFacetCounts && facetCountsTruncated ? "+" : ""}</small>
            </span>
            <span className={`sidebar-library-dot ${space.provider}`} aria-hidden="true" />
          </button>;
        })}
      </div>}
    </div>
  );
});

export type DesktopSidebarView = "home" | "tasks" | "journals" | "favorites" | "history" | "tags" | "flashcards" | "collections" | "insights" | "libraries";

type DesktopSidebarProps = {
  contextualTitle?: string;
  activeView: DesktopSidebarView;
  smartCollections: SmartCollection[];
  activeSmartCollectionId: string;
  currentSearchCanBeSaved: boolean;
  spaces: LibrarySummary[];
  libraryFacetCounts?: Record<string, number>;
  facetCountsTruncated?: boolean;
  selectedLibraryIds: string[] | null;
  renderLibraryIcon: (space: LibrarySummary) => ReactNode;
  onSelectView: (view: DesktopSidebarView) => void;
  onToggleLibrary: (libraryId: string) => void;
  onToggleAllLibraries: () => void;
  onSelectLibraryOnly?: (libraryId: string) => void;
  onSelectAllLibrariesOnly?: () => void;
  onManageLibraries: () => void;
  favoriteCount: number;
  favoriteResults?: SearchResult[];
  viewHistory?: SearchResult[];
  onOpenPinnedLibrary?: (libraryId: string) => void;
  onOpenPinnedResult?: (result: SearchResult) => void;
  taskOpenCount: number;
  journalCount: number;
  journalDates: Array<{ date: string; sources: number }>;
  selectedJournalDate: string;
  onSelectJournalDate: (date: string) => void;
  historyCount: number;
  flashcardDueCount: number;
  tags: SidebarTagSummary[];
  selectedTag: string;
  tagOverviewMode: "all" | "cleanup";
  favoriteTags: string[];
  recentTags: string[];
  customTagGroups: SidebarTagGroup[];
  tagProperties: TagUserPropertyMap;
  tagsLoading: boolean;
  onSelectTagsOverview: () => void;
  onSelectCleanupTags: () => void;
  onSelectTag: (tag: SidebarTagSummary) => void;
  onToggleFavoriteTag: (normalizedName: string) => void;
  onCreateTagGroup: (name: string) => void;
  onDeleteTagGroup: (groupId: string) => void;
  onAssignTagToGroup: (normalizedName: string, groupId: string | null) => void;
  onCreateSmartCollection: (name: string) => boolean;
  onApplySmartCollection: (collection: SmartCollection) => void;
  onRenameSmartCollection: (id: string, name: string) => boolean;
  onDeleteSmartCollection: (id: string) => void;
  onCollapse: () => void;
};

export const DesktopSidebar = memo(function DesktopSidebar({
  activeView,
  smartCollections,
  activeSmartCollectionId,
  currentSearchCanBeSaved,
  spaces,
  libraryFacetCounts,
  facetCountsTruncated = false,
  selectedLibraryIds,
  renderLibraryIcon,
  onSelectView,
  onToggleLibrary,
  onToggleAllLibraries,
  onManageLibraries,
  favoriteCount,
  favoriteResults,
  viewHistory,
  onOpenPinnedLibrary,
  onOpenPinnedResult,
  taskOpenCount,
  journalCount,
  journalDates,
  selectedJournalDate,
  onSelectJournalDate,
  historyCount,
  flashcardDueCount,
  tags,
  selectedTag,
  tagOverviewMode,
  favoriteTags,
  recentTags,
  customTagGroups,
  tagProperties,
  tagsLoading,
  onSelectTagsOverview,
  onSelectCleanupTags,
  onSelectTag,
  onToggleFavoriteTag,
  onCreateTagGroup,
  onDeleteTagGroup,
  onAssignTagToGroup,
  onCreateSmartCollection,
  onApplySmartCollection,
  onRenameSmartCollection,
  onDeleteSmartCollection,
  onCollapse,
  contextualTitle,
}: DesktopSidebarProps) {
  const [tagFilter, setTagFilter] = useState("");
  const [commonOpen, setCommonOpen] = useState(true);
  const [recentOpen, setRecentOpen] = useState(true);
  const [customGroupsOpen, setCustomGroupsOpen] = useState(true);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [openTagMenu, setOpenTagMenu] = useState("");
  const [tagSection, setTagSection] = useState<"fixed" | "hierarchy" | "custom">("fixed");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [creatingSmartCollection, setCreatingSmartCollection] = useState(false);
  const [smartCollectionName, setSmartCollectionName] = useState("");
  const [openSmartCollectionMenu, setOpenSmartCollectionMenu] = useState("");
  const [renamingSmartCollectionId, setRenamingSmartCollectionId] = useState("");
  const [smartCollectionNameDraft, setSmartCollectionNameDraft] = useState("");
  const libraryNameById = useMemo(() => new Map(spaces.map((space) => [space.id, space.name])), [spaces]);
  const {
    favoriteTagSet,
    customGroupByTag,
    customGroupTagItems,
    favoriteTagItems,
    tagGroups,
    commonTags,
    recentTagItems,
  } = useMemo(
    () => buildSidebarTagNavigation(tags, favoriteTags, recentTags, customTagGroups),
    [customTagGroups, favoriteTags, recentTags, tags],
  );
  const visibleTags = useMemo(() => filterSidebarTags(tags, tagFilter), [tagFilter, tags]);

  const selectTag = (tag: SidebarTagSummary) => {
    setTagFilter("");
    onSelectTag(tag);
  };
  const toggleFavorite = (event: MouseEvent<HTMLButtonElement>, normalizedName: string) => {
    event.stopPropagation();
    onToggleFavoriteTag(normalizedName);
  };
  const submitNewGroup = () => {
    const name = newGroupName.trim();
    if (!name) return;
    onCreateTagGroup(name);
    setNewGroupName("");
    setCreatingGroup(false);
  };
  const submitSmartCollection = () => {
    if (!onCreateSmartCollection(smartCollectionName)) return;
    setSmartCollectionName("");
    setCreatingSmartCollection(false);
  };
  const submitSmartCollectionRename = () => {
    if (!renamingSmartCollectionId || !onRenameSmartCollection(renamingSmartCollectionId, smartCollectionNameDraft)) return;
    setRenamingSmartCollectionId("");
    setSmartCollectionNameDraft("");
  };
  const smartCollectionSummary = (collection: SmartCollection) => {
    const details = [collection.query ? `“${collection.query}”` : "无关键词"];
    details.push(smartCollectionSourceLabel(collection.sourceFilters));
    if (collection.dateFilter !== "any") details.push(`近 ${collection.dateFilter} 天`);
    if (collection.folderLabel) details.push(collection.folderLabel);
    if (collection.libraryIds !== null) {
      const names = collection.libraryIds.flatMap((id) => libraryNameById.get(id) ?? []);
      details.push(names.length === 1 ? names[0] : `${names.length || collection.libraryIds.length} 个资料库`);
    }
    return details.join(" · ");
  };
  const renderTagRow = (tag: SidebarTagSummary, label = tag.name, instanceKey = tag.normalizedName) => {
    const favorite = favoriteTagSet.has(tag.normalizedName);
    const currentGroupId = customGroupByTag.get(tag.normalizedName);
    const color = resolveTagColor(tagProperties, tag.normalizedName);
    return (
      <div
        className={`sidebar-tag-row ${selectedTag === tag.normalizedName ? "selected" : ""}`}
        draggable onDragStart={event=>{event.dataTransfer.setData("application/x-hub-tag",JSON.stringify({tagId:tag.normalizedName,label:tag.name}));event.dataTransfer.effectAllowed="copy";}}
        key={instanceKey}
        style={{ "--tag-color": color } as CSSProperties}
      >
        <button className="sidebar-tag-open" onClick={() => selectTag(tag)} title={`#${tag.name} · ${tag.count}${facetCountsTruncated ? "+" : ""} 项`}>
          <i className="sidebar-tag-dot" aria-hidden="true" />
          <span className="sidebar-tag-name">{label}</span>
          <small>{tag.count}{facetCountsTruncated ? "+" : ""}</small>
        </button>
        <button
          className={`sidebar-tag-favorite ${favorite ? "active" : ""}`}
          onClick={(event) => toggleFavorite(event, tag.normalizedName)}
          aria-label={favorite ? `取消收藏 ${tag.name}` : `收藏 ${tag.name}`}
          title={favorite ? "取消收藏标签" : "收藏标签"}
        >
          <Star size={13} fill={favorite ? "currentColor" : "none"} />
        </button>
        <button
          className={`sidebar-tag-more ${openTagMenu === instanceKey ? "active" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            setOpenTagMenu((current) => current === instanceKey ? "" : instanceKey);
          }}
          aria-label={`整理 ${tag.name}`}
          title="整理标签"
        >
          <MoreHorizontal size={14} />
        </button>
        {openTagMenu === instanceKey && (
          <div className="sidebar-tag-menu" role="menu" aria-label={`整理 ${tag.name}`}>
            <strong>移动到分组</strong>
            {customTagGroups.map((group) => (
              <button
                key={group.id}
                role="menuitem"
                onClick={() => {
                  onAssignTagToGroup(tag.normalizedName, currentGroupId === group.id ? null : group.id);
                  setOpenTagMenu("");
                }}
              >
                <span>{group.name}</span>
                {currentGroupId === group.id && <Check size={13} />}
              </button>
            ))}
            {customTagGroups.length === 0 && <small>还没有自定义分组</small>}
            <button
              role="menuitem"
              className="sidebar-tag-menu-create"
              onClick={() => {
                setCreatingGroup(true);
                setCustomGroupsOpen(true);
                setOpenTagMenu("");
              }}
            >
              <Plus size={13} /><span>新建分组…</span>
            </button>
          </div>
        )}
      </div>
    );
  };
  const renderSectionHeading = (
    label: string,
    count: number,
    open: boolean,
    onToggle: () => void,
    icon?: ReactNode,
    title?: string,
  ) => (
    <button className="sidebar-tag-section-heading" onClick={onToggle} aria-expanded={open} title={title}>
      {icon}
      <span>{label}</span>
      {count > 0 && <small>{count}</small>}
      {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
    </button>
  );

  if (activeView === "collections") return (
    <aside className="desktop-sidebar view-collections" aria-label="阅读导航">
      <div className="desktop-sidebar-brand">
        <div className="sidebar-home"><strong>阅读</strong></div>
        <button className="sidebar-collapse workspace-panel-toggle" onClick={onCollapse} title="收起左侧边栏" aria-label="收起左侧边栏"><PanelLeftClose size={17} /></button>
      </div>
      <CollectionNavigation libraries={spaces} />
    </aside>
  );

  return (
    <aside className={`desktop-sidebar view-${activeView}`} aria-label="桌面侧边栏" onContextMenu={(event) => event.preventDefault()}>
      <div className="desktop-sidebar-brand">
        <button className="sidebar-home" onClick={() => onSelectView("home")} aria-label="返回首页">
          <strong>{contextualTitle ?? "Hub"}</strong>
        </button>
        <button className="sidebar-collapse workspace-panel-toggle" onClick={onCollapse} title="收起左侧边栏" aria-label="收起左侧边栏">
          <PanelLeftClose size={17} />
        </button>
      </div>

      <nav className="sidebar-primary-nav" aria-label="浏览视图">
        <button onClick={() => onSelectView("collections")}><Bookmark size={16} /><span>阅读</span></button>
        <button className={activeView === "home" ? "active" : ""} onClick={() => onSelectView("home")}><Search size={16} /><span>全部内容</span></button>
        <button className={activeView === "libraries" ? "active" : ""} onClick={() => onSelectView("libraries")}><FolderTree size={16} /><span>资料库</span></button>
        <button className={activeView === "tasks" ? "active" : ""} onClick={() => onSelectView("tasks")}>
          <ListTodo size={16} /><span>任务</span>{taskOpenCount > 0 && <small>{taskOpenCount}</small>}
        </button>
        <button className={activeView === "journals" ? "active" : ""} onClick={() => onSelectView("journals")}>
          <CalendarDays size={16} /><span>日志</span>{journalCount > 0 && <small>{journalCount}</small>}
        </button>
        <button className={activeView === "favorites" ? "active" : ""} onClick={() => onSelectView("favorites")}>
          <Star size={16} /><span>收藏</span>{favoriteCount > 0 && <small>{favoriteCount}</small>}
        </button>
        <button className={activeView === "history" ? "active" : ""} onClick={() => onSelectView("history")}>
          <Clock3 size={16} /><span>最近浏览</span>{historyCount > 0 && <small>{historyCount}</small>}
        </button>
        <button className={activeView === "tags" ? "active" : ""} onClick={() => onSelectView("tags")}>
          <Tags size={16} /><span>标签</span>{tags.length > 0 && <small>{tags.length}</small>}
        </button>
        <button className={activeView === "flashcards" ? "active" : ""} onClick={() => onSelectView("flashcards")}>
          <BookOpenCheck size={16} /><span>闪卡复习</span>{flashcardDueCount > 0 && <small>{flashcardDueCount}</small>}
        </button>
      </nav>

      <div className="sidebar-context-scroll">
      {activeView === "journals" && <section className="sidebar-journal-navigation">
        <JournalNavigation
          dates={journalDates}
          selectedDate={selectedJournalDate}
          onSelectDate={onSelectJournalDate}
        />
      </section>}

      {activeView !== "tags" && activeView !== "flashcards" && (
        <SidebarPinnedSection
          spaces={spaces}
          smartCollections={smartCollections}
          favoriteResults={favoriteResults}
          viewHistory={viewHistory}
          onApplySmartCollection={onApplySmartCollection}
          onOpenPinnedLibrary={onOpenPinnedLibrary}
          onOpenPinnedResult={onOpenPinnedResult}
        />
      )}

      {activeView === "tags" && (
        <section className="sidebar-tags" aria-label="标签导航">
          <div className="sidebar-tags-heading">
            <strong>标签管理</strong>
            <button
              onClick={() => {
                setTagSection("custom");
                setCreatingGroup(true);
                setCustomGroupsOpen(true);
              }}
              title="新建标签分组"
              aria-label="新建标签分组"
            >
              <Plus size={15} />
            </button>
          </div>
          <div className="sidebar-tag-modes" role="tablist" aria-label="标签分类">
            <button className={tagSection === "fixed" ? "active" : ""} onClick={() => setTagSection("fixed")} role="tab" aria-selected={tagSection === "fixed"}>
              固定<small>{favoriteTagItems.length}</small>
            </button>
            <button className={tagSection === "hierarchy" ? "active" : ""} onClick={() => setTagSection("hierarchy")} role="tab" aria-selected={tagSection === "hierarchy"}>
              层级<small>{tagGroups.length}</small>
            </button>
            <button className={tagSection === "custom" ? "active" : ""} onClick={() => setTagSection("custom")} role="tab" aria-selected={tagSection === "custom"}>
              分组<small>{customTagGroups.length}</small>
            </button>
          </div>
          <label className="sidebar-tag-search">
            <Search size={14} />
            <input
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
              placeholder="搜索标签…"
              aria-label="搜索标签"
            />
            {tagFilter && <small>{visibleTags.length}</small>}
          </label>

          <div className="sidebar-tag-list">
            {tagsLoading && tags.length === 0 && <div className="sidebar-tag-empty">正在整理标签…</div>}
            {!tagsLoading && tags.length === 0 && <div className="sidebar-tag-empty">所选资料库中没有标签</div>}
            {tagFilter && tags.length > 0 && (
              <>
                <div className="sidebar-tag-search-summary">搜索结果</div>
                {visibleTags.map((tag) => renderTagRow(tag, tag.name, `search:${tag.normalizedName}`))}
                {visibleTags.length === 0 && <div className="sidebar-tag-empty">没有匹配标签</div>}
              </>
            )}
            {!tagFilter && tags.length > 0 && (
              <>
                  <div className="sidebar-tag-quick-links">
                    <button className={`sidebar-all-tags ${!selectedTag && tagOverviewMode === "all" ? "selected" : ""}`} onClick={onSelectTagsOverview}>
                      <Tags size={14} /><span>全部标签</span><small>{tags.length}</small>
                    </button>
                    <button className={`sidebar-cleanup-tags ${!selectedTag && tagOverviewMode === "cleanup" ? "selected" : ""}`} onClick={onSelectCleanupTags} title="用 Codex 检查全部标签，并审核整理建议">
                      <ShieldCheck size={14} /><span>全局健康检查</span>
                    </button>
                  </div>
                {tagSection === "fixed" && <>
                  <div className="sidebar-tag-static-heading"><Star size={13} /><span>固定标签</span><small>{favoriteTagItems.length}</small></div>
                  <div className="sidebar-tag-section pinned">
                    {favoriteTagItems.length > 0
                      ? favoriteTagItems.map((tag) => renderTagRow(tag, tag.name, `favorite:${tag.normalizedName}`))
                      : <div className="sidebar-tag-hint">点击标签属性中的星标可固定</div>}
                  </div>
                  {renderSectionHeading("常用标签", commonTags.length, commonOpen, () => setCommonOpen((value) => !value), <Hash size={13} />, "按当前资料库使用次数展示前 8 个")}
                  {commonOpen && <>
                    <div className="sidebar-tag-section">{commonTags.map((tag) => renderTagRow(tag, tag.name, `common:${tag.normalizedName}`))}</div>
                  </>}
                  {recentTagItems.length > 0 && <>
                    {renderSectionHeading("最近使用", recentTagItems.length, recentOpen, () => setRecentOpen((value) => !value), <Clock3 size={13} />)}
                    {recentOpen && <div className="sidebar-tag-section">{recentTagItems.map((tag) => renderTagRow(tag, tag.name, `recent:${tag.normalizedName}`))}</div>}
                  </>}
                </>}

                {tagSection === "hierarchy" && <div className="sidebar-tag-section sidebar-tag-groups">
                  {tagGroups.map((group) => {
                    const containsSelected = group.tags.some(({ tag }) => tag.normalizedName === selectedTag);
                    const expanded = expandedGroups[group.name] ?? containsSelected;
                    return <div className="sidebar-tag-group" key={group.name}>
                      <button className="sidebar-tag-group-heading" onClick={() => setExpandedGroups((current) => ({ ...current, [group.name]: !expanded }))} aria-expanded={expanded}>
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{group.name}</span><small>{group.tags.length}</small>
                      </button>
                      {expanded && <div className="sidebar-tag-group-items">
                        {group.tags.map(({ tag, label }) => renderTagRow(tag, label, `path:${group.name}:${tag.normalizedName}`))}
                      </div>}
                    </div>;
                  })}
                  {tagGroups.length === 0 && <div className="sidebar-tag-hint">使用“父级 / 子级”命名即可形成层级标签</div>}
                </div>}

                {tagSection === "custom" && <>
                  <div className="sidebar-custom-groups-heading">
                    <span>自定义分组</span>
                    <button className="sidebar-add-tag-group" onClick={() => { setCreatingGroup(true); setCustomGroupsOpen(true); }} title="新建标签分组" aria-label="新建标签分组"><Plus size={14} /></button>
                  </div>
                  {customGroupsOpen && <div className="sidebar-tag-section sidebar-tag-groups">
                    {creatingGroup && <div className="sidebar-new-tag-group">
                      <input value={newGroupName} onChange={(event) => setNewGroupName(event.target.value)} onKeyDown={(event) => {
                        if (event.key === "Enter") submitNewGroup();
                        if (event.key === "Escape") { setCreatingGroup(false); setNewGroupName(""); }
                      }} placeholder="分组名称" aria-label="分组名称" autoFocus />
                      <button onClick={submitNewGroup} aria-label="创建分组"><Check size={13} /></button>
                      <button onClick={() => { setCreatingGroup(false); setNewGroupName(""); }} aria-label="取消"><X size={13} /></button>
                    </div>}
                    {customTagGroups.map((group) => {
                      const groupTags = customGroupTagItems.get(group.id) ?? [];
                      const containsSelected = group.tagIds.includes(selectedTag);
                      const expanded = expandedGroups[`custom:${group.id}`] ?? containsSelected;
                      return <div className="sidebar-tag-group" key={group.id}>
                        <div className="sidebar-tag-group-row">
                          <button className="sidebar-tag-group-heading" onClick={() => setExpandedGroups((current) => ({ ...current, [`custom:${group.id}`]: !expanded }))} aria-expanded={expanded}>
                            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{group.name}</span><small>{groupTags.length}</small>
                          </button>
                          <button className="sidebar-delete-tag-group" onClick={() => onDeleteTagGroup(group.id)} title="删除分组，不会删除标签" aria-label={`删除分组 ${group.name}`}><Trash2 size={13} /></button>
                        </div>
                        {expanded && <div className="sidebar-tag-group-items">
                          {groupTags.length > 0 ? groupTags.map((tag) => renderTagRow(tag, tag.name, `custom:${group.id}:${tag.normalizedName}`)) : <div className="sidebar-tag-hint">从标签的 ··· 菜单加入</div>}
                        </div>}
                      </div>;
                    })}
                    {!creatingGroup && customTagGroups.length === 0 && <div className="sidebar-tag-hint">创建分组后，可从标签的 ··· 菜单加入</div>}
                  </div>}
                </>}
              </>
            )}
          </div>
        </section>
      )}

      <GlobalExclusionReviewNotice onOpen={onSelectCleanupTags} />
      <section className="sidebar-smart-collections" aria-label="智能集合">
        <div className="sidebar-smart-heading">
          <span><Bookmark size={13} /><strong>智能集合</strong>{smartCollections.length > 0 && <small>{smartCollections.length}</small>}</span>
          <button
            onClick={() => {
              setCreatingSmartCollection(true);
              setOpenSmartCollectionMenu("");
            }}
            disabled={!currentSearchCanBeSaved}
            title={currentSearchCanBeSaved ? "保存当前搜索和筛选" : "输入关键词或设置筛选后即可保存"}
            aria-label="保存当前搜索为智能集合"
          >
            <Plus size={14} />
          </button>
        </div>
        {creatingSmartCollection && (
          <div className="sidebar-smart-editor">
            <input
              autoFocus
              value={smartCollectionName}
              maxLength={60}
              placeholder="集合名称"
              aria-label="智能集合名称"
              onChange={(event) => setSmartCollectionName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitSmartCollection();
                if (event.key === "Escape") { setCreatingSmartCollection(false); setSmartCollectionName(""); }
              }}
            />
            <button onClick={submitSmartCollection} disabled={!smartCollectionName.trim()} aria-label="保存智能集合"><Check size={13} /></button>
            <button onClick={() => { setCreatingSmartCollection(false); setSmartCollectionName(""); }} aria-label="取消"><X size={13} /></button>
          </div>
        )}
        <div className="sidebar-smart-list">
          {smartCollections.map((collection) => (
            <div className={`sidebar-smart-row ${activeSmartCollectionId === collection.id ? "active" : ""}`} key={collection.id}>
              {renamingSmartCollectionId === collection.id ? (
                <div className="sidebar-smart-editor rename">
                  <input
                    autoFocus
                    value={smartCollectionNameDraft}
                    maxLength={60}
                    aria-label={`重命名 ${collection.name}`}
                    onChange={(event) => setSmartCollectionNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitSmartCollectionRename();
                      if (event.key === "Escape") { setRenamingSmartCollectionId(""); setSmartCollectionNameDraft(""); }
                    }}
                  />
                  <button onClick={submitSmartCollectionRename} disabled={!smartCollectionNameDraft.trim()} aria-label="保存名称"><Check size={13} /></button>
                  <button onClick={() => { setRenamingSmartCollectionId(""); setSmartCollectionNameDraft(""); }} aria-label="取消重命名"><X size={13} /></button>
                </div>
              ) : <>
                <button className="sidebar-smart-open" onClick={() => onApplySmartCollection(collection)} title={smartCollectionSummary(collection)}>
                  <Bookmark size={14} fill={activeSmartCollectionId === collection.id ? "currentColor" : "none"} />
                  <span><strong>{collection.name}</strong><small>{smartCollectionSummary(collection)}</small></span>
                </button>
                <button
                  className={`sidebar-smart-more ${openSmartCollectionMenu === collection.id ? "active" : ""}`}
                  onClick={() => setOpenSmartCollectionMenu((current) => current === collection.id ? "" : collection.id)}
                  title="管理智能集合"
                  aria-label={`管理 ${collection.name}`}
                ><MoreHorizontal size={14} /></button>
                {openSmartCollectionMenu === collection.id && (
                  <div className="sidebar-smart-menu" role="menu">
                    <button role="menuitem" onClick={() => {
                      setRenamingSmartCollectionId(collection.id);
                      setSmartCollectionNameDraft(collection.name);
                      setOpenSmartCollectionMenu("");
                    }}><Pencil size={13} /><span>重命名</span></button>
                    <button className="danger" role="menuitem" onClick={() => {
                      onDeleteSmartCollection(collection.id);
                      setOpenSmartCollectionMenu("");
                    }}><Trash2 size={13} /><span>删除</span></button>
                  </div>
                )}
              </>}
            </div>
          ))}
          {!creatingSmartCollection && smartCollections.length === 0 && (
            <div className="sidebar-smart-empty">设置关键词或筛选后，点击＋保存</div>
          )}
        </div>
      </section>

      </div>
      <SidebarLibraryPanel
        spaces={spaces}
        libraryFacetCounts={libraryFacetCounts}
        facetCountsTruncated={facetCountsTruncated}
        selectedLibraryIds={selectedLibraryIds}
        renderLibraryIcon={renderLibraryIcon}
        onToggleLibrary={onToggleLibrary}
        onToggleAllLibraries={onToggleAllLibraries}
        onManageLibraries={onManageLibraries}
      />
    </aside>
  );
});
