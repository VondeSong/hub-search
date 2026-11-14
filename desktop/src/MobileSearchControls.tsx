import { useState, type ComponentProps } from "react";
import type { FilterBar } from "./FilterBar";
import { WorkspaceFilterSummary } from "./WorkspaceFilterSummary";
import type { LibrarySummary } from "./SearchTypes";
import type { SourceFilters } from "./useLocalSearch";

type Filters = ComponentProps<typeof FilterBar>;
const types = [["craft", "资料"], ["task", "任务"], ["pdf", "PDF"], ["media", "媒体"], ["attachment", "附件"]] as const;
const allTypes: SourceFilters = { craft: true, task: true, pdf: true, media: true, attachment: true };

export function MobileSearchControls({ filters, onSelectLibraries }: { filters: Filters; onSelectLibraries?: (ids: string[] | null) => void }) {
  const all = Object.values(filters.sourceFilters).every(Boolean);
  return <div className="mobile-search-facets">
    <div className="mobile-content-types" role="group" aria-label="内容类型">
      <button aria-pressed={all} onClick={() => filters.setSourceFilters({ ...allTypes })}>全部</button>
      {types.map(([key, label]) => <button key={key} aria-pressed={!all && filters.sourceFilters[key] && Object.values(filters.sourceFilters).filter(Boolean).length === 1}
        onClick={() => filters.setSourceFilters(Object.fromEntries(types.map(([id]) => [id, id === key])) as SourceFilters)}>{label}</button>)}
    </div>
    <div className="mobile-applied-scope" aria-label="当前搜索范围与筛选">
      <span>范围：{filters.selectedLibraryIds === null ? "全部资料库" : `${filters.activeSpaces.length} 个资料库`}</span>
      {filters.selectedLibraryIds !== null && <button onClick={() => { onSelectLibraries?.(null); filters.setFolderId(""); }}>清除资料范围</button>}
    </div>
    <WorkspaceFilterSummary filters={[
      ...(!all ? [{ label: `类型：${types.filter(([key]) => filters.sourceFilters[key]).map(([, label]) => label).join("、") || "未选择"}`, clear: () => filters.setSourceFilters({ ...allTypes }) }] : []),
      ...(filters.dateFilter !== "any" ? [{ label: `近 ${filters.dateFilter} 天`, clear: () => filters.setDateFilter("any") }] : []),
      ...(filters.searchScope !== "all" ? [{ label: filters.searchScope === "title" ? "仅名称" : "名称与章节", clear: () => filters.setSearchScope("all") }] : []),
      ...(filters.folderId ? [{ label: `文件夹：${filters.selectedFolder?.path ?? "所选文件夹"}`, clear: () => filters.setFolderId("") }] : []),
    ]} onReset={() => { filters.setDateFilter("any"); filters.setFolderId(""); filters.setSearchScope("all"); filters.setSourceFilters({ ...allTypes }); }} />
  </div>;
}

/** Mounted for each disclosure: dismissal discards drafts without mutating live search. */
export function MobileSearchFilterForm({ filters, onSelectLibraries, onApply }: {
  filters: Filters; onSelectLibraries?: (ids: string[] | null) => void; onApply: () => void;
}) {
  const [date, setDate] = useState(filters.dateFilter);
  const [scope, setScope] = useState(filters.searchScope);
  const [sources, setSources] = useState({ ...filters.sourceFilters });
  const [libraries, setLibraries] = useState<string[] | null>(filters.selectedLibraryIds && [...filters.selectedLibraryIds]);
  const [folder, setFolder] = useState(filters.folderId);
  const all = Object.values(sources).every(Boolean);
  const selectedType = all ? "all" : types.find(([key]) => sources[key] && Object.values(sources).filter(Boolean).length === 1)?.[0] ?? "custom";
  function toggleLibrary(library: LibrarySummary) {
    const ids = libraries ?? filters.spaces.map(item => item.id);
    setLibraries(ids.includes(library.id) ? ids.filter(id => id !== library.id) : [...ids, library.id]);
    setFolder("");
  }
  return <form className="mobile-search-filter-form" onSubmit={event => {
    event.preventDefault();
    onSelectLibraries?.(libraries);
    filters.setFolderId(folder); filters.setDateFilter(date); filters.setSearchScope(scope); filters.setSourceFilters(sources);
    onApply();
  }}>
    <div className="mobile-filter-body">
      <p>仅筛选本机已建立索引的内容，不会向 Agents 授权资料。</p>
      <label>内容类型<select aria-label="内容类型" value={selectedType} onChange={event => setSources(event.target.value === "all" ? { ...allTypes } : Object.fromEntries(types.map(([key]) => [key, key === event.target.value])) as SourceFilters)}>
        <option value="all">全部类型</option>{selectedType === "custom" && <option value="custom">自定义类型（保留原筛选）</option>}{types.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <div className="mobile-filter-pair">
        <label>日期范围<select aria-label="日期范围" value={date} onChange={event => setDate(event.target.value as typeof date)}><option value="any">不限日期</option><option value="7">近 7 天</option><option value="30">近 30 天</option><option value="90">近 90 天</option></select></label>
        <label>匹配位置<select aria-label="匹配位置" value={scope} onChange={event => setScope(event.target.value as typeof scope)}><option value="all">全部字段</option><option value="title">仅名称</option><option value="title_heading">名称与章节</option></select></label>
      </div>
      <details className="mobile-filter-libraries"><summary><strong>资料范围</strong><span>{libraries === null ? "全部资料库" : libraries.length ? `已选 ${libraries.length} 个资料库` : "未选择资料库"}</span></summary>
        <div className="mobile-filter-library-actions"><button type="button" onClick={() => { setLibraries(null); setFolder(""); }}>全选</button><button type="button" onClick={() => { setLibraries([]); setFolder(""); }}>全不选</button></div>
        {!filters.spaces.length && <p>暂无已接入的资料库，可从浏览页添加。</p>}
        {filters.spaces.map(library => <label key={library.id}><input type="checkbox" checked={libraries === null || libraries.includes(library.id)} onChange={() => toggleLibrary(library)} /><span>{library.name}</span></label>)}
        {!!filters.folders.length && <label>文件夹<select aria-label="文件夹范围" value={folder} onChange={event => setFolder(event.target.value)}><option value="">全部文件夹</option>{filters.folders.filter(item => libraries === null || libraries.includes(item.spaceId)).map(item => <option key={`${item.spaceId}\u0000${item.id}`} value={`${item.spaceId}\u0000${item.id}`}>{item.libraryName} / {item.path}</option>)}</select></label>}
      </details>
    </div>
    <footer><span>{libraries === null ? "全部资料库" : `已选 ${libraries.length} 个资料库`} · 应用后生效</span><div><button type="button" onClick={() => { setDate("any"); setScope("all"); setSources({ ...allTypes }); setLibraries(null); setFolder(""); }}>重置</button><button type="submit">应用筛选</button></div></footer>
  </form>;
}
