import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CheckCircle2, ChevronDown, Copy, GalleryHorizontal, LayoutList, Columns3, Plus, Table2, Trash2, X } from "lucide-react";
import { collectionLayoutLabels, useCollectionViews, type CollectionColumn, type CollectionLayout, type CollectionView } from "./CollectionViews";
import { CollectionCardConfig, cardFields, defaultCollectionCards, type CardField } from "./CollectionCardConfig";
import { CardSizeControl } from "./CardSizeControl";
import { useMobileViewport } from "./useMobileViewport";
import "./CollectionViewTabs.css";

const layoutIcons = { list: LayoutList, table: Table2, board: Columns3, gallery: GalleryHorizontal };
const columns: Record<CollectionColumn, string> = { source: "来源", author: "作者", published: "发布时间", collected: "创建日期", media: "附件", liked: "喜欢", destination: "保存到" };
const layouts = ["list", "table", "board", "gallery"] as const;

export function CollectionViewTabs({ onChange, compact = false, onNotice, advancedSort }: { onChange: (patch: Partial<CollectionView>) => void; compact?: boolean; onNotice?: (notice: string) => void; advancedSort?: React.ReactNode }) {
  const navigation = useCollectionViews();
  const { view, views, activeEntry } = navigation;
  const visibleViews = views.filter(candidate => !candidate.hidden);
  const saved = activeEntry.kind === "view";
  const tabName = saved ? view.name : collectionLayoutLabels[view.layout];
  const [name, setName] = useState(tabName);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newLayout, setNewLayout] = useState<CollectionLayout>(view.layout);
  const { height: visibleHeight } = useMobileViewport();
  const [visibleTop, setVisibleTop] = useState(() => window.visualViewport?.offsetTop || 0);
  const menu = useRef<HTMLDetailsElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const createButton = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const cancelNameCommit = useRef(false);
  const [position, setPosition] = useState<CSSProperties>({ left: 16, top: 140 });
  const cards = { ...defaultCollectionCards, ...view.cards };
  useEffect(() => setName(tabName), [view.id, tabName]);
  useLayoutEffect(() => {
    if (!creating) return;
    const viewport = window.visualViewport;
    const update = () => {
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      setVisibleTop(Math.max(0, viewport?.offsetTop || 0));
    };
    update();
    viewport?.addEventListener("scroll", update);
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("scroll", update);
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
    };
  }, [creating]);
  useEffect(() => {
    if (creating) {
      dialog.current?.showModal();
      nameInput.current?.focus();
      nameInput.current?.select();
    } else dialog.current?.close();
  }, [creating]);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const commitName = () => {
    if (cancelNameCommit.current) { cancelNameCommit.current = false; setName(tabName); return; }
    const cleanName = name.trim().slice(0, 60);
    if (!cleanName || cleanName === tabName) { setName(tabName); return; }
    const success = saved ? navigation.renameView(view.id, cleanName) : navigation.saveView(cleanName);
    if (!success) setName(tabName);
  };
  const nextName = (base: string) => {
    const cleanBase = base.slice(0, 60);
    let candidate = cleanBase, suffix = 2;
    while (views.some(item => item.name === candidate)) { const ending = ` ${suffix++}`; candidate = `${cleanBase.slice(0, 60 - ending.length)}${ending}`; }
    return candidate;
  };
  const openCreate = () => {
    closeMenu();
    setNewName(nextName(collectionLayoutLabels[view.layout]));
    setNewLayout(view.layout);
    setCreating(true);
  };
  const closeCreate = () => { if (dialog.current?.open) dialog.current.close(); setCreating(false); createButton.current?.focus(); };
  const saveCreate = () => {
    if (navigation.saveView(newName, { layout: newLayout })) { closeCreate(); onNotice?.("视图已创建"); }
  };
  const duplicate = () => {
    if (navigation.saveView(nextName(`${tabName.slice(0, 57)} 副本`))) { closeMenu(); onNotice?.("视图已复制"); }
  };
  const remove = () => {
    if (!saved) return;
    const index = visibleViews.findIndex(item => item.id === view.id);
    const next = visibleViews[index + 1] || visibleViews[index - 1];
    closeMenu(); navigation.deleteView(view.id);
    if (next) navigation.selectView(next.id);
    onNotice?.("视图已删除，阅读内容保留");
  };
  const placeMenu = () => {
    if (!menu.current?.open) return;
    const anchor = menu.current.querySelector("summary")?.getBoundingClientRect();
    if (!anchor) return;
    const width = Math.min(304, window.innerWidth - 24);
    const top = Math.min(anchor.bottom + 6, Math.max(12, window.innerHeight - 180));
    setPosition({ left: Math.max(12, Math.min(anchor.left, window.innerWidth - width - 12)), top, width, maxHeight: Math.max(140, window.innerHeight - top - 16) });
  };
  useEffect(() => {
    const close = () => closeMenu();
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  const ActiveIcon = layoutIcons[view.layout];
  const activeTab = <details key="active-reading-view" ref={menu} className="task-view-tab-menu collection-database-active-tab" onToggle={placeMenu} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeMenu(); menu.current?.querySelector("summary")?.focus(); }
  }}>
    <summary aria-label={`配置视图 ${tabName}`} title={`配置视图“${tabName}”`}><ActiveIcon size={15}/><span>{tabName}</span><ChevronDown size={13}/></summary>
    <div className="collection-database-view-settings" style={position} role="dialog" aria-label={`视图 ${tabName} 的设置`}>
      {compact && visibleViews.length > (saved ? 1 : 0) && <label className="collection-database-setting-select"><span>切换视图</span><select aria-label="切换阅读视图" value={saved ? view.id : ""} onChange={event => { navigation.selectView(event.target.value); closeMenu(); }}>{!saved && <option value="">{tabName}</option>}{visibleViews.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>}
      <input className="collection-database-view-name" aria-label="视图名称" value={name} maxLength={60} onChange={event => setName(event.target.value)} onBlur={commitName} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") { cancelNameCommit.current = true; setName(tabName); }
      }}/>
      <strong className="collection-database-setting-heading">布局</strong>
      <div className="collection-database-layout-options" aria-label="阅读布局">{layouts.map(layout => {
        const Icon = layoutIcons[layout];
        return <button type="button" key={layout} className={view.layout === layout ? "selected" : ""} aria-pressed={view.layout === layout} onClick={() => onChange({ layout })}><Icon size={16}/><span>{collectionLayoutLabels[layout]}</span>{view.layout === layout && <CheckCircle2 size={15}/>}</button>;
      })}</div>
      <label className="collection-database-setting-select"><span>内容密度</span><select aria-label="内容密度" value={view.density} onChange={event => onChange({ density: event.target.value as CollectionView["density"] })}><option value="compact">紧凑</option><option value="comfortable">标准</option></select></label>
      <strong className="collection-database-setting-heading">显示属性</strong>
      {view.layout === "gallery" ? (Object.keys(cardFields) as CardField[]).map(field => <label className="collection-database-property" key={field}><input type="checkbox" checked={!cards.hidden.includes(field)} onChange={() => onChange({ cards: { ...cards, hidden: cards.hidden.includes(field) ? cards.hidden.filter(value => value !== field) : [...cards.hidden, field] } })}/><span>{cardFields[field]}</span></label>) : (Object.keys(columns) as CollectionColumn[]).map(field => <label className="collection-database-property" key={field}><input type="checkbox" checked={view.columns[field]} onChange={() => onChange({ columns: { ...view.columns, [field]: !view.columns[field] } })}/><span>{columns[field]}</span></label>)}
      <strong className="collection-database-setting-heading">条件颜色</strong>
      <label className="collection-database-setting-select"><span>突出显示</span><select aria-label="阅读条件颜色" value={view.colorMode || "none"} onChange={event => onChange({ colorMode: event.target.value as CollectionView["colorMode"] })}><option value="none">关闭</option><option value="source">按来源</option><option value="status">按阅读状态</option></select></label>
      {view.layout === "gallery" && <div className="collection-view-gallery-settings"><strong className="collection-database-setting-heading">画廊设置</strong><CardSizeControl value={cards.size} onChange={size => onChange({ cards: { ...cards, size } })}/><CollectionCardConfig key={view.id} name={tabName} value={cards} showLabel onChange={patch => onChange({ cards: { ...cards, ...patch } })}/></div>}
      {advancedSort}
      <div className="collection-database-view-actions"><button type="button" disabled={views.length >= 30} onClick={duplicate}><Copy size={14}/>复制视图</button><button type="button" className="danger" disabled={!saved} onClick={remove}><Trash2 size={14}/>删除视图</button></div>
    </div>
  </details>;
  return <div className={`task-view-switch collection-database-tabs${compact ? " compact" : ""}`} aria-label="阅读视图">
    <div className="collection-database-tab-track">{(saved ? visibleViews : [{ ...view, name: tabName, hidden: false }, ...visibleViews]).map(candidate => candidate.id === view.id ? activeTab : (() => {
      const Icon = layoutIcons[candidate.layout];
      return <button type="button" className="collection-database-view-tab" key={candidate.id} aria-label={`打开视图 ${candidate.name}`} aria-pressed={false} onClick={() => { closeMenu(); navigation.selectView(candidate.id); }}><Icon size={15}/><span>{candidate.name}</span></button>;
    })())}</div>
    <button ref={createButton} type="button" className="collection-database-add-view" aria-label="新建视图" title={views.length >= 30 ? "最多保存 30 个视图" : "新建视图"} disabled={views.length >= 30} onClick={openCreate}><Plus size={16}/></button>
    {creating && <dialog ref={dialog} className="collection-database-create-dialog" style={{ "--collection-create-visible-height": `${visibleHeight}px`, "--collection-create-visible-top": `${visibleTop}px` } as CSSProperties} aria-labelledby="collection-create-view-title" onCancel={closeCreate} onClose={() => { if (creating) closeCreate(); }}>
      <form onSubmit={event => { event.preventDefault(); saveCreate(); }}>
        <header><h2 id="collection-create-view-title">新建视图</h2><button type="button" aria-label="关闭新建视图" onClick={closeCreate}><X size={19}/></button></header>
        <div className="collection-database-create-body">
        <label className="collection-database-create-name">视图名称<input ref={nameInput} aria-label="新视图名称" autoFocus maxLength={60} value={newName} onChange={event => setNewName(event.target.value)}/></label>
        <strong className="collection-database-setting-heading">布局</strong>
        <div className="collection-database-create-layouts">{layouts.map(layout => { const Icon = layoutIcons[layout]; return <button type="button" key={layout} className={newLayout === layout ? "selected" : ""} aria-pressed={newLayout === layout} onClick={() => setNewLayout(layout)}><Icon size={18}/><span>{collectionLayoutLabels[layout]}</span>{newLayout === layout && <CheckCircle2 size={14}/>}</button>; })}</div>
        <p>沿用当前筛选、排序和显示设置，之后可独立调整。</p>
        </div>
        <footer><button type="button" onClick={closeCreate}>取消</button><button type="submit" className="collection-database-primary" disabled={!newName.trim() || views.length >= 30}>创建视图</button></footer>
      </form>
    </dialog>}
  </div>;
}
