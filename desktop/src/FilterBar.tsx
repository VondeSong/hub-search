import { CaseSensitive, Check, ChevronDown, Clock3, Folder, Layers3, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type SetStateAction } from "react";
import type { FolderSummary, LibrarySummary } from "./SearchTypes";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";

type DateFilter = "any" | "7" | "30" | "90";
type SearchScope = "all" | "title" | "title_heading";
import type { SourceFilters } from "./useLocalSearch";
import { normalizeSourceFilters } from "./SearchSourceFilters";

const sourceOptions = [["craft", "页面"], ["task", "任务"], ["pdf", "PDF"], ["media", "媒体"], ["attachment", "附件"], ["reading", "阅读"], ["flashcard", "闪卡"]] as const;

type FilterBarProps = {
  mobile?: boolean;
  visible?: boolean;
  activeSpaces: LibrarySummary[];
  dateFilter: DateFilter;
  dateMenuOpen: boolean;
  folderId: string;
  folderMenuOpen: boolean;
  folders: FolderSummary[];
  searchScope: SearchScope;
  searchScopeMenuOpen: boolean;
  selectedFolder?: FolderSummary;
  selectedLibraryIds: string[] | null;
  sourceFilters: SourceFilters;
  spaces: LibrarySummary[];
  syncing: boolean;
  sourceFacetCounts?: Partial<Record<keyof SourceFilters, number>>;
  folderFacetCounts?: Record<string, number>;
  facetTotal?: number;
  facetCountsTruncated?: boolean;
  refreshIndex: () => void;
  setDateFilter: Dispatch<SetStateAction<DateFilter>>;
  setDateMenuOpen: Dispatch<SetStateAction<boolean>>;
  setFolderId: Dispatch<SetStateAction<string>>;
  setFolderMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSearchScope: Dispatch<SetStateAction<SearchScope>>;
  setSearchScopeMenuOpen: Dispatch<SetStateAction<boolean>>;
  setSourceFilters: Dispatch<SetStateAction<SourceFilters>>;
  startWindowDrag: (event: ReactMouseEvent<HTMLElement>) => void;
};

export function SearchFilterSummary(props: FilterBarProps) {
  const { dateFilter, folderId, selectedFolder, searchScope, sourceFilters:storedSources, setDateFilter, setFolderId, setSearchScope, setSourceFilters } = props;
  const sourceFilters=normalizeSourceFilters(storedSources);
  return <WorkspaceFilterSummary filters={[
    ...(folderId ? [{ label: `文件夹：${selectedFolder?.path ?? "所选文件夹"}`, clear: () => setFolderId("") }] : []),
    ...(dateFilter !== "any" ? [{ label: `最近 ${dateFilter} 天`, clear: () => setDateFilter("any") }] : []),
    ...(searchScope !== "all" ? [{ label: searchScope === "title" ? "仅名称" : "名称与章节", clear: () => setSearchScope("all") }] : []),
    ...sourceOptions.filter(([key]) => !sourceFilters[key]).map(([key, label]) => ({ label: `排除${label}`, clear: () => setSourceFilters(current => ({ ...current, [key]: true })) })),
  ]} onReset={() => { setFolderId(""); setDateFilter("any"); setSearchScope("all"); setSourceFilters({ craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true }); }} />;
}

export function FilterBar({
  mobile = false,
  visible = true,
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
  sourceFilters:storedSources,
  spaces,
  syncing,
  sourceFacetCounts,
  folderFacetCounts,
  facetTotal = 0,
  facetCountsTruncated = false,
  refreshIndex,
  setDateFilter,
  setDateMenuOpen,
  setFolderId,
  setFolderMenuOpen,
  setSearchScope,
  setSearchScopeMenuOpen,
  setSourceFilters,
  startWindowDrag,
}: FilterBarProps) {
  const sourceFilters=normalizeSourceFilters(storedSources);
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false);
  const restorePickerFocus = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (mobile) event.currentTarget.closest(".scope-picker")?.querySelector<HTMLButtonElement>(".filter-control-button")?.focus();
  };
  useEffect(() => {
    if (visible) return;
    setSourceMenuOpen(false);
    setSearchScopeMenuOpen(false);
    setFolderMenuOpen(false);
    setDateMenuOpen(false);
  }, [visible, setDateMenuOpen, setFolderMenuOpen, setSearchScopeMenuOpen]);
  const enabledSources = sourceOptions.filter(([key]) => sourceFilters[key]);
  const sourceLabel = enabledSources.length === sourceOptions.length
    ? "全部类型"
    : enabledSources.length === 0
      ? "未选择类型"
      : enabledSources.length === 1
        ? enabledSources[0][1]
        : `${enabledSources.length} 种类型`;
  const hasActiveFilters = Boolean(folderId) || dateFilter !== "any" || searchScope !== "all" || enabledSources.length !== sourceOptions.length;
  const syncLabel = syncing ? "同步中" : selectedLibraryIds === null ? "更新全部资料库" : activeSpaces.length > 1 ? "更新所选资料库" : "更新当前资料库";
  return (
    <div className="filter-bar" onMouseDown={startWindowDrag}>
      <div className="scope-picker" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSearchScopeMenuOpen(false);
      }}>
        <button className="filter-chip filter-control-button scope-picker-button" aria-label={`搜索范围：${searchScope === "title" ? "名称" : searchScope === "title_heading" ? "名称与章节" : "全部字段"}`} aria-haspopup="listbox" aria-expanded={searchScopeMenuOpen} onClick={() => { setSourceMenuOpen(false); setFolderMenuOpen(false); setDateMenuOpen(false); setSearchScopeMenuOpen((open) => !open); }}>
          <CaseSensitive size={15} aria-hidden="true" />
          {mobile && <span className="mobile-filter-label">搜索范围</span>}
          <span className="filter-chip-value">{searchScope === "title" ? "名称" : searchScope === "title_heading" ? "名称与章节" : "全部字段"}</span>
          <ChevronDown className="filter-control-chevron" size={13} aria-hidden="true" />
        </button>
        {searchScopeMenuOpen && <div className="scope-menu" role="listbox" aria-label="搜索范围">
          {([
            ["all", "全部字段", "名称、章节标题、正文、路径等"],
            ["title", "名称", "只匹配名称"],
            ["title_heading", "名称与章节", "匹配名称或章节标题"],
          ] as const).map(([value, label, description]) =>
            <button key={value} role="option" aria-selected={searchScope === value} className={searchScope === value ? "active" : ""} onClick={(event) => { restorePickerFocus(event); setSearchScope(value); setSearchScopeMenuOpen(false); }}>
              <span><strong>{label}</strong><small>{description}</small></span>
              {searchScope === value && <Check size={15} />}
            </button>
          )}
        </div>}
      </div>
      <div className="scope-picker type-picker" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setSourceMenuOpen(false);
      }}>
        <button className="filter-chip filter-control-button scope-picker-button" aria-label={`内容类型：${sourceLabel}`} aria-haspopup="listbox" aria-expanded={sourceMenuOpen} onClick={() => { setSearchScopeMenuOpen(false); setFolderMenuOpen(false); setDateMenuOpen(false); setSourceMenuOpen((open) => !open); }}>
          <Layers3 size={15} aria-hidden="true" />
          {mobile && <span className="mobile-filter-label">内容类型</span>}
          <span className="filter-chip-value">{sourceLabel}</span>
          <ChevronDown className="filter-control-chevron" size={13} aria-hidden="true" />
        </button>
        {sourceMenuOpen && <div className="scope-menu compact-filter-menu source-menu" role="listbox" aria-label="内容类型" aria-multiselectable="true">
          {sourceOptions.map(([key, label]) => (
            <button key={key} role="option" aria-selected={sourceFilters[key]} className={sourceFilters[key] ? "active" : ""} onClick={() => setSourceFilters((current) => ({ ...normalizeSourceFilters(current), [key]: !normalizeSourceFilters(current)[key] }))}>
              <span><strong>{label}</strong></span>
              {sourceFacetCounts && <small className="facet-count">{sourceFacetCounts[key] ?? 0}{facetCountsTruncated ? "+" : ""}</small>}
              {sourceFilters[key] && <Check size={15} aria-hidden="true" />}
            </button>
          ))}
        </div>}
      </div>
      <div className="scope-picker folder-picker" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFolderMenuOpen(false);
      }}>
        <button className="filter-chip filter-control-button scope-picker-button" aria-label={`文件夹：${selectedFolder ? `${activeSpaces.length > 1 ? `${selectedFolder.libraryName} / ` : ""}${selectedFolder.path}` : "全部文件夹"}`} aria-haspopup="listbox" aria-expanded={folderMenuOpen} onClick={() => { setSourceMenuOpen(false); setSearchScopeMenuOpen(false); setDateMenuOpen(false); setFolderMenuOpen((open) => !open); }}>
          <Folder size={15} aria-hidden="true" />
          {mobile && <span className="mobile-filter-label">文件夹</span>}
          <span className="filter-chip-value">{selectedFolder ? `${activeSpaces.length > 1 ? `${selectedFolder.libraryName} / ` : ""}${selectedFolder.path}` : "全部文件夹"}</span>
          <ChevronDown className="filter-control-chevron" size={13} aria-hidden="true" />
        </button>
        {folderMenuOpen && <div className="scope-menu compact-filter-menu folder-menu" role="listbox" aria-label="文件夹">
          <button role="option" aria-selected={!folderId} className={!folderId ? "active" : ""} onClick={(event) => { restorePickerFocus(event); setFolderId(""); setFolderMenuOpen(false); }}>
            <span><strong>全部文件夹</strong></span>{folderFacetCounts && <small className="facet-count">{facetTotal}{facetCountsTruncated ? "+" : ""}</small>}{!folderId && <Check size={15} />}
          </button>
          {folders.map((folder) => {
            const value = `${folder.spaceId}\u0000${folder.id}`;
            const selected = folderId === value || folderId === folder.id;
            return <button key={`${folder.spaceId}:${folder.id}`} role="option" aria-selected={selected} className={selected ? "active" : ""} title={folder.path} onClick={(event) => { restorePickerFocus(event); setFolderId(value); setFolderMenuOpen(false); }}>
              <span>
                <strong>{folder.name || folder.path}</strong>
                <small>{activeSpaces.length > 1 ? `${folder.libraryName} / ${folder.path}` : folder.path}</small>
              </span>
              {folderFacetCounts && <small className="facet-count">{folderFacetCounts[value] ?? 0}{facetCountsTruncated ? "+" : ""}</small>}
              {selected && <Check size={15} />}
            </button>;
          })}
        </div>}
      </div>
      <div className="scope-picker date-picker" onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDateMenuOpen(false);
      }}>
        <button className="filter-chip filter-control-button scope-picker-button" aria-label={`修改时间：${dateFilter === "any" ? "不限" : `最近 ${dateFilter} 天`}`} aria-haspopup="listbox" aria-expanded={dateMenuOpen} onClick={() => { setSourceMenuOpen(false); setSearchScopeMenuOpen(false); setFolderMenuOpen(false); setDateMenuOpen((open) => !open); }}>
          <Clock3 size={15} aria-hidden="true" />
          {mobile && <span className="mobile-filter-label">修改时间</span>}
          <span className="filter-chip-value">{dateFilter === "any" ? "不限" : `最近 ${dateFilter} 天`}</span>
          <ChevronDown className="filter-control-chevron" size={13} aria-hidden="true" />
        </button>
        {dateMenuOpen && <div className="scope-menu compact-filter-menu date-menu" role="listbox" aria-label="修改时间">
          {([["any", "不限"], ["7", "最近 7 天"], ["30", "最近 30 天"], ["90", "最近 90 天"]] as const).map(([value, label]) =>
            <button key={value} role="option" aria-selected={dateFilter === value} className={dateFilter === value ? "active" : ""} onClick={(event) => { restorePickerFocus(event); setDateFilter(value); setDateMenuOpen(false); }}>
              <span><strong>{label}</strong></span>{dateFilter === value && <Check size={15} />}
            </button>
          )}
        </div>}
      </div>
      {hasActiveFilters && <button className="filter-reset" onClick={() => { setFolderId(""); setDateFilter("any"); setSearchScope("all"); setSourceFilters({ craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true }); }}>{mobile ? "重置筛选" : "清除"}</button>}
      <button className="sync-button filter-sync-icon" title={syncLabel} aria-label={syncLabel} onClick={refreshIndex} disabled={syncing || !spaces.some((space) => space.connected)}>
        {syncing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
        {mobile && <span>{syncLabel}</span>}
      </button>
    </div>
  );
}
