import { useEffect, useRef, useState } from "react";
import { CircleAlert, Library, RefreshCw, Search, X } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import { providerName } from "./ProviderLabels";
import { isAgentLibraryProvider, resolveAgentLibraries, useAgentLibraryRegistry, type AgentLibrary, type AgentLibraryRegistry } from "./useAgentLibraryRegistry";
import "./AgentLibraryScope.css";

export type { AgentLibrary } from "./useAgentLibraryRegistry";
export const libraryDragType = "application/x-hub-agent-libraries";
export function readLibraryDrop(raw:string):AgentLibrary[] {
  if(raw.length>65536)throw Error("资料库范围过大");
  const values:unknown=JSON.parse(raw);
  if(!Array.isArray(values)||!values.length||values.length>256||values.some(v=>!v||typeof v.id!=="string"||!v.id.trim()||v.id!==v.id.trim()||v.id.length>1024||typeof v.name!=="string"||v.name.length>200))throw Error("无法识别资料库范围");
  return [...new Map(values.map(v=>[v.id,{id:v.id,name:v.name}])).values()];
}
export function AgentLibraryScope({ selected, disabled, onChange, registry: suppliedRegistry, description }: {
  selected: AgentLibrary[];
  disabled: boolean;
  onChange: (items: AgentLibrary[]) => void;
  registry?: AgentLibraryRegistry;
  description?: string;
}) {
  const localRegistry = useAgentLibraryRegistry(!suppliedRegistry);
  const registry = suppliedRegistry || localRegistry;
  const { libraries, loaded, loading, error, watchError, reload } = registry;
  const [query, setQuery] = useState("");
  const allCheckbox = useRef<HTMLInputElement>(null);
  const selectedIds = new Set(selected.map(library => library.id));
  const availableIds = new Set(libraries.map(library => library.id));
  const selectedAvailable = libraries.filter(library => selectedIds.has(library.id)).length;
  const allSelected = libraries.length > 0 && selectedAvailable === libraries.length;
  const unavailable = loaded ? resolveAgentLibraries(selected.filter(library => !availableIds.has(library.id)), registry) : [];
  const search = query.trim().toLocaleLowerCase();
  const filtered = libraries.filter(library => `${library.name} ${isAgentLibraryProvider(library.provider) ? providerName(library.provider) : ""}`.toLocaleLowerCase().includes(search));
  useEffect(() => { if (allCheckbox.current) allCheckbox.current.indeterminate = selectedAvailable > 0 && !allSelected; }, [selectedAvailable, allSelected]);
  const change = (items: AgentLibrary[]) => { if (!disabled) onChange(resolveAgentLibraries(items, registry)); };
  const toggleAll = (checked: boolean) => {
    // Selecting all is an explicit current-ID snapshot. Keep unavailable selections
    // until the user removes them, rather than silently changing old authorization.
    const retained = selected.filter(library => !availableIds.has(library.id));
    change(checked ? [...retained, ...libraries.map(({ id, name }) => ({ id, name }))] : retained);
  };
  return <section className="agent-library-scope agent-library-picker" aria-label="资料库授权范围">
    <div className="agent-library-picker-heading">
      <strong>允许查找的资料库</strong>
      <button type="button" className="agent-library-refresh" aria-label="刷新资料库" title="刷新资料库" disabled={loading} onClick={() => void reload()}><RefreshCw size={15} className={loading ? "spin" : undefined} aria-hidden="true" /></button>
    </div>
    <p className="agent-library-hint">{description ?? "随下一条消息生效；单独添加的页面继续保留。"}</p>
    <label className="agent-library-search">
      <Search size={16} aria-hidden="true" />
      <input type="search" aria-label="搜索资料库" placeholder="搜索资料库" value={query} onChange={event => setQuery(event.target.value)} />
    </label>
    {loading && !loaded && <p className="agent-library-hint" role="status">正在读取资料库…</p>}
    {error && <div className="agent-library-error" role="alert"><span>{error}</span><button type="button" disabled={loading} onClick={() => void reload()}>重新读取</button></div>}
    {watchError && <p className="agent-library-hint" role="status">{watchError}</p>}
    {!!libraries.length && <label className="agent-library-all">
      <Library size={17} aria-hidden="true" /><span>全部资料库<small>当前 {libraries.length} 个</small></span>
      <input ref={allCheckbox} type="checkbox" aria-label="选择全部资料库" disabled={disabled} checked={allSelected} onChange={event => toggleAll(event.target.checked)} />
    </label>}
    <div className="agent-library-list" role="group" aria-label="可选资料库">
      {filtered.map(library => <label className="agent-library-choice" key={library.id} data-selected={selectedIds.has(library.id) || undefined}>
        {isAgentLibraryProvider(library.provider) ? <LibraryIcon provider={library.provider} name={library.name} iconSvg={library.iconSvg} defaultIconUrl={library.defaultIconUrl} compact /> : <Library size={18} aria-hidden="true" />}
        <span className="agent-library-copy"><strong title={library.name}>{library.name || "未命名资料库"}</strong><small>
          {isAgentLibraryProvider(library.provider) && <span>{providerName(library.provider)}</span>}
          {Number.isFinite(library.documentCount) && <span>{library.documentCount.toLocaleString()} 篇文档</span>}
          {library.connected === true && <span>已连接</span>}
          {library.connected === false && <span title="可查找已缓存资料；远端内容是否最新尚未核实">离线 · 可查找缓存</span>}
        </small></span>
        <input type="checkbox" aria-label={`允许查找 ${library.name}`} disabled={disabled} checked={selectedIds.has(library.id)} onChange={event => change(event.target.checked ? [...selected, { id: library.id, name: library.name }] : selected.filter(item => item.id !== library.id))} />
      </label>)}
      {loaded && !loading && !error && !libraries.length && <p className="agent-library-empty">还没有可用的资料库，可在设置中添加。</p>}
      {!!libraries.length && !filtered.length && <p className="agent-library-empty" role="status">没有匹配的资料库</p>}
    </div>
    {!!unavailable.length && <div className="agent-library-unavailable" role="group" aria-label="当前不可用的已选资料库">
      <small>当前不可用</small>
      {unavailable.map(library => <div className="agent-library-unavailable-row" key={library.id}>
        <CircleAlert size={16} aria-hidden="true" /><span title={library.name}>{library.name}</span>
        <button type="button" disabled={disabled} aria-label={`移除不可用资料库 ${library.name}`} title="从本次范围移除" onClick={() => change(selected.filter(item => item.id !== library.id))}><X size={14} aria-hidden="true" /></button>
      </div>)}
      <small>这些库已不在当前列表中。刷新确认后，可手动移除。</small>
    </div>}
    <div className="agent-library-picker-footer">
      <small>按需检索，不会一次读取整库。新增库不会自动加入；附件仅查找已提取的文字。</small>
      {!!selected.length && <button type="button" disabled={disabled} onClick={() => change([])}>清除库范围</button>}
    </div>
  </section>;
}
