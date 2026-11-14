import type { SearchResult } from "./SearchTypes";
import { userProfileStorage } from "./UserProfileStorage";

export const LIBRARY_BROWSE_STATE_KEY = "hub.library-browse.view-v1";
export const LIBRARY_TOPICS_KEY = "hub.library-browse.topics-v1";
export const LIBRARY_FOLDER_FAVORITES_KEY = "hub.library-browse.folder-favorites-v1";
export type LibraryReference = { kind: "document"; result: SearchResult } | {
  kind: "folder"; libraryId: string; folderId: string; title: string;
};
export type LibraryTopic = { id: string; name: string; items: LibraryReference[] };
export type LibraryBrowseState = {
  position?: { libraryId: string; folderId: string; documentId?: string };
  preview?: SearchResult;
  mode?: "tree" | "columns";
  readerOpen?: boolean;
  navigationOpen?: boolean;
  expansion?: Record<string, boolean>;
  openRoots?: Record<string, boolean>;
  positions?: Record<string, string>;
  previews?: Record<string, SearchResult>;
  scroll?: Record<string, { list: number; tree: number; columns: number }>;
};

function read(key: string): unknown {
  try { return JSON.parse(userProfileStorage.getItem(key) ?? "null"); } catch { return null; }
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
export function isBrowseResult(value: unknown): value is SearchResult {
  return object(value) && ["id", "entityKey", "libraryId", "documentId", "provider", "title", "spaceId", "contentType", "sourceType", "path"].every(key => typeof value[key] === "string")
    && ["craft", "obsidian", "feishu", "dida365"].includes(String(value.provider));
}
export function referenceKey(value: LibraryReference): string {
  return value.kind === "folder" ? JSON.stringify([value.kind, value.libraryId, value.folderId])
    : JSON.stringify([value.kind, value.result.libraryId, value.result.documentId, value.result.pageId ?? ""]);
}
export function referenceLibrary(value: LibraryReference): string {
  return value.kind === "folder" ? value.libraryId : value.result.libraryId;
}
function isReference(value: unknown): value is LibraryReference {
  return object(value) && (value.kind === "document" ? isBrowseResult(value.result)
    : value.kind === "folder" && ["libraryId", "folderId", "title"].every(key => typeof value[key] === "string"));
}
export function loadLibraryTopics(): LibraryTopic[] {
  const value = read(LIBRARY_TOPICS_KEY);
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value.flatMap(item => {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)
      || typeof item.name !== "string" || !item.name.trim() || !Array.isArray(item.items)) return [];
    ids.add(item.id);
    const seen = new Set<string>();
    const items = item.items.filter(isReference).filter(entry => {
      const key = referenceKey(entry); if (seen.has(key)) return false; seen.add(key); return true;
    });
    return [{ id: item.id, name: item.name.trim(), items }];
  });
}
export function toggleTopicReference(items: LibraryReference[], entry: LibraryReference): LibraryReference[] {
  const key = referenceKey(entry);
  return items.some(item => referenceKey(item) === key) ? items.filter(item => referenceKey(item) !== key) : [...items, entry];
}
export function loadFolderFavorites(): Extract<LibraryReference, { kind: "folder" }>[] {
  const value = read(LIBRARY_FOLDER_FAVORITES_KEY);
  return Array.isArray(value) ? value.filter(isReference).filter((entry): entry is Extract<LibraryReference, { kind: "folder" }> => entry.kind === "folder") : [];
}
export function loadLibraryBrowseState(): LibraryBrowseState {
  const value = read(LIBRARY_BROWSE_STATE_KEY);
  if (!object(value)) return {};
  const strings = (candidate: unknown) => object(candidate) ? Object.fromEntries(Object.entries(candidate).filter(([, v]) => typeof v === "string")) as Record<string, string> : {};
  const booleans = (candidate: unknown) => object(candidate) ? Object.fromEntries(Object.entries(candidate).filter(([, v]) => typeof v === "boolean")) as Record<string, boolean> : {};
  const previews = object(value.previews) ? Object.fromEntries(Object.entries(value.previews).filter(([, v]) => isBrowseResult(v))) as Record<string, SearchResult> : {};
  return {
    position: object(value.position) && typeof value.position.libraryId === "string" && typeof value.position.folderId === "string"
      ? { libraryId: value.position.libraryId, folderId: value.position.folderId, documentId: typeof value.position.documentId === "string" ? value.position.documentId : undefined } : undefined,
    preview: isBrowseResult(value.preview) ? value.preview : undefined,
    mode: value.mode === "columns" ? "columns" : "tree",
    readerOpen: value.readerOpen !== false, navigationOpen: value.navigationOpen !== false,
    expansion: booleans(value.expansion), openRoots: booleans(value.openRoots), positions: strings(value.positions), previews,
    scroll: object(value.scroll) ? Object.fromEntries(Object.entries(value.scroll).flatMap(([key, v]) =>
      object(v) && [v.list, v.tree, v.columns].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)
        ? [[key, { list: v.list, tree: v.tree, columns: v.columns }]] : [])) as LibraryBrowseState["scroll"] : {},
  };
}

export function persistLibraryBrowseState(state: LibraryBrowseState): void {
  const scroll = Object.fromEntries(Object.entries(state.scroll ?? {}).filter(([key]) => !key.startsWith("search:")));
  userProfileStorage.setItem(LIBRARY_BROWSE_STATE_KEY, JSON.stringify({...state, scroll}));
}
