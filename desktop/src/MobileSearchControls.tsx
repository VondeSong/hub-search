import { useEffect, useState, type ComponentProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ListFilter } from "lucide-react";
import type { FilterBar } from "./FilterBar";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";
import type { FolderSummary, LibrarySummary, SearchResult } from "./SearchTypes";
import type { SourceFilters } from "./useLocalSearch";
import { normalizeSourceFilters } from "./SearchSourceFilters";

type Filters = ComponentProps<typeof FilterBar>;
const types = [["craft", "资料"], ["task", "任务"], ["pdf", "PDF"], ["media", "媒体"], ["attachment", "附件"], ["reading", "阅读"], ["flashcard", "闪卡"]] as const;
const allTypes: SourceFilters = { craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true };

export function MobileSearchControls({ filters, results, onSelectLibraries, onOpenFilters }: { filters: Filters; results?: SearchResult[]; onSelectLibraries?: (ids: string[] | null) => void;onOpenFilters?:()=>void }) {
  const resolvedSources=normalizeSourceFilters(filters.sourceFilters);
  const all = Object.values(resolvedSources).every(Boolean);
  const selectedType = all ? "all" : types.find(([id]) => resolvedSources[id] && Object.values(resolvedSources).filter(Boolean).length === 1)?.[0] ?? "custom";
  // The native library facets exclude reading and flashcards. Count the current result set.
  const counts = { all: 0, craft: 0, task: 0, pdf: 0, media: 0, attachment: 0, reading: 0, flashcard: 0 };
  for (const hit of results ?? []) {
    const type = hit.contentType;
    const kind = type === "reading" || type === "flashcard" ? type
      : type === "dida_task" ? "task" : type.startsWith("pdf_") ? "pdf"
      : type === "image_ocr" || type === "media_attachment" ? "media"
      : type === "file_attachment" ? "attachment" : "craft";
    counts[kind]++;
    counts.all++;
  }
  const scopeSummary = filters.selectedFolder
    ? `${filters.selectedFolder.libraryName} / ${filters.selectedFolder.path}`
    : filters.selectedLibraryIds === null
      ? "全部资料库"
      : filters.selectedLibraryIds.length === 0
        ? `未选资料库 (0/${filters.spaces.length})`
        : filters.activeSpaces.length === 1
          ? filters.activeSpaces[0].name
          : `已选 ${filters.activeSpaces.length}/${filters.spaces.length} 库`;
  const scopeFiltered = filters.selectedLibraryIds !== null || Boolean(filters.folderId);
  return <div className="mobile-search-facets">
    <div className="mobile-search-compact-filters"><button type="button" className={scopeFiltered ? "is-filtered" : undefined} onClick={onOpenFilters} aria-label="选择搜索资料范围">{scopeSummary}<ChevronDown size={13}/></button>
    <select className="mobile-search-type-select" aria-label="内容类型" value={selectedType} onChange={event => filters.setSourceFilters(event.target.value === "all" ? { ...allTypes } : Object.fromEntries(types.map(([id]) => [id, id === event.target.value])) as SourceFilters)}>
      <option value="all">全部类型</option>{selectedType === "custom" && <option value="custom">自定义类型</option>}{types.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select><button type="button" aria-label="更多搜索筛选" onClick={onOpenFilters}><ListFilter size={18}/></button></div>
    <nav className="bw-tabs bw-search-types" aria-label="搜索内容类型">{([["all","全部"],...types] as const).map(([id,label])=><button key={id} type="button" aria-pressed={selectedType===id} onClick={()=>filters.setSourceFilters(id==="all"?{...allTypes}:Object.fromEntries(types.map(([key])=>[key,key===id])) as SourceFilters)}>{label}{results && (filters.sourceFacetCounts ? (id==="all" || resolvedSources[id]) : true) && <small title="当前搜索结果中的条数">{counts[id]}</small>}</button>)}</nav>
    <div className="mobile-applied-scope" aria-label="当前搜索范围与筛选">
      {scopeFiltered && <div className="bw-applied-strip">
        <span>
          范围：<strong>{scopeSummary}</strong>
          {filters.selectedLibraryIds !== null && filters.selectedLibraryIds.length === 0
            ? "（零选中不回退整库）"
            : "（仅限本地检索，不向 AI 上传整库）"}
        </span>
        <button type="button" aria-label="清除资料范围" onClick={() => { onSelectLibraries?.(null); filters.setFolderId(""); }}>恢复全库 ×</button>
      </div>}
    </div>
    <WorkspaceFilterSummary filters={[
      ...(!all ? [{ label: `类型：${types.filter(([key]) => resolvedSources[key]).map(([, label]) => label).join("、") || "未选择"}`, clear: () => filters.setSourceFilters({ ...allTypes }) }] : []),
      ...(filters.dateFilter !== "any" ? [{ label: `近 ${filters.dateFilter} 天`, clear: () => filters.setDateFilter("any") }] : []),
      ...(filters.searchScope !== "all" ? [{ label: filters.searchScope === "title" ? "仅名称" : "名称与章节", clear: () => filters.setSearchScope("all") }] : []),
      ...(filters.folderId ? [{ label: `文件夹：${filters.selectedFolder?.path ?? "所选文件夹"}`, clear: () => filters.setFolderId("") }] : []),
    ]} onReset={() => { filters.setDateFilter("any"); filters.setFolderId(""); filters.setSearchScope("all"); filters.setSourceFilters({ ...allTypes }); }} />
  </div>;
}

/** Mounted for each disclosure: dismissal discards drafts without mutating live search. */
export function MobileSearchFilterForm({ filters, onSelectLibraries, onApply, libraryOnly = false }: {
  filters: Filters; onSelectLibraries?: (ids: string[] | null) => void; onApply: () => void; libraryOnly?: boolean;
}) {
  const [date, setDate] = useState(filters.dateFilter);
  const [scope, setScope] = useState(filters.searchScope);
  const [sources, setSources] = useState<SourceFilters>(()=>normalizeSourceFilters(filters.sourceFilters));
  const [libraries, setLibraries] = useState<string[] | null>(filters.selectedLibraryIds && [...filters.selectedLibraryIds]);
  const [folder, setFolder] = useState(filters.folderId);
  const [draftFolders, setDraftFolders] = useState<FolderSummary[]>(filters.folders);
  const availableIds = new Set(filters.spaces.map(item => item.id));
  const validDraftLibraries = libraries === null ? null : libraries.filter(id => availableIds.has(id));
  const draftSpaceKey = validDraftLibraries === null ? "*" : validDraftLibraries.join("\u0000");

  useEffect(() => {
    setDraftFolders(filters.folders);
  }, [filters.folders]);

  useEffect(() => {
    if (libraryOnly) return;
    if (validDraftLibraries !== null && validDraftLibraries.length === 0) {
      setDraftFolders([]);
      return;
    }
    const targetSpaceIds = validDraftLibraries === null ? filters.spaces.map(item => item.id) : validDraftLibraries;
    if (!targetSpaceIds.length) {
      setDraftFolders([]);
      return;
    }
    let cancelled = false;
    void invoke<FolderSummary[]>("list_folders", { spaceIds: targetSpaceIds })
      .then(next => {
        if (!cancelled && Array.isArray(next)) setDraftFolders(next);
      })
      .catch(() => {
        // Keep prop-provided folders when backend command is unavailable (e.g. isolated tests).
      });
    return () => { cancelled = true; };
  }, [libraryOnly, draftSpaceKey, filters.spaces]);

  const all = Object.values(sources).every(Boolean);
  const selectedType = all ? "all" : types.find(([key]) => sources[key] && Object.values(sources).filter(Boolean).length === 1)?.[0] ?? "custom";
  function selectDraftFolder(value: string) {
    if (!value) {
      setFolder("");
      return;
    }
    const spaceId = value.split("\u0000")[0];
    if (spaceId && availableIds.has(spaceId)) setLibraries([spaceId]);
    setFolder(value);
  }
  function toggleLibrary(library: LibrarySummary) {
    const ids = validDraftLibraries ?? filters.spaces.map(item => item.id);
    const removing = ids.includes(library.id);
    const next = removing ? ids.filter(id => id !== library.id) : [...ids, library.id];
    setLibraries(next);
    if (removing && folder.startsWith(`${library.id}\u0000`)) setFolder("");
  }
  const effectiveFolders = draftFolders.filter(item => availableIds.has(item.spaceId) && (validDraftLibraries === null || validDraftLibraries.includes(item.spaceId)));
  const selectedCount = validDraftLibraries === null ? filters.spaces.length : validDraftLibraries.length;
  return <form className="mobile-search-filter-form" onSubmit={event => {
    event.preventDefault();
    const normalizedLibraries = validDraftLibraries !== null && filters.spaces.length > 0 && validDraftLibraries.length === filters.spaces.length && filters.spaces.every(item => validDraftLibraries.includes(item.id))
      ? null
      : validDraftLibraries;
    onSelectLibraries?.(normalizedLibraries);
    if (libraryOnly) {
      const currentFolderSpace = filters.folderId.split("\u0000")[0];
      if (filters.folderId && (!availableIds.has(currentFolderSpace) || (normalizedLibraries !== null && !normalizedLibraries.includes(currentFolderSpace)))) {
        filters.setFolderId("");
      }
      onApply();
      return;
    }
    const folderSpaceId = folder.split("\u0000")[0];
    const validFolder = folder && availableIds.has(folderSpaceId) && (normalizedLibraries === null || normalizedLibraries.includes(folderSpaceId)) ? folder : "";
    filters.setFolderId(validFolder); filters.setDateFilter(date); filters.setSearchScope(scope); filters.setSourceFilters(sources);
    onApply();
  }}>
    <div className="mobile-filter-body">
      <p>{libraryOnly
        ? "仅筛选云端助手自动关联的资料库范围（按库生效，不按单文件夹裁剪；全部资料库时也会检索速记）。"
        : "仅筛选本机已建立索引的内容，不会向 Agents 授权资料。"}</p>
      <section className="bw-scope-libraries" aria-label="资料范围">
        <header><strong>已选 {selectedCount} / {filters.spaces.length} 个资料库</strong>
          <div><button type="button" onClick={() => {setLibraries(null); setFolder("");}}>全选</button>
          <button type="button" onClick={() => {setLibraries(filters.spaces.filter(lib => validDraftLibraries !== null && !validDraftLibraries.includes(lib.id)).map(lib => lib.id)); setFolder("");}}>反选</button>
          <button type="button" onClick={() => {setLibraries([]); setFolder("");}}>清空</button></div>
        </header>
        {!filters.spaces.length && <p>暂无已接入的资料库</p>}
        {filters.spaces.map(library => {
          const checked = validDraftLibraries === null || validDraftLibraries.includes(library.id);
          const libFolders = libraryOnly ? [] : effectiveFolders.filter(item => item.spaceId === library.id);
          return <div key={library.id} className="bw-scope-library-row">
            <div className="bw-scope-library-head">
              <label><input type="checkbox" checked={checked} onChange={() => toggleLibrary(library)}/><span>{library.name}</span><small className="bw-scope-doc-count">{library.documentCount}</small></label>
              <button type="button" className="bw-scope-only" aria-label={`仅选 ${library.name}`} onClick={() => { setLibraries([library.id]); setFolder(""); }}>仅选</button>
            </div>
            {!libraryOnly && checked && libFolders.length > 0 && libFolders.length <= 12 && (
              <div className="bw-scope-folder-chips" role="group" aria-label={`${library.name} 文件夹`}>
                {libFolders.map(item => {
                  const value = `${item.spaceId}\u0000${item.id}`;
                  const active = folder === value;
                  return <button key={value} type="button" aria-pressed={active} onClick={() => selectDraftFolder(active ? "" : value)}>{item.path}</button>;
                })}
              </div>
            )}
          </div>;
        })}
        {!libraryOnly && !!effectiveFolders.length && <label>文件夹<select aria-label="文件夹范围" value={folder} onChange={event => selectDraftFolder(event.target.value)}><option value="">全部文件夹</option>{effectiveFolders.map(item => <option key={`${item.spaceId}\u0000${item.id}`} value={`${item.spaceId}\u0000${item.id}`}>{item.libraryName} / {item.path}</option>)}</select></label>}
      </section>
      {!libraryOnly && <details className="bw-scope-more"><summary>更多搜索筛选</summary>
      <label>内容类型<select aria-label="内容类型" value={selectedType} onChange={event => setSources(event.target.value === "all" ? { ...allTypes } : Object.fromEntries(types.map(([key]) => [key, key === event.target.value])) as SourceFilters)}>
        <option value="all">全部类型</option>{selectedType === "custom" && <option value="custom">自定义类型（保留原筛选）</option>}{types.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <div className="mobile-filter-pair">
        <label>日期范围<select aria-label="日期范围" value={date} onChange={event => setDate(event.target.value as typeof date)}><option value="any">不限日期</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label>
        <label>匹配位置<select aria-label="匹配位置" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">全部字段</option><option value="title">仅名称</option><option value="title_heading">名称与章节</option></select></label>
      </div>
      </details>}
    </div>
    <footer><div><button type="button" onClick={() => { setLibraries(null); setFolder(""); }}>重置全库</button><button type="submit">应用范围 ({selectedCount}/{filters.spaces.length} 库)</button></div></footer>
  </form>;
}
