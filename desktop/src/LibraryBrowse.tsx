import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, FileText, Folder, RotateCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { providerName } from "./ProviderLabels";
import { normalizeResults } from "./SearchResultNormalization";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import "./LibraryBrowse.css";

export function canBrowseLibrary(provider: LibrarySummary["provider"]) {
  return provider === "craft" || provider === "obsidian";
}

export function browseSubpage(result: SearchResult | undefined, href?: string, title?: string) {
  const marker = "#craft-subpage=";
  if (result?.provider !== "craft" || !href?.startsWith(marker)) return undefined;
  let blockId: string;
  try { blockId = decodeURIComponent(href.slice(marker.length)); } catch { return undefined; }
  if (!blockId) return undefined;
  const id = `craft-subpage:${result.spaceId}:${result.documentId}:${blockId}`;
  return { ...result, id, entityKey: id, blockId, pageId: blockId, title: title || result.title, documentTitle: title || result.documentTitle };
}

type FolderNode = { id: string; name: string; parentId?: string };
type DocumentNode = { id: string; title: string; path: string; folderId?: string; modifiedAt?: number };
type LibraryContents = { folders: FolderNode[]; documents: DocumentNode[]; craftLocationsSynced: boolean };

export type LibraryPosition = { libraryId: string; folderId: string; documentId?: string };

export function groupBrowseContents({ folders, documents }: LibraryContents) {
  const nodes = new Map(folders.map(folder => [folder.id, folder]));
  const children = new Map<string, FolderNode[]>();
  const pages = new Map<string, DocumentNode[]>();
  const unresolved: DocumentNode[] = [];
  for (const folder of folders) {
    const parent = folder.parentId && nodes.has(folder.parentId) ? folder.parentId : "";
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
    documentFolders.set(document.id, folder);
    const entries = pages.get(folder) ?? [];
    entries.push(document);
    pages.set(folder, entries);
  }
  return { nodes, children, pages, unresolved, documentFolders };
}

type BrowseTree = ReturnType<typeof groupBrowseContents>;

export function browseTrail(tree: BrowseTree, folderId: string) {
  const trail: FolderNode[] = [];
  const seen = new Set<string>();
  for (let folder = tree.nodes.get(folderId); folder && !seen.has(folder.id); folder = tree.nodes.get(folder.parentId ?? "")) {
    trail.unshift(folder);
    seen.add(folder.id);
  }
  return trail;
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
  const craft = library.provider === "craft";
  return {
    id: document.id, entityKey: `document:${library.id}:${document.id}`,
    documentId: document.id, blockId: document.id, provider: library.provider,
    libraryId: library.id, libraryName: library.name, spaceId: library.id, spaceName: library.name,
    contentType: craft ? "document" : "obsidian_markdown",
    sourceType: craft ? "craft_page" : "obsidian_page",
    title: document.title, documentTitle: document.title, path: document.path,
    folderId: document.folderId, modifiedAt: document.modifiedAt ?? undefined,
    snippet: "", matchTerms: [], matchField: "", matchCount: 0, subMatches: [],
  };
}

export function LibraryBrowse({ libraries, position, onPosition, selected, onPreview, onClosePreview }: {
  libraries: LibrarySummary[];
  position?: LibraryPosition;
  onPosition: (position: LibraryPosition) => void;
  selected?: SearchResult;
  onPreview: (result: SearchResult) => void;
  onClosePreview: () => void;
}) {
  const library = libraries.find(item => item.id === position?.libraryId) ?? libraries[0];
  const [cached, setCached] = useState<{ id: string; value: LibraryContents }>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expansion, setExpansion] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [search, setSearch] = useState<{ query: string; folders: string[] | null; context: string }>();
  const [hits, setHits] = useState<{ request: typeof search; results?: SearchResult[]; error?: string }>();
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [limit, setLimit] = useState(100);
  const libraryId = library?.id;
  const lastSync = library?.lastSync;
  const documentCount = library?.documentCount;
  useEffect(() => {
    if (!libraryId) return;
    let current = true;
    setLoading(true);
    setError("");
    void invoke<LibraryContents>("library_contents", { libraryId }).then(value => {
      if (current) setCached({ id: libraryId, value });
    }).catch(reason => {
      if (current) setError(String(reason));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [libraryId, lastSync, documentCount, revision]);

  const contents = cached?.id === libraryId ? cached?.value : undefined;
  const tree = useMemo(() => contents ? groupBrowseContents(contents) : undefined, [contents]);
  const locatedFolder = position?.documentId ? tree?.documentFolders.get(position.documentId) : undefined;
  const requestedFolder = position?.libraryId === libraryId ? locatedFolder ?? position?.folderId ?? "" : "";
  const folderId = requestedFolder && tree?.nodes.has(requestedFolder) ? requestedFolder : "";
  const trail = tree ? browseTrail(tree, folderId) : [];
  const activePath = new Set(trail.map(folder => folder.id));
  const context = JSON.stringify([libraryId, folderId]);
  const activeSearch = search?.context === context ? search : undefined;
  const matching = activeSearch && hits?.request === activeSearch ? hits : undefined;

  useEffect(() => {
    if (!activeSearch || !libraryId) return;
    let current = true;
    void invoke<unknown>("local_search", {
      query: activeSearch.query,
      spaceIds: [libraryId],
      folderIds: activeSearch.folders,
      includeDidaTasks: false,
      limit: 100,
    }).then(value => {
      if (current) setHits({ request: activeSearch, results: normalizeResults(value) });
    }).catch(reason => {
      if (current) setHits({ request: activeSearch, error: String(reason) });
    });
    return () => { current = false; };
  }, [activeSearch, libraryId]);

  if (!library) return <div className="library-browser-empty"><h1>资料库</h1><p>在设置中连接 Craft 或添加 Obsidian 库，即可按目录浏览。</p></div>;
  const move = (nextLibrary: string, nextFolder: string, keepPreview = false) => {
    onPosition({ libraryId: nextLibrary, folderId: nextFolder });
    setSearch(undefined);
    setInput("");
    setLimit(100);
    if (!keepPreview) onClosePreview();
  };
  const locate = (result: SearchResult) => {
    const folder = tree?.documentFolders.get(result.documentId);
    if (folder === undefined) return;
    move(library.id, folder, true);
    onPreview(result);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const query = input.trim();
    setSearch(query && tree ? { query, folders: browseFolderScope(tree, folderId, includeDescendants), context } : undefined);
  };
  function folderTree(parent: string, depth: number, visited = new Set<string>()) {
    return tree?.children.get(parent)?.map(folder => {
      if (visited.has(folder.id)) return null;
      const children = tree?.children.get(folder.id);
      const key = JSON.stringify([libraryId, folder.id]);
      const expanded = activePath.has(folder.id) || expansion[key] === true;
      return <li key={folder.id}>
        <div className="library-browser-tree-row" style={{ "--folder-depth": Math.min(depth, 8) } as CSSProperties}>
          {children?.length ? <button type="button" className="library-browser-disclosure" aria-label={`${expanded ? "折叠" : "展开"} ${folder.name}`} aria-expanded={expanded}
            onClick={() => {
              if (expanded && activePath.has(folder.id)) move(library.id, folder.parentId ?? "");
              setExpansion(current => ({ ...current, [key]: !expanded }));
            }}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="library-browser-disclosure" />}
          <button className="library-browser-node" aria-current={folderId === folder.id ? "location" : undefined} title={folder.name}
            onClick={() => { move(library.id, folder.id); setExpansion(current => ({ ...current, [key]: true })); }}>
            <Folder size={15} /><span>{folder.name}</span>
          </button>
        </div>
        {expanded && !!children?.length && <ul>{folderTree(folder.id, depth + 1, new Set([...visited, folder.id]))}</ul>}
      </li>;
    });
  }
  const folders = tree?.children.get(folderId) ?? [];
  const documents = [...(tree?.pages.get(folderId) ?? []), ...(!folderId ? tree?.unresolved ?? [] : [])];
  const selectedId = selected?.libraryId === library.id ? selected.documentId : undefined;
  const documentsToRender = selectedId && !documents.slice(0, limit).some(document => document.id === selectedId)
    ? documents.filter((document, index) => index < limit || document.id === selectedId)
    : documents.slice(0, limit);
  return <div className="library-browser" data-hub-keyboard-scope>
    <header className="library-browser-header">
      <h1>资料库</h1>
      <select aria-label="选择资料库" value={library.id} onChange={event => move(event.target.value, "")}>
        {libraries.map(item => <option key={item.id} value={item.id}>{item.name} · {providerName(item.provider)}</option>)}
      </select>
      <button type="button" className="library-browser-icon" onClick={() => setRevision(value => value + 1)} title="重新读取本地目录" aria-label="重新读取本地目录" disabled={loading}><RotateCw size={16} /></button>
      {selected && <button type="button" className="library-browser-icon" onClick={onClosePreview} title="收起预览" aria-label="收起预览"><X size={17} /></button>}
    </header>
    <div className="library-browser-body">
      <nav className="library-browser-tree" aria-label="资料库目录">
        <button className="library-browser-node library-browser-root" aria-current={!folderId ? "location" : undefined} title={library.name} onClick={() => move(library.id, "")}><Folder size={16} /><span>{library.name}</span></button>
        <ul>{folderTree("", 0)}</ul>
      </nav>
      <section className="library-browser-list" aria-label="当前目录内容">
        <nav className="library-browser-trail" aria-label="当前位置">
          <button onClick={() => move(library.id, "")}>{library.name}</button>
          {trail.map(folder => <span key={folder.id}><ChevronRight size={13} /><button title={folder.name} onClick={() => move(library.id, folder.id)}>{folder.name}</button></span>)}
        </nav>
        {selected?.contentType === "craft_subpage" && tree?.documentFolders.has(selected.documentId) && <button
          className="library-browser-more" onClick={() => {
            const root = contents?.documents.find(document => document.id === selected.documentId);
            if (root) onPreview(rootResult(library, root));
          }}>返回文档首页</button>}
        {tree && <form className="library-browser-search" onSubmit={submit}>
          <Search size={16} />
          <input aria-label="在当前目录搜索" placeholder="在当前目录搜索" value={input} onChange={event => {
            setInput(event.target.value);
            if (!event.target.value) setSearch(undefined);
          }} />
          <label><input type="checkbox" checked={includeDescendants} onChange={event => {
            setIncludeDescendants(event.target.checked);
            if (activeSearch) setSearch({ ...activeSearch, folders: browseFolderScope(tree, folderId, event.target.checked) });
          }} />包含下级</label>
          <button type="submit" className="library-browser-more">搜索</button>
          {activeSearch && <button type="button" aria-label="清除目录搜索" onClick={() => { setInput(""); setSearch(undefined); }}><X size={15} /></button>}
        </form>}
        {loading && !tree && <p role="status">正在读取本地目录…</p>}
        {error && <p role="alert">{tree ? "目录刷新失败，正在显示上次读取的内容。" : error}</p>}
        {!library.connected && <p className="library-browser-hint">来源不可用，正在浏览本地缓存。</p>}
        {contents && library.provider === "craft" && !contents.craftLocationsSynced && <p className="library-browser-hint">当前显示已缓存的目录与文档。完整同步后可刷新 Craft 文件夹归属。</p>}
        {tree && requestedFolder && !folderId && <p className="library-browser-hint">原目录已不可用，已显示资料库根目录。</p>}
        {activeSearch ? <>
          {!matching && <p role="status">正在搜索…</p>}
          {matching?.error && <p role="alert">{matching.error}</p>}
          {matching?.results?.length === 0 && <p role="status">当前范围没有找到匹配内容。</p>}
          {matching?.results?.length === 100 && <p role="status">显示前 100 条匹配结果。</p>}
          {matching?.results?.map(result => <div className="library-browser-search-result" key={result.entityKey}>
            <button className="library-browser-node" onClick={() => onPreview(result)} title={result.title}><FileText size={16} /><span>{result.title}<small>{result.path}</small></span></button>
            {tree?.documentFolders.has(result.documentId) && <button onClick={() => locate(result)}>定位</button>}
          </div>)}
        </> : tree && <>
          {folders.map(folder => <button className="library-browser-node" key={folder.id} title={folder.name} onClick={() => move(library.id, folder.id)}><Folder size={16} /><span>{folder.name}</span><ChevronRight size={14} /></button>)}
          {documentsToRender.map(document => <button className="library-browser-node" key={document.id} aria-current={selectedId === document.id ? "true" : undefined}
            title={document.path} onClick={() => onPreview(rootResult(library, document))}><FileText size={16} /><span>{document.title}<small>{document.folderId && !tree.nodes.has(document.folderId) ? "目录位置未知" : document.path}</small></span></button>)}
          {documents.length > limit && <button className="library-browser-more" onClick={() => setLimit(value => value + 100)}>显示更多文档</button>}
          {!folders.length && !documents.length && <p role="status">此目录暂无已索引内容。</p>}
        </>}
      </section>
    </div>
  </div>;
}
