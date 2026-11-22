import { useEffect, useRef, useState } from "react";
import { Archive, Ban, Check, CircleCheck, CircleDot, Clock3, FileText, Gem, Inbox, SquareCheck, ChevronDown, ChevronRight, CircleAlert, Columns3, Eye, EyeOff, GalleryHorizontal, Keyboard, LayoutList, MoreHorizontal, Pencil, Plus, Settings2, Table2, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";
import { LibraryIcon } from "./LibraryIcon";
import { providerName } from "./ProviderLabels";
import type { LibrarySummary } from "./SearchTypes";
import { collectionEntryLabels, useCollectionViews, type CollectionBuiltinEntry, type CollectionSavedView } from "./CollectionViews";
import "./CollectionNavigation.css";

const builtinIcons = { all: Inbox, unread: CircleDot, in_progress: Clock3, read: CircleCheck, archived: Archive, abandoned: Ban, attention: CircleAlert };
const copyIcons = { craft: FileText, obsidian: Gem, dida365: SquareCheck };
const viewLayoutIcons = { list: LayoutList, table: Table2, board: Columns3, gallery: GalleryHorizontal };
const sourceLabels = { all: "全部来源", bookmarks: "X 书签", likes: "X 喜欢", telegram: "Telegram", dida: "滴答稍后读" };

function savedCopyLabel(library: LibrarySummary): string {
  const provider = providerName(library.provider);
  return library.name === provider ? provider : `${provider} · ${library.name}`;
}

function viewSummary(view: CollectionSavedView): string {
  return [sourceLabels[view.source], view.attentionOnly ? "需要处理" : view.status !== "all" ? collectionEntryLabels[view.status] : "", view.tags.length ? view.tags.join("、") : "", view.media !== "all" ? ({ photo: "有图片", video: "有视频", links: "有外链" }[view.media]) : "", view.dateFilter !== "any" ? `最近 ${view.dateFilter} 天` : "", view.query ? `搜索：${view.query}` : ""].filter(Boolean).join(" · ");
}

export function CollectionNavigation({ libraries = [], onOpenSettings }: { libraries?: LibrarySummary[]; onOpenSettings?: () => void }) {
  const navigation = useCollectionViews();
  const { activeEntry, counts, views } = navigation;
  const [editor, setEditor] = useState<{ kind: "new" | "rename"; id?: string; name: string } | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [manageViews, setManageViews] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const copies = new Map(counts.savedCopies.map(copy => [copy.libraryId, copy.count]));
  const copyLibraries = libraries.filter(library => ["craft", "obsidian", "dida365"].includes(library.provider));
  const visibleViews = views.filter(view => !view.hidden);
  useEffect(() => {
    if (!openMenu) return;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null); };
    const closeOnFocusLeave = (event: FocusEvent) => { if (!menuRef.current?.contains(event.target as Node)) setOpenMenu(null); };
    const closeOnWindowBlur = () => setOpenMenu(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("focusin", closeOnFocusLeave);
    window.addEventListener("blur", closeOnWindowBlur);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("focusin", closeOnFocusLeave); window.removeEventListener("blur", closeOnWindowBlur); };
  }, [openMenu]);
  const closeTransient = () => { setOpenMenu(null); setEditor(null); };
  const submitEditor = () => {
    if (!editor) return;
    const saved = editor.kind === "new" ? navigation.saveView(editor.name) : navigation.renameView(editor.id!, editor.name);
    if (saved) setEditor(null);
  };
  const countFor = (id: CollectionBuiltinEntry) => id === "in_progress" ? counts.inProgress : id === "attention" ? counts.needsAttention : counts[id];
  const builtin = (id: CollectionBuiltinEntry) => {
    const Icon = builtinIcons[id];
    return <button key={id} type="button" aria-label={collectionEntryLabels[id]} className={`collection-nav-item${activeEntry.kind === "builtin" && activeEntry.id === id ? " active" : ""}${id === "attention" && counts.needsAttention ? " attention" : ""}`} aria-pressed={activeEntry.kind === "builtin" && activeEntry.id === id} onClick={() => { closeTransient(); navigation.selectBuiltin(id); }}>
      <span className="reading-nav-icon" data-kind={id}><Icon size={14}/></span><span>{collectionEntryLabels[id]}</span><small>{countFor(id)}</small>
    </button>;
  };

  return <nav className="collection-navigation" aria-label="阅读导航" onKeyDown={event => { if (event.key === "Escape") { closeTransient(); setManageViews(false); setShortcutsOpen(false); } }}>
    <div className="collection-navigation-scroll">
      <section className="collection-nav-section collection-nav-primary" aria-label="阅读状态">
        {(["all", "unread", "in_progress", "read"] as const).map(builtin)}
      </section>
      <section className="collection-nav-section" aria-label="我的视图">
        <div className="collection-nav-heading"><span>视图</span><div>
          {views.length > 0 && <button type="button" aria-label="管理我的视图" title="管理我的视图" aria-expanded={manageViews} onClick={() => { setManageViews(!manageViews); setOpenMenu(null); }}><Settings2 size={14} /></button>}
          <button type="button" aria-label="保存当前筛选为视图" title={views.length >= 30 ? "最多保存 30 个视图" : "保存当前筛选为视图"} disabled={views.length >= 30} onClick={() => { setEditor({ kind: "new", name: "" }); setOpenMenu(null); }}><Plus size={16} /></button>
        </div></div>
        {editor && <form className="collection-nav-editor" onSubmit={event => { event.preventDefault(); submitEditor(); }}>
          <input autoFocus aria-label={editor.kind === "new" ? "新视图名称" : "重命名视图"} placeholder="视图名称" value={editor.name} maxLength={60} onChange={event => setEditor({ ...editor, name: event.target.value })} />
          <button type="submit" disabled={!editor.name.trim()} aria-label={editor.kind === "new" ? "保存视图" : "保存视图名称"}><Check size={14} /></button>
          <button type="button" aria-label="取消编辑视图" onClick={() => setEditor(null)}><X size={14} /></button>
        </form>}
        {visibleViews.map(view => {
          const Icon = viewLayoutIcons[view.layout];
          return <div key={view.id} className={`collection-nav-view${activeEntry.kind === "view" && activeEntry.id === view.id ? " active" : ""}`}>
          <button type="button" className="collection-nav-view-open" aria-label={view.name} aria-pressed={activeEntry.kind === "view" && activeEntry.id === view.id} title={viewSummary(view)} onClick={() => { closeTransient(); navigation.selectView(view.id); }}>
            <span className="reading-nav-icon" data-kind="view"><Icon size={12} aria-hidden="true"/></span><span><strong>{view.name}</strong><small>{activeEntry.kind === "view" && activeEntry.id === view.id && navigation.isModified ? "已修改" : viewSummary(view)}</small></span>
          </button>
          <div className="collection-nav-menu-wrap" ref={openMenu === view.id ? menuRef : undefined}>
            <button type="button" aria-label={`视图 ${view.name} 的更多操作`} aria-haspopup="menu" aria-expanded={openMenu === view.id} onClick={() => setOpenMenu(openMenu === view.id ? null : view.id)}><MoreHorizontal size={15} /></button>
            {openMenu === view.id && <div className="collection-nav-menu" role="menu" aria-label={`${view.name} 的视图操作`}>
              <button type="button" role="menuitem" onClick={() => { setEditor({ kind: "rename", id: view.id, name: view.name }); setOpenMenu(null); }}><Pencil size={13} />重命名</button>
              <button type="button" role="menuitem" disabled={views.indexOf(view) === 0} onClick={() => { navigation.moveView(view.id, -1); setOpenMenu(null); }}><ArrowUp size={13} />上移</button>
              <button type="button" role="menuitem" disabled={views.indexOf(view) === views.length - 1} onClick={() => { navigation.moveView(view.id, 1); setOpenMenu(null); }}><ArrowDown size={13} />下移</button>
              <button type="button" role="menuitem" onClick={() => { navigation.setViewHidden(view.id, true); setOpenMenu(null); }}><EyeOff size={13} />隐藏视图</button>
              <button type="button" role="menuitem" onClick={() => { navigation.deleteView(view.id); setOpenMenu(null); }}><Trash2 size={13} />删除视图</button>
            </div>}
          </div>
        </div>; })}
        {navigation.isModified && <div className="collection-nav-view-changes"><button type="button" onClick={navigation.updateSavedView}>更新视图</button><button type="button" onClick={() => setEditor({ kind: "new", name: "" })}>另存为</button></div>}
        {!visibleViews.length && !editor && <p className="collection-nav-empty">设置筛选后，保存为自己的视图。</p>}
        {manageViews && <div className="collection-nav-manage" role="group" aria-label="显示或隐藏视图">
          <strong>显示或隐藏视图</strong>
          {views.map(view => <label key={view.id}><input type="checkbox" checked={!view.hidden} onChange={event => navigation.setViewHidden(view.id, !event.target.checked)} />{view.hidden ? <EyeOff size={13} /> : <Eye size={13} />}<span>{view.name}</span></label>)}
        </div>}
      </section>
      <section className="collection-nav-section" aria-label="已保存副本">
        <button type="button" className="collection-nav-disclosure" aria-label={navigation.librariesCollapsed ? "展开已保存副本" : "折叠已保存副本"} aria-expanded={!navigation.librariesCollapsed} onClick={() => navigation.setLibrariesCollapsed(!navigation.librariesCollapsed)}>
          {navigation.librariesCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}<span>资料库副本</span>
        </button>
        {!navigation.librariesCollapsed && <div className="collection-nav-copies">
          {copyLibraries.map(library => {
            const label = savedCopyLabel(library);
            const Icon = copyIcons[library.provider as keyof typeof copyIcons] ?? FileText;
            return <button type="button" key={library.id} aria-label={`已保存到 ${label}`} className={`collection-nav-item collection-nav-copy${activeEntry.kind === "library" && activeEntry.id === library.id ? " active" : ""}`} aria-pressed={activeEntry.kind === "library" && activeEntry.id === library.id} title={`已保存到 ${label} 的收藏副本`} onClick={() => { closeTransient(); navigation.selectLibrary(library.id); }}>
              <span className="reading-nav-icon library-icon" data-kind={library.provider} title={label}>{library.iconSvg?<LibraryIcon provider={library.provider} name={library.name} iconSvg={library.iconSvg} compact/>:<Icon size={12}/>}</span><span>{label}</span><small>{copies.get(library.id) || 0}</small>
            </button>;
          })}
          {!copyLibraries.length && <p className="collection-nav-empty">添加资料库后，可查看已保存的收藏副本。</p>}
        </div>}
      </section>
      <section className="collection-nav-section collection-nav-secondary" aria-label="整理与处理">
        {(["archived", "abandoned", "attention"] as const).map(builtin)}
      </section>
    </div>
    <div className="collection-navigation-footer"><button type="button" aria-label="收集与保存设置" className="collection-nav-item" onClick={() => { closeTransient(); if (onOpenSettings) onOpenSettings(); else navigation.openSettings(); }}><Settings2 size={16} /><span>收集与保存</span></button>
      <button type="button" className="reading-shortcuts-trigger" aria-label="快捷键" title="快捷键" aria-expanded={shortcutsOpen} onClick={()=>setShortcutsOpen(!shortcutsOpen)}><Keyboard size={14}/></button>
      {shortcutsOpen&&<dl className="reading-shortcuts-popover" aria-label="阅读快捷键">
        <div><dt>阅读内搜索</dt><dd><kbd>/</kbd></dd></div>
        <div><dt>下一篇 / 上一篇</dt><dd><kbd>J</kbd> <kbd>K</kbd></dd></div>
        <div><dt>待读 / 进行中 / 已读</dt><dd><kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd></dd></div>
        <div><dt>归档</dt><dd><kbd>E</kbd></dd></div>
        <div><dt>关闭当前面板</dt><dd><kbd>Esc</kbd></dd></div>
      </dl>}
    </div>
  </nav>;
}
