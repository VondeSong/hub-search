import { userProfileStorage } from "./UserProfileStorage";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CollectionPageSnapshot } from "./CollectionPage";
import { defaultCollectionCards, cardFields, type CollectionCards } from "./CollectionCardConfig";
import { collectionSortFields, normalizeCollectionSorts, type CollectionSortField, type CollectionSortRule } from "./CollectionSort";

export type CollectionSource = "all" | "bookmarks" | "likes" | "telegram" | "dida";
export type CollectionStatus = "all" | "unread" | "in_progress" | "read" | "archived" | "abandoned";
export type CollectionMedia = "all" | "photo" | "video" | "links";
export type CollectionLayout = "list" | "table" | "board" | "gallery";
export type CollectionDateFilter = "any" | "7" | "30" | "90";
export type CollectionColumn = "source" | "author" | "published" | "collected" | "media" | "liked" | "destination";
export type CollectionTableColumn = CollectionColumn | "status" | "title";
export type CollectionBuiltinEntry = "all" | "unread" | "in_progress" | "read" | "archived" | "abandoned" | "attention";
export type CollectionEntry = { kind: "builtin"; id: CollectionBuiltinEntry } | { kind: "view" | "library"; id: string };

export type CollectionView = {
  id: string;
  name: string;
  layout: CollectionLayout;
  source: CollectionSource;
  status: CollectionStatus;
  media: CollectionMedia;
  query: string;
  tags: string[];
  dateFilter: CollectionDateFilter;
  destinationId: string;
  attentionOnly: boolean;
  sort: CollectionSortField;
  ascending: boolean;
  sorts?: CollectionSortRule[];
  density: "compact" | "comfortable";
  colorMode?: "none" | "source" | "status";
  columns: Record<CollectionColumn, boolean>;
  widths?: Partial<Record<CollectionTableColumn, number>>;
  cards?: CollectionCards;
};
export type CollectionViewSettings = CollectionView;
export type CollectionSavedView = CollectionView & { hidden: boolean };
export type CollectionNavigationCounts = {
  all: number;
  unread: number;
  inProgress: number;
  read: number;
  archived: number;
  abandoned: number;
  needsAttention: number;
  savedCopies: { libraryId: string; count: number }[];
};
export type CollectionViewsState = {
  version: 2;
  view: CollectionView;
  views: CollectionSavedView[];
  activeEntry: CollectionEntry;
  layoutPreferences: Partial<Record<CollectionLayout, CollectionView>>;
  librariesCollapsed: boolean;
};

export const COLLECTION_VIEWS_KEY = "hub.collection.navigation.v2";
export const LEGACY_COLLECTION_VIEWS_KEY = "hub.collection.views.v1";
export const collectionLayoutLabels: Record<CollectionLayout, string> = { list: "列表", table: "表格", board: "看板", gallery: "画廊" };
export const collectionEntryLabels: Record<CollectionBuiltinEntry, string> = { all: "全部内容", unread: "待读", in_progress: "进行中", read: "已读", archived: "归档", abandoned: "放弃", attention: "需要处理" };
const layouts: CollectionLayout[] = ["list", "table", "board", "gallery"];
const statuses: CollectionStatus[] = ["all", "unread", "in_progress", "read", "archived", "abandoned"];
const columns: CollectionColumn[] = ["source", "author", "published", "collected", "media", "liked", "destination"];
const builtinIds = new Set<string>(Object.keys(collectionEntryLabels));
const emptyCounts: CollectionNavigationCounts = { all: 0, unread: 0, inProgress: 0, read: 0, archived: 0, abandoned: 0, needsAttention: 0, savedCopies: [] };

export function defaultCollectionView(layout: CollectionLayout = "list"): CollectionView {
  return { id: `builtin:all`, name: "全部内容", layout, source: "all", status: "all", media: "all", query: "", tags: [], dateFilter: "any", destinationId: "", attentionOnly: false, sort: "collected", ascending: false, density: "comfortable", columns: { source: true, author: true, published: true, collected: false, media: true, liked: false, destination: true } };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown, fallback = "", limit = 4000): string { return typeof value === "string" ? value.slice(0, limit) : fallback; }
function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T { return options.includes(value as T) ? value as T : fallback; }
function parseCards(value: unknown): CollectionCards | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = record(value);
  const fields = Object.keys(cardFields);
  return {
    ...defaultCollectionCards,
    size: oneOf(candidate.size, ["compact", "comfortable", "spacious"] as const, "comfortable"),
    coverMode: oneOf(candidate.coverMode, ["crop", "fit"] as const, "crop"),
    cover: typeof candidate.cover === "boolean" ? candidate.cover : defaultCollectionCards.cover,
    fullTitle: candidate.fullTitle === true,
    wrap: candidate.wrap === true,
    names: candidate.names === true,
    compact: candidate.compact !== false,
    hidden: Array.isArray(candidate.hidden) ? candidate.hidden.filter((field): field is keyof typeof cardFields => typeof field === "string" && fields.includes(field)) : [...defaultCollectionCards.hidden],
    rules: Array.isArray(candidate.rules) ? candidate.rules.flatMap((value) => {
      const rule = record(value);
      if (!fields.includes(text(rule.field)) || !["equals", "contains", "not_contains", "is_empty", "is_not_empty"].includes(text(rule.operator))) return [];
      return [{ id: text(rule.id, "rule", 100), field: rule.field as keyof typeof cardFields, operator: rule.operator as CollectionCards["rules"][number]["operator"], value: text(rule.value), color: text(rule.color, "#eef5ff", 100) }];
    }).slice(0, 50) : [],
  };
}
export function normalizeCollectionView(value: unknown): CollectionView {
  const candidate = record(value), base = defaultCollectionView();
  const candidateColumns = record(candidate.columns);
  const widths = Object.fromEntries(Object.entries(record(candidate.widths)).filter(([field, width]) => [...columns, "status", "title"].includes(field) && typeof width === "number" && Number.isFinite(width) && width >= 20 && width <= 5000)) as CollectionView["widths"];
  const sort = oneOf(candidate.sort, Object.keys(collectionSortFields) as CollectionSortField[], "collected");
  const ascending = candidate.ascending === true;
  return {
    ...base,
    id: text(candidate.id, base.id, 200), name: text(candidate.name, base.name, 60).trim() || base.name,
    layout: oneOf(candidate.layout, layouts, "list"), source: oneOf(candidate.source, ["all", "bookmarks", "likes", "telegram", "dida"] as const, "all"), status: oneOf(candidate.status, statuses, "all"), media: oneOf(candidate.media, ["all", "photo", "video", "links"] as const, "all"),
    query: text(candidate.query), tags: Array.isArray(candidate.tags) ? [...new Set(candidate.tags.filter((tag): tag is string => typeof tag === "string" && !!tag.trim()).map(tag => tag.trim()))].slice(0, 100) : [],
    dateFilter: oneOf(candidate.dateFilter, ["any", "7", "30", "90"] as const, "any"), destinationId: text(candidate.destinationId, "", 200), attentionOnly: candidate.attentionOnly === true,
    sort, ascending, sorts: normalizeCollectionSorts(candidate.sorts, sort, ascending), density: candidate.density === "compact" ? "compact" : "comfortable",
    ...(candidate.colorMode === "source" || candidate.colorMode === "status" ? { colorMode: candidate.colorMode } : {}),
    columns: Object.fromEntries(columns.map(column => [column, typeof candidateColumns[column] === "boolean" ? candidateColumns[column] : base.columns[column]])) as CollectionView["columns"],
    ...(Object.keys(widths || {}).length ? { widths } : {}), ...(candidate.cards ? { cards: parseCards(candidate.cards) } : {}),
  };
}
function parseViews(value: unknown): CollectionSavedView[] {
  const ids = new Set<string>();
  return Array.isArray(value) ? value.flatMap(candidate => {
    const item = record(candidate), id = text(item.id, "", 200), name = text(item.name, "", 60).trim();
    if (!id || !name || ids.has(id)) return [];
    ids.add(id);
    return [{ ...normalizeCollectionView(item), id, name, hidden: item.hidden === true }];
  }).slice(0, 30) : [];
}
function inferredEntry(view: CollectionView): CollectionEntry {
  if (view.attentionOnly) return { kind: "builtin", id: "attention" };
  if (view.destinationId) return { kind: "library", id: view.destinationId };
  return { kind: "builtin", id: view.status };
}
function parseEntry(value: unknown, views: CollectionSavedView[], view: CollectionView): CollectionEntry {
  const entry = record(value);
  if (entry.kind === "builtin" && builtinIds.has(text(entry.id))) return { kind: "builtin", id: entry.id as CollectionBuiltinEntry };
  if (entry.kind === "library" && text(entry.id)) return { kind: "library", id: text(entry.id) };
  if (entry.kind === "view" && views.some(item => item.id === entry.id && !item.hidden)) return { kind: "view", id: text(entry.id) };
  return inferredEntry(view);
}
function isLegacySystemView(view: CollectionSavedView): boolean {
  const ordinary = layouts.includes(view.id as CollectionLayout) && view.name === collectionLayoutLabels[view.id as CollectionLayout];
  const archive = view.id === "archive" && view.name === "归档" && view.layout === "list";
  if (!ordinary && !archive) return false;
  const unmodifiedFilter = view.source === "all" && view.status === (archive ? "archived" : "all") && view.media === "all" && !view.query && !view.tags.length && view.dateFilter === "any" && !view.destinationId && !view.attentionOnly;
  const sorts = normalizeCollectionSorts(view.sorts, view.sort, view.ascending);
  const unmodifiedSort = sorts.length === 1 && sorts[0].field === "collected" && !sorts[0].ascending;
  const defaultColumns = defaultCollectionView().columns;
  const archiveDisplayChanged = archive && (view.density !== "comfortable" || !!view.cards || !!view.widths || columns.some(column => view.columns[column] !== defaultColumns[column]));
  return unmodifiedFilter && unmodifiedSort && !archiveDisplayChanged;
}
export function parseCollectionViews(raw: string | null, legacyRaw: string | null = null): CollectionViewsState {
  const base: CollectionViewsState = { version: 2, view: defaultCollectionView(), views: [], activeEntry: { kind: "builtin", id: "all" }, layoutPreferences: {}, librariesCollapsed: true };
  try {
    const value = record(JSON.parse(raw || "null"));
    if (value.version === 2) {
      const view = normalizeCollectionView(value.view), views = parseViews(value.views);
      const preferences = record(value.layoutPreferences);
      return { ...base, view, views, activeEntry: parseEntry(value.activeEntry, views, view), librariesCollapsed: value.librariesCollapsed !== false, layoutPreferences: Object.fromEntries(layouts.filter(layout => preferences[layout]).map(layout => [layout, normalizeCollectionView({ ...record(preferences[layout]), layout })])) };
    }
  } catch { /* Recover from an invalid new store using the retained legacy store. */ }
  try {
    const legacy = record(JSON.parse(legacyRaw || "null"));
    const legacyViews = parseViews(legacy.views);
    if (!legacyViews.length) return base;
    const selected = legacyViews.find(view => view.id === legacy.active) || legacyViews[0];
    const view = normalizeCollectionView(selected);
    const saved = legacyViews.filter(view => !isLegacySystemView(view));
    const activeEntry: CollectionEntry = saved.some(item => item.id === selected.id) ? { kind: "view", id: selected.id } : inferredEntry(view);
    const layoutPreferences: CollectionViewsState["layoutPreferences"] = {};
    for (const item of legacyViews) if (layouts.includes(item.id as CollectionLayout)) layoutPreferences[item.layout] = normalizeCollectionView(item);
    return { ...base, view, views: saved, activeEntry, layoutPreferences };
  } catch { return base; }
}
function loadCollectionViews(): CollectionViewsState {
  try { return parseCollectionViews(userProfileStorage.getItem(COLLECTION_VIEWS_KEY), userProfileStorage.getItem(LEGACY_COLLECTION_VIEWS_KEY)); }
  catch { return parseCollectionViews(null); }
}
function comparableView(view: CollectionView): string {
  const { id: _id, name: _name, ...settings } = normalizeCollectionView(view);
  return JSON.stringify(settings);
}
function withCurrent(state: CollectionViewsState, view: CollectionView): CollectionViewsState {
  return { ...state, view, layoutPreferences: { ...state.layoutPreferences, [view.layout]: view } };
}
function selectBuiltinState(state: CollectionViewsState, id: CollectionBuiltinEntry): CollectionViewsState {
  return withCurrent({ ...state, activeEntry: { kind: "builtin", id } }, { ...state.view, id: `builtin:${id}`, name: collectionEntryLabels[id], status: id === "attention" ? "all" : id, destinationId: "", attentionOnly: id === "attention" });
}
export type CollectionViewsContextValue = {
  pageSnapshot: RefObject<CollectionPageSnapshot | null>;
  dataRevision: RefObject<number>;
  view: CollectionView;
  views: CollectionSavedView[];
  activeEntry: CollectionEntry;
  isModified: boolean;
  navigationCounts: CollectionNavigationCounts;
  counts: CollectionNavigationCounts;
  setNavigationCounts: (counts: CollectionNavigationCounts) => void;
  updateView: (patch: Partial<CollectionView>) => void;
  selectLayout: (layout: CollectionLayout) => void;
  selectBuiltin: (id: CollectionBuiltinEntry) => void;
  selectLibrary: (id: string) => void;
  selectView: (id: string) => void;
  saveView: (name: string, patch?: Partial<CollectionView>) => boolean;
  saveCurrentView: (name: string, patch?: Partial<CollectionView>) => boolean;
  updateSavedView: () => void;
  renameView: (id: string, name: string) => boolean;
  deleteView: (id: string) => void;
  moveView: (id: string, direction: -1 | 1) => void;
  setViewHidden: (id: string, hidden: boolean) => void;
  librariesCollapsed: boolean;
  setLibrariesCollapsed: (collapsed: boolean) => void;
  settingsRevision: number;
  openSettings: () => void;
  session: CollectionSession;
  updateSession: (patch: Partial<CollectionSession>) => void;
};
export type CollectionSession = { selectedKey: string | null; previewEnabled: boolean; scrollTop: number; offset: number };
const CollectionViewsContext = createContext<CollectionViewsContextValue | null>(null);
export function CollectionViewsProvider({ children }: { children: ReactNode }) {
  // Retain only the last local page in this provider's lifetime. Returning to
  // reading can show it immediately while a fresh read checks the local store.
  const pageSnapshot = useRef<CollectionPageSnapshot | null>(null);
  const dataRevision = useRef(0);
  useEffect(() => {
    const changed = () => { pageSnapshot.current = null; dataRevision.current++; };
    window.addEventListener("hub:reading-data-changed", changed);
    return () => window.removeEventListener("hub:reading-data-changed", changed);
  }, []);
  const [state, setState] = useState(loadCollectionViews);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [counts, setCounts] = useState<CollectionNavigationCounts>(emptyCounts);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const [session, setSession] = useState<CollectionSession>({ selectedKey: null, previewEnabled: true, scrollTop: 0, offset: 0 });
  const setNavigationCounts = useCallback((next: CollectionNavigationCounts) => setCounts(current => JSON.stringify(current) === JSON.stringify(next) ? current : next), []);
  useEffect(() => { try { userProfileStorage.setItem(COLLECTION_VIEWS_KEY, JSON.stringify(state)); } catch { /* Navigation remains available if storage is full. */ } }, [state]);
  const actions = useMemo(() => {
    const resetPosition = () => setSession(current => current.offset === 0 && current.scrollTop === 0 ? current : { ...current, offset: 0, scrollTop: 0 });
    const saveView = (name: string, patch: Partial<CollectionView> = {}) => {
      const cleanName = name.trim().slice(0, 60);
      if (!cleanName || stateRef.current.views.length >= 30) return false;
      const id = crypto.randomUUID();
      setState(current => { if (current.views.length >= 30) return current; const view = normalizeCollectionView({ ...current.view, ...patch, id, name: cleanName }); return withCurrent({ ...current, views: [...current.views, { ...view, hidden: false }], activeEntry: { kind: "view", id } }, view); });
      resetPosition();
      return true;
    };
    return {
      updateView: (patch: Partial<CollectionView>) => {
        setState(current => {
          const view = { ...current.view, ...patch };
          if (current.activeEntry.kind === "view" || !["status", "destinationId", "attentionOnly"].some(key => Object.prototype.hasOwnProperty.call(patch, key))) return withCurrent(current, view);
          const activeEntry = inferredEntry(view);
          const identity = activeEntry.kind === "builtin" ? { id: `builtin:${activeEntry.id}`, name: collectionEntryLabels[activeEntry.id] } : { id: `library:${activeEntry.id}`, name: "已保存副本" };
          return withCurrent({ ...current, activeEntry }, { ...view, ...identity });
        });
        if (Object.keys(patch).some(key => ["source", "status", "media", "query", "tags", "dateFilter", "destinationId", "attentionOnly"].includes(key))) resetPosition();
      },
      selectLayout: (layout: CollectionLayout) => setState(current => {
        const previous = current.layoutPreferences[layout];
        const display = previous ? { density: previous.density, columns: previous.columns, widths: previous.widths, cards: previous.cards } : {};
        return withCurrent(current, { ...current.view, ...display, layout });
      }),
      selectBuiltin: (id: CollectionBuiltinEntry) => { setState(current => selectBuiltinState(current, id)); resetPosition(); },
      selectLibrary: (id: string) => { setState(current => withCurrent({ ...current, activeEntry: { kind: "library", id } }, { ...current.view, id: `library:${id}`, name: "已保存副本", status: "all", destinationId: id, attentionOnly: false })); resetPosition(); },
      selectView: (id: string) => { setState(current => { const selected = current.views.find(view => view.id === id && !view.hidden); return selected ? withCurrent({ ...current, activeEntry: { kind: "view", id } }, normalizeCollectionView(selected)) : current; }); resetPosition(); },
      saveView, saveCurrentView: saveView,
      updateSavedView: () => setState(current => current.activeEntry.kind === "view" ? { ...current, views: current.views.map(view => view.id === current.activeEntry.id ? { ...current.view, id: view.id, name: view.name, hidden: view.hidden } : view) } : current),
      renameView: (id: string, name: string) => { const cleanName = name.trim().slice(0, 60); if (!cleanName || !stateRef.current.views.some(view => view.id === id)) return false; setState(current => ({ ...current, views: current.views.map(view => view.id === id ? { ...view, name: cleanName } : view), view: current.activeEntry.kind === "view" && current.activeEntry.id === id ? { ...current.view, name: cleanName } : current.view })); return true; },
      deleteView: (id: string) => setState(current => { const next = { ...current, views: current.views.filter(view => view.id !== id) }; return current.activeEntry.kind === "view" && current.activeEntry.id === id ? selectBuiltinState(next, "all") : next; }),
      moveView: (id: string, direction: -1 | 1) => setState(current => { const index = current.views.findIndex(view => view.id === id), target = index + direction; if (index < 0 || target < 0 || target >= current.views.length) return current; const views = [...current.views]; views.splice(target, 0, views.splice(index, 1)[0]); return { ...current, views }; }),
      setViewHidden: (id: string, hidden: boolean) => setState(current => { const next = { ...current, views: current.views.map(view => view.id === id ? { ...view, hidden } : view) }; return hidden && current.activeEntry.kind === "view" && current.activeEntry.id === id ? selectBuiltinState(next, "all") : next; }),
      setLibrariesCollapsed: (collapsed: boolean) => setState(current => ({ ...current, librariesCollapsed: collapsed })), openSettings: () => setSettingsRevision(value => value + 1), updateSession: (patch: Partial<CollectionSession>) => setSession(current => Object.entries(patch).every(([key, value]) => current[key as keyof CollectionSession] === value) ? current : { ...current, ...patch }),
    };
  }, []);
  const value = useMemo<CollectionViewsContextValue>(() => {
    const saved = state.activeEntry.kind === "view" ? state.views.find(view => view.id === state.activeEntry.id) : undefined;
    return { ...actions, pageSnapshot, dataRevision, view: state.view, views: state.views, activeEntry: state.activeEntry, isModified: !!saved && comparableView(state.view) !== comparableView(saved), counts, navigationCounts: counts, setNavigationCounts, librariesCollapsed: state.librariesCollapsed, settingsRevision, session };
  }, [state, counts, settingsRevision, session, actions, setNavigationCounts]);
  return <CollectionViewsContext.Provider value={value}>{children}</CollectionViewsContext.Provider>;
}
export function useOptionalCollectionViews(): CollectionViewsContextValue | null { return useContext(CollectionViewsContext); }
export function useCollectionViews(): CollectionViewsContextValue {
  const value = useOptionalCollectionViews();
  if (!value) throw new Error("CollectionViewsProvider is required for collection navigation.");
  return value;
}
