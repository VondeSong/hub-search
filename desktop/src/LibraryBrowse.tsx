import { invoke } from "@tauri-apps/api/core";
import { ArrowLeft, ArrowUp, BookOpen, ChevronDown, ChevronRight, Columns3, FileText, Folder, FolderTree, Layers, PanelLeft, PanelRight, RotateCw, Search, Star, X } from "lucide-react";
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LibraryIcon } from "./LibraryIcon";
import { providerName } from "./ProviderLabels";
import { normalizeResults } from "./SearchResultNormalization";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { WorkspaceHeaderContext } from "./WorkspaceChrome";
import "./LibraryBrowse.css";

export function browseSubpage(result: SearchResult | undefined, href?: string, title?: string) {
  const marker = "#craft-subpage=";
  if (result?.provider !== "craft" || !href?.startsWith(marker)) return undefined;
  let blockId: string;
  try { blockId = decodeURIComponent(href.slice(marker.length)); } catch { return undefined; }
  if (!blockId) return undefined;
  const id = `craft-subpage:${result.spaceId}:${result.documentId}:${blockId}`;
  return {
    ...result, id, entityKey: id, blockId, pageId: blockId,
    contentType: "craft_subpage", sourceType: "craft_page",
    sourceItemId: undefined, sourceTitle: undefined, pageNumber: undefined,
    title: title || result.title, documentTitle: title || result.documentTitle,
  };
}

type FolderNode = { id: string; name: string; parentId?: string };
type DocumentNode = { id: string; title: string; path: string; folderId?: string; modifiedAt?: number; contentType?: string; nodeId?: string };
type LibraryContents = { folders: FolderNode[]; documents: DocumentNode[]; craftLocationsSynced: boolean; notice?: string };

export type LibraryPosition = { libraryId: string; folderId: string; documentId?: string };

export function useLibraryBrowseNavigation() {
  const [position, setPosition] = useState<LibraryPosition>();
  const [preview, setPreview] = useState<SearchResult>();
  return { position, setPosition, preview, setPreview };
}

export function groupBrowseContents({ folders, documents }: LibraryContents) {
  const nodes = new Map(folders.map(folder => [folder.id, folder]));
  const parents = new Map<string, string>();
  const detached = new Set<string>();
  for (const folder of nodes.values()) {
    const parent = folder.parentId && nodes.has(folder.parentId) ? folder.parentId : "";
    parents.set(folder.id, parent);
    if (folder.parentId && !parent) detached.add(folder.id);
  }
  // Repair only the navigation projection; cached source relationships stay intact.
  const resolved = new Set<string>();
  for (const id of nodes.keys()) {
    const path = new Set<string>();
    let cursor = id;
    while (cursor && !resolved.has(cursor)) {
      if (path.has(cursor)) {
        parents.set(cursor, "");
        detached.add(cursor);
        break;
      }
      path.add(cursor);
      cursor = parents.get(cursor) ?? "";
    }
    for (const visited of path) resolved.add(visited);
  }
  const children = new Map<string, FolderNode[]>();
  const pages = new Map<string, DocumentNode[]>();
  const unresolved: DocumentNode[] = [];
  for (const folder of nodes.values()) {
    const parent = parents.get(folder.id)!;
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  }
  const documentFolders = new Map<string, string>();
  for (const document of documents) {
    const folder = document.folderId ?? "";
    if (folder && !nodes.has(folder)) {
      unresolved.push(document);
      continue;
    }
    if (!documentFolders.has(document.id)) documentFolders.set(document.id, folder);
    const entries = pages.get(folder) ?? [];
    entries.push(document);
    pages.set(folder, entries);
  }
  return { nodes, parents, detached, children, pages, unresolved, documentFolders };
}

type BrowseTree = ReturnType<typeof groupBrowseContents>;
type LoadedLibrary = { version: string; contents?: LibraryContents; tree?: BrowseTree; error?: string };

function libraryVersion(library: LibrarySummary, revision: number) {
  return JSON.stringify([library.lastSync, library.documentCount, revision]);
}

export function browseTrail(tree: BrowseTree, folderId: string) {
  const trail: FolderNode[] = [];
  const seen = new Set<string>();
  for (let folder = tree.nodes.get(folderId); folder && !seen.has(folder.id); folder = tree.nodes.get(tree.parents.get(folder.id) ?? "")) {
    trail.push(folder);
    seen.add(folder.id);
  }
  return trail.reverse();
}

export function browseFolderScope(tree: BrowseTree, folderId: string, includeDescendants: boolean) {
  if (!folderId && includeDescendants) return null;
  const ids = new Set([folderId]);
  if (includeDescendants) {
    for (const id of ids) {
      for (const child of tree.children.get(id) ?? []) ids.add(child.id);
    }
  }
  return [...ids];
}

function rootResult(library: LibrarySummary, document: DocumentNode): SearchResult {
  const contentType = document.contentType ?? {
    craft: "document", obsidian: "obsidian_markdown", feishu: "feishu_document", dida365: "dida_task",
  }[library.provider];
  return {
    id: document.id, entityKey: document.nodeId
      ? `wiki:${library.id}:${document.nodeId}:${document.id}`
      : `document:${library.id}:${document.id}`,
    documentId: document.id, blockId: document.id, provider: library.provider,
    libraryId: library.id, libraryName: library.name, spaceId: library.id, spaceName: library.name,
    contentType,
    sourceType: library.provider === "craft" ? "craft_page" : library.provider === "obsidian" ? "obsidian_page" : contentType,
    title: document.title, documentTitle: document.title, path: document.path,
    folderId: document.folderId, modifiedAt: document.modifiedAt ?? undefined,
    snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
  };
}

export function LibraryBrowse({
  libraries, favorites = [], position, onPosition, selected, onPreview, onClosePreview, onExit, onToggleFavorite, preview,
}: {
  libraries: LibrarySummary[];
  favorites?: SearchResult[];
  position?: LibraryPosition;
  onPosition: (position: LibraryPosition) => void;
  selected?: SearchResult;
  onPreview: (result: SearchResult) => void;
  onClosePreview: () => void;
  onExit?: () => void;
  onToggleFavorite?: (result: SearchResult) => void;
  preview?: ReactNode;
}) {
  const header = useContext(WorkspaceHeaderContext);
  const library = libraries.find(item => item.id === position?.libraryId);
  const subpageLibraryId = selected?.contentType === "craft_subpage" ? selected.libraryId : undefined;
  const [cache, setCache] = useState<Record<string, LoadedLibrary>>({});
  const requested = useRef(new Map<string, string>());
  const [revision, refresh] = useState(0);
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const [openRoots, setOpenRoots] = useState<Record<string, boolean>>({});
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [readerOpen, setReaderOpen] = useState(true);
  const [mode, setMode] = useState<"tree" | "columns">("tree");
  const [showFavorites, setShowFavorites] = useState(false);
  const [folderQuery, setFolderQuery] = useState("");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"library" | "subtree" | "folder">("subtree");
  const [hits, setHits] = useState<{ request: object; results?: SearchResult[]; error?: string }>();
  // shortcut: loaded batches stay mounted; use windowing if real-library profiling requires it.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const columnStrip = useRef<HTMLDivElement>(null);
  const navigationTree = useRef<HTMLElement>(null);
  const currentFolders = useRef<Record<string, string>>({});
  const libraryIds = useMemo(() => libraries.map(item => item.id), [libraries]);
  const directoryQuery = folderQuery.trim().toLocaleLowerCase();

  useEffect(() => {
    for (const item of libraries) {
      const needed = !library || item.id === library.id || item.id === subpageLibraryId;
      if (!needed) continue;
      const version = libraryVersion(item, revision);
      if (requested.current.get(item.id) === version) continue;
      requested.current.set(item.id, version);
      void invoke<LibraryContents>("library_contents", { libraryId: item.id }).then(contents => {
        if (requested.current.get(item.id) === version) {
          setCache(current => ({ ...current, [item.id]: { version, contents, tree: groupBrowseContents(contents) } }));
        }
      }).catch(reason => {
        if (requested.current.get(item.id) === version) {
          setCache(current => ({ ...current, [item.id]: { ...current[item.id], version, error: String(reason) } }));
        }
      });
    }
  }, [libraries, library?.id, subpageLibraryId, directoryQuery, openRoots, revision]);

  const loaded = library ? cache[library.id] : undefined;
  const tree = loaded?.tree;
  const alreadyLocated = position?.documentId && tree?.pages.get(position.folderId)?.some(page => page.id === position.documentId);
  const locatedFolder = position?.documentId && !alreadyLocated ? tree?.documentFolders.get(position.documentId) : undefined;
  const requestedFolder = library ? locatedFolder ?? position?.folderId ?? "" : "";
  const folderId = tree?.nodes.has(requestedFolder) ? requestedFolder : "";
  const trail = useMemo(() => tree ? browseTrail(tree, folderId) : [], [tree, folderId]);
  const activePath = new Set(trail.map(folder => folder.id));
  const locationName = trail[trail.length - 1]?.name ?? library?.name ?? "全部库";
  const activeVersion = library ? libraryVersion(library, revision) : "";
  const searchRequest = useMemo(() => {
    if (!query || !libraryIds.length || (library && !tree && scope !== "library")) return undefined;
    const folders = tree && scope !== "library" ? browseFolderScope(tree, folderId, scope === "subtree") : null;
    const usesSourceStructure = library?.provider === "feishu" || library?.provider === "dida365";
    return {
      query,
      spaceIds: library ? [library.id] : libraryIds,
      folderIds: usesSourceStructure ? null : folders,
      documentIds: usesSourceStructure && folders ? [...new Set(folders.flatMap(id => tree?.pages.get(id)?.map(page => page.id) ?? []))] : null,
      includeDidaTasks: !library || library.provider === "dida365",
      limit: 100,
    };
  }, [query, library?.id, library?.provider, libraryIds, tree, folderId, scope]);
  const matching = hits?.request === searchRequest ? hits : undefined;
  const libraryFavorites = favorites.filter(result => libraryIds.includes(result.libraryId) && (!library || library.id === result.libraryId));
  const allDocuments = useMemo(() => libraries.flatMap(item =>
    cache[item.id]?.contents?.documents.map(document => rootResult(item, document)) ?? []), [libraries, cache]);
  const inColumns = mode === "columns" && !query && !showFavorites;

  const openPreview = (result: SearchResult) => { setReaderOpen(true); onPreview(result); };

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(input.trim()), 220);
    return () => window.clearTimeout(timer);
  }, [input]);

  useEffect(() => {
    if (!searchRequest) return;
    let current = true;
    void invoke<unknown>("local_search", searchRequest).then(value => {
      if (current) setHits({ request: searchRequest, results: normalizeResults(value) });
    }).catch(reason => {
      if (current) setHits({ request: searchRequest, error: String(reason) });
    });
    return () => { current = false; };
  }, [searchRequest]);

  useLayoutEffect(() => {
    const strip = columnStrip.current;
    if (strip && inColumns) strip.scrollLeft = strip.scrollWidth;
  }, [inColumns, library?.id, folderId, trail.length, Boolean(preview)]);

  useLayoutEffect(() => {
    navigationTree.current?.querySelector<HTMLElement>('[aria-current="location"]')?.scrollIntoView?.({ block: "nearest" });
  }, [library?.id, folderId, tree, directoryQuery, navigationOpen]);

  useEffect(() => {
    if (library && tree) currentFolders.current[library.id] = folderId;
  }, [library?.id, tree, folderId]);

  const clearSearch = () => {
    setInput("");
    setQuery("");
  };
  const move = (libraryId: string, folder: string, keepPreview = false, documentId?: string) => {
    const destination = cache[libraryId]?.tree;
    if (destination && folder) {
      setExpansion(current => {
        const next = { ...current };
        for (const node of browseTrail(destination, folder)) next[JSON.stringify([libraryId, node.id])] = true;
        return next;
      });
    }
    onPosition({ libraryId, folderId: folder, documentId });
    setShowFavorites(false);
    clearSearch();
    if (libraryId !== library?.id) setFolderQuery("");
    if (!keepPreview) onClosePreview();
  };
  const switchLibrary = (libraryId: string) => move(libraryId, currentFolders.current[libraryId] ?? "");
  const locate = (result: SearchResult) => {
    const resultTree = cache[result.libraryId]?.tree;
    const scopedFolders = result.libraryId === library?.id && searchRequest?.documentIds && resultTree
      ? browseFolderScope(resultTree, folderId, scope === "subtree") : null;
    const ownFolder = result.folderId !== undefined && (!scopedFolders || scopedFolders.includes(result.folderId))
      && resultTree?.pages.get(result.folderId)?.some(page => page.id === result.documentId) ? result.folderId : undefined;
    const scopedFolder = scopedFolders?.find(id => resultTree?.pages.get(id)?.some(page => page.id === result.documentId));
    const actualFolder = ownFolder ?? scopedFolder ?? resultTree?.documentFolders.get(result.documentId);
    move(result.libraryId, actualFolder ?? result.folderId ?? "", true, result.documentId);
    openPreview(result);
  };
  const up = () => library && move(trail.length ? library.id : "", trail[trail.length - 2]?.id ?? "");

  function folderTree(item: LibrarySummary, itemTree: BrowseTree, parent: string, depth: number, visited = new Set<string>()) {
    const folders = itemTree.children.get(parent) ?? [];
    const limitKey = JSON.stringify(["folders", item.id, parent]);
    const limit = limits[limitKey] ?? 100;
    return <>{folders.filter((folder, index) => index < limit || (item.id === library?.id && activePath.has(folder.id))).map(folder => {
      if (visited.has(folder.id)) return null;
      const hasChildren = Boolean(itemTree.children.get(folder.id)?.length);
      const key = JSON.stringify([item.id, folder.id]);
      const onPath = item.id === library?.id && activePath.has(folder.id);
      const expanded = (onPath && Boolean(position?.documentId)) || (expansion[key] ?? onPath);
      return <li key={folder.id}>
        <div className="library-browser-tree-row" style={{ "--folder-depth": Math.min(depth, 8) } as CSSProperties}>
          {hasChildren ? <button type="button" className="library-browser-disclosure" aria-label={`${expanded ? "折叠" : "展开"} ${folder.name}`} aria-expanded={expanded}
            onClick={() => setExpansion(current => ({ ...current, [key]: !expanded }))}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button> : <span className="library-browser-disclosure" />}
          <button className="library-browser-row" aria-current={onPath && folderId === folder.id && !showFavorites ? "location" : undefined}
            title={folder.name} onClick={() => {
              move(item.id, folder.id);
            }}>
            <Folder size={15} /><span>{folder.name}</span>
          </button>
        </div>
        {expanded && hasChildren && <ul>{folderTree(item, itemTree, folder.id, depth + 1, new Set([...visited, folder.id]))}</ul>}
      </li>;
    })}
      {folders.length > limit && <li><button className="library-browser-text-button"
        onClick={() => setLimits(current => ({ ...current, [limitKey]: limit + 100 }))}>显示更多目录</button></li>}
    </>;
  }

  const directoryMatches = directoryQuery ? (library ? [library] : libraries).flatMap(item => {
    const itemTree = cache[item.id]?.tree;
    if (!itemTree) return [];
    return Array.from(itemTree.nodes.values()).flatMap(folder => {
      const path = browseTrail(itemTree, folder.id).map(node => node.name).join(" / ");
      const qualifiedPath = `${item.name} / ${path}`;
      return qualifiedPath.toLocaleLowerCase().includes(directoryQuery) ? [{ item, folder, path: qualifiedPath }] : [];
    });
  }) : [];
  const directorySources = library ? [library] : libraries;
  const directoryLoading = directorySources.some(item => cache[item.id]?.version !== libraryVersion(item, revision));
  const directoryFailed = directorySources.some(item => Boolean(cache[item.id]?.error));

  function libraryRows() {
    return libraries.map(item => <button className="library-browser-row" key={item.id}
      aria-current={item.id === library?.id ? "location" : undefined} onClick={() => switchLibrary(item.id)}>
      <LibraryIcon {...item} compact /><span>{item.name}<small>{providerName(item.provider)} · {item.documentCount ?? 0} 篇文档</small></span><ChevronRight size={14} />
    </button>);
  }

  function folderRows(parent: string, nextFolder?: string) {
    if (!tree || !library) return null;
    const folders = tree.children.get(parent) ?? [];
    const documents = [...(tree.pages.get(parent) ?? []), ...(!parent ? tree.unresolved : [])];
    const key = JSON.stringify([library.id, parent]);
    const limit = limits[key] ?? 100;
    const folderKey = JSON.stringify(["folders", library.id, parent]);
    const folderLimit = limits[folderKey] ?? 100;
    return <>
      {folders.filter((folder, index) => index < folderLimit || folder.id === nextFolder).map(folder => <button className="library-browser-row" key={folder.id} title={folder.name}
        aria-current={folder.id === nextFolder ? "location" : undefined} onClick={() => move(library.id, folder.id)}>
        <Folder size={17} /><span>{folder.name}</span><ChevronRight size={14} />
      </button>)}
      {folders.length > folderLimit && <button className="library-browser-text-button"
        onClick={() => setLimits(current => ({ ...current, [folderKey]: folderLimit + 100 }))}>显示更多目录</button>}
      {documents.filter((document, index) => index < limit || (selected?.libraryId === library.id && selected.documentId === document.id)).map(document =>
        <button className="library-browser-row" key={JSON.stringify([document.nodeId, document.id])} title={document.path}
          aria-current={selected?.libraryId === library.id && selected.documentId === document.id && (!document.nodeId || selected.entityKey === rootResult(library, document).entityKey) ? "true" : undefined}
          onClick={() => openPreview(rootResult(library, document))}>
          <FileText size={17} /><span>{document.title}<small>{document.folderId && !tree.nodes.has(document.folderId) ? "目录位置未知" : document.path}</small></span>
        </button>)}
      {documents.length > limit && <button className="library-browser-text-button" onClick={() => setLimits(current => ({ ...current, [key]: limit + 100 }))}>显示更多文档</button>}
      {!folders.length && !documents.length && <p className="library-browser-hint" role="status">此目录暂时没有可浏览的内容。</p>}
    </>;
  }

  const resultRows = (results: SearchResult[]) => results.map(result => <div className="library-browser-result" key={result.entityKey}>
    <button className="library-browser-row" onClick={() => openPreview(result)} title={result.title}
      aria-current={selected?.entityKey === result.entityKey ? "true" : undefined}>
      <FileText size={17} /><span>{result.title}{result.snippet && <small className="library-browser-excerpt">{result.snippet}</small>}<small>{[!library && providerName(result.provider), !library && result.libraryName, result.path].filter(Boolean).join(" · ")}</small></span>
    </button>
    <div className="library-browser-result-actions">
    {onToggleFavorite && <button className="library-browser-text-button" aria-label={`收藏 ${result.title}`}
      aria-pressed={favorites.some(item => item.libraryId === result.libraryId && item.documentId === result.documentId)}
      onClick={() => onToggleFavorite(result)}><Star size={13} />收藏</button>}
    {(cache[result.libraryId]?.tree?.documentFolders.has(result.documentId) || !cache[result.libraryId]?.tree) &&
      <button className="library-browser-text-button" onClick={() => locate(result)}>定位</button>}
    </div>
  </div>);
  const locationStatus = <>
    {library && loaded?.version !== activeVersion && !tree && <p className="library-browser-hint" role="status">正在读取本地目录…</p>}
    {loaded?.version === activeVersion && loaded?.error && <p className="library-browser-hint" role="alert">{tree ? "目录刷新失败，正在显示上次读取的数据。" : loaded.error}</p>}
    {library && !library.connected && <p className="library-browser-hint">来源不可用，正在浏览本地缓存。</p>}
    {loaded?.contents?.notice && <p className="library-browser-hint">{loaded.contents.notice}</p>}
    {Boolean(tree?.detached.size) && <p className="library-browser-hint">部分目录的上级关系缺失或成环，已在当前库根目录提供浏览入口。</p>}
    {library?.provider === "craft" && loaded?.contents && !loaded.contents.craftLocationsSynced &&
      <p className="library-browser-hint">当前显示已缓存目录和文档。完成同步后可刷新 Craft 文件夹归属。</p>}
    {tree && requestedFolder && !folderId && <p className="library-browser-hint">原目录已不可用，当前显示资料库根目录。</p>}
  </>;
  const subpageLibrary = subpageLibraryId ? libraries.find(item => item.id === subpageLibraryId) : undefined;
  const rootDocument = subpageLibrary && cache[subpageLibrary.id]?.contents?.documents.find(document => document.id === selected?.documentId);
  const count = query ? matching?.results?.length : showFavorites ? libraryFavorites.length
    : library && tree ? (tree.children.get(folderId)?.length ?? 0) + (tree.pages.get(folderId)?.length ?? 0) + (!folderId ? tree.unresolved.length : 0)
      : library ? undefined : allDocuments.length;

  return <div className="library-browser" data-hub-keyboard-scope onKeyDown={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.querySelector<HTMLInputElement>(".library-browser-search input")?.focus();
    } else if (event.key === "Escape" && (input || folderQuery)) {
      event.preventDefault(); event.stopPropagation(); clearSearch(); setFolderQuery("");
    }
  }}>
    {navigationOpen && <aside className="library-browser-navigation" aria-label="资料库导航">
      <header><h1>库结构</h1></header>
      <div className="library-browser-navigation-tools">
        <label className="library-browser-library-select">浏览范围<select aria-label="选择资料库" value={library?.id ?? ""} onChange={event => switchLibrary(event.target.value)}>
          <option value="">全部库</option>
          {libraries.map(item => <option key={item.id} value={item.id}>{item.name} · {providerName(item.provider)}</option>)}
        </select></label>
        <div className="library-browser-shortcuts">
          <button className="library-browser-row" aria-current={!library && !showFavorites ? "page" : undefined} onClick={() => switchLibrary("")}>
            <Layers size={16} /><span>全部库</span><small>{libraries.length}</small>
          </button>
          <button className="library-browser-row" aria-current={showFavorites ? "page" : undefined} onClick={() => {
            setShowFavorites(true); clearSearch(); onClosePreview();
          }}>
            <Star size={16} /><span>收藏</span><small>{libraryFavorites.length}</small>
          </button>
        </div>
        <div className="library-browser-field">
          <Search size={15} /><input aria-label="快速定位目录" placeholder="快速定位目录…" value={folderQuery}
            onChange={event => setFolderQuery(event.target.value)} />
          {folderQuery && <button type="button" className="library-browser-icon" aria-label="清除目录定位" onClick={() => setFolderQuery("")}><X size={14} /></button>}
        </div>
      </div>
      <div className="library-browser-tree-caption"><span>{directoryQuery ? "匹配的目录" : "目录结构"}</span>
        <button className="library-browser-icon" onClick={() => refresh(value => value + 1)} title="重新读取本地目录" aria-label="重新读取本地目录"><RotateCw size={14} /></button>
      </div>
      <nav className="library-browser-tree" aria-label="资料库目录" ref={navigationTree}>
        {directoryQuery ? <>
          {directoryMatches.slice(0, 60).map(({item, folder, path}) =>
            <button className="library-browser-row" key={JSON.stringify([item.id, folder.id])} title={path}
              onClick={() => { move(item.id, folder.id); setFolderQuery(""); }}>
              <Folder size={15} /><span>{folder.name}<small>{path}</small></span>
            </button>)}
          {directoryLoading && <p className="library-browser-hint" role="status">正在读取目录…</p>}
          {!directoryLoading && directoryFailed && <p className="library-browser-hint" role="status">部分目录读取失败，可刷新后重试。</p>}
          {!directoryLoading && !directoryFailed && !directoryMatches.length && <p className="library-browser-hint">没有匹配的目录。</p>}
          {directoryMatches.length > 60 && <p className="library-browser-hint">显示前 60 个目录，请缩小关键词范围。</p>}
        </> : (library ? [library] : libraries).map(item => {
          const itemCache = cache[item.id];
          const expanded = library?.id === item.id || openRoots[item.id];
          return <div key={item.id} className="library-browser-tree-root">
            <div className="library-browser-tree-row">
              {!library && <button className="library-browser-disclosure" aria-expanded={Boolean(expanded)}
                aria-label={`${expanded ? "折叠" : "展开"} ${item.name}`} onClick={() => setOpenRoots(current => ({ ...current, [item.id]: !expanded }))}>
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </button>}
              <button className="library-browser-row" aria-current={library?.id === item.id && !folderId && !showFavorites ? "location" : undefined}
                onClick={() => move(item.id, "")}><LibraryIcon {...item} compact /><span>{item.name}</span></button>
            </div>
            {expanded && itemCache?.tree && <ul>{folderTree(item, itemCache.tree, "", library ? 0 : 1)}</ul>}
            {expanded && !library && !itemCache?.tree && <p className="library-browser-hint" role="status">{itemCache?.error ?? "正在读取目录…"}</p>}
          </div>;
        })}
      </nav>
    </aside>}
    {navigationOpen && header?.navigationResizer}
    <div className="library-browser-main">
      <header className="library-browser-header" onMouseDown={header?.onMouseDown}>
        <button className="library-browser-icon library-browser-nav-toggle" aria-expanded={navigationOpen}
          aria-label={navigationOpen ? "收起库结构" : "展开库结构"} title={navigationOpen ? "收起库结构" : "展开库结构"}
          onClick={() => setNavigationOpen(value => !value)}><PanelLeft size={17} /></button>
        <div className="library-browser-title"><strong>资料库</strong><ChevronRight size={13} /><span title={library?.name}>{library?.name ?? "全部库"}</span></div>
        <form className="library-browser-field library-browser-search" onSubmit={event => {
          event.preventDefault(); setQuery(input.trim());
        }}>
          <Search size={16} /><input aria-label={library ? "在当前目录搜索" : "搜索全部库"} placeholder={library ? "搜索当前范围…" : "搜索全部库…"}
            value={input} onChange={event => {
              setShowFavorites(false);
              setInput(event.target.value);
              if (!event.target.value.trim()) setQuery("");
            }} />
          {input && <button type="button" className="library-browser-icon" aria-label="清除目录搜索" onClick={clearSearch}><X size={15} /></button>}
        </form>
        {onExit && <button className="library-browser-exit" onClick={onExit} aria-label="返回全部内容" title="返回全部内容"><ArrowLeft size={15} /><span>返回全部内容</span></button>}
        {header?.actions}
      </header>
      <div className="library-browser-scope">
        <nav className="library-browser-trail" aria-label="当前位置">
          <button onClick={() => switchLibrary("")}><Layers size={14} />全部库</button>
          {library && <><ChevronRight size={13} /><button onClick={() => move(library.id, "")}>{library.name}</button></>}
          {trail.map(folder => <span key={folder.id}><ChevronRight size={13} />
            <button title={folder.name} onClick={() => library && move(library.id, folder.id)}>{folder.name}</button>
          </span>)}
        </nav>
        {library && <label>搜索范围<select aria-label="搜索范围" value={scope}
          onChange={event => setScope(event.target.value as typeof scope)}>
          <option value="library">当前库</option>
          <option value="subtree">当前位置及下级</option>
          <option value="folder">仅当前位置</option>
        </select></label>}
      </div>
      <div className="library-browser-toolbar">
        <div role="group" aria-label="浏览方式">
          <button aria-pressed={mode === "tree"} onClick={() => setMode("tree")}><FolderTree size={15} />目录树</button>
          <button aria-pressed={mode === "columns"} onClick={() => setMode("columns")}><Columns3 size={15} />分栏浏览</button>
        </div>
        {rootDocument && subpageLibrary && <button className="library-browser-text-button" onClick={() => onPreview(rootResult(subpageLibrary, rootDocument))}>返回文档首页</button>}
        {inColumns && <button className="library-browser-icon" aria-label={readerOpen ? "收起阅读区" : "显示阅读区"}
          aria-pressed={readerOpen} onClick={() => setReaderOpen(value => !value)}><PanelRight size={16} /></button>}
      </div>
      <div className={`library-browser-body${inColumns ? " library-browser-column-mode" : ""}${preview && readerOpen ? " library-browser-reading" : ""}`}>
        {inColumns ? <div className="library-browser-columns" ref={columnStrip} aria-label="目录分栏">
          <section className="library-browser-column"><h2>全部库</h2>{libraryRows()}
            {!libraries.length && <p className="library-browser-hint">在设置中接入资料库后，即可在这里浏览。</p>}
          </section>
          {library && [{ id: "", name: library.name }, ...trail].map((folder, index) =>
            <section className="library-browser-column" key={folder.id}>
              <h2 title={folder.name}>{folder.name}</h2>
              {!index && locationStatus}
              {folderRows(folder.id, trail[index]?.id)}
            </section>)}
        </div> : <section className="library-browser-list" aria-label="当前目录内容">
          <header><div><h2 title={locationName}>{query ? "搜索结果" : showFavorites ? "收藏" : locationName}</h2>
            {count !== undefined && <p>{count}{query && count === 100 ? "+" : ""} 项内容</p>}</div>
            <button className="library-browser-icon" aria-label={readerOpen ? "收起阅读区" : "显示阅读区"}
              aria-pressed={readerOpen} onClick={() => setReaderOpen(value => !value)}><PanelRight size={16} /></button>
          </header>
          {library && !query && !showFavorites && <button className="library-browser-up" onClick={up}><ArrowUp size={14} />返回上级</button>}
          {locationStatus}
          <div className="library-browser-list-items">
            {query ? <>
              {!matching && <p className="library-browser-hint" role="status">{loaded?.error && !tree ? "目录读取失败，请刷新目录或将搜索范围设为当前库。" : libraries.length ? "正在搜索…" : "暂无可搜索的资料库。"}</p>}
              {matching?.error && <p className="library-browser-hint" role="alert">{matching.error}</p>}
              {matching?.results?.length === 0 && <p className="library-browser-hint" role="status">当前范围没有找到匹配内容。</p>}
              {matching?.results && resultRows(matching.results)}
            </> : showFavorites ? libraryFavorites.length ? resultRows(libraryFavorites)
              : <p className="library-browser-hint">当前范围内没有收藏。</p>
              : library ? folderRows(folderId) : <>
                {directoryLoading && <p className="library-browser-hint" role="status">正在读取各库的本地内容…</p>}
                {directoryFailed && <p className="library-browser-hint" role="status">部分资料库读取失败，可刷新目录重试；已读取内容仍可浏览。</p>}
                {resultRows(allDocuments.slice(0, limits.all ?? 100))}
                {allDocuments.length > (limits.all ?? 100) && <button className="library-browser-text-button"
                  onClick={() => setLimits(current => ({ ...current, all: (current.all ?? 100) + 100 }))}>显示更多文档</button>}
                {!directoryLoading && !allDocuments.length && libraries.length > 0 && <p className="library-browser-hint">暂无已缓存的文档。</p>}
              </>}
            {!libraries.length && !query && !showFavorites && <p className="library-browser-hint">在设置中接入资料库后，即可在这里浏览。</p>}
          </div>
        </section>}
        <section className="library-browser-reader desktop-workspace" aria-label="阅读区" hidden={!readerOpen}>
          <div className="library-browser-reader-toolbar"><BookOpen size={15} /><span>{selected?.title || "文档预览"}</span></div>
          {preview ?? <div className="library-browser-reader-empty">
            <BookOpen size={25} /><h2>尚未选择文档</h2><p>从{inColumns ? "分栏" : "列表"}中选一篇文档，在这里预览。</p>
          </div>}
        </section>
      </div>
    </div>
  </div>;
}
