import { userProfileStorage } from "./UserProfileStorage";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { runtimeCapabilities } from "./RuntimePlatform";
import type { FolderSummary, LibrarySummary } from "./SearchTypes";
import type { SearchScope, SourceFilters } from "./useLocalSearch";
import { normalizeSourceFilters } from "./SearchSourceFilters";
import { activeFilterCount as countActiveFilters } from "./FilterPresentation";
import { searchFilterSummary } from "./SearchSuggestions";
import { createSmartCollection, parseSmartCollections, smartCollectionMatches, type SmartCollection, type SmartCollectionSnapshot, type SmartCollectionDateFilter } from "./SmartCollections";
import type { showOperationStatus as OperationNotifier } from "./useOperationStatus";

const SEARCH_FILTERS_KEY = "craft-search-filters-v1";
const DESKTOP_SIDEBAR_KEY = "hub-desktop-sidebar-enabled-v1";
const DESKTOP_SMART_COLLECTIONS_KEY = "hub-desktop-smart-collections-v1";
type DateFilter = SmartCollectionDateFilter;

function loadSearchFilters(): { dateFilter: DateFilter; sourceFilters: SourceFilters; searchScope: SearchScope; libraryIds: string[] | null; folderId: string } {
  try {
    const value = JSON.parse(userProfileStorage.getItem(SEARCH_FILTERS_KEY) ?? "{}") as Record<string, unknown>;
    const dateFilter = ["any", "7", "30", "90"].includes(String(value.dateFilter))
      ? value.dateFilter as DateFilter
      : "any";
    const source = value.sourceFilters && typeof value.sourceFilters === "object"
      ? value.sourceFilters as Record<string, unknown>
      : {};
    return {
      dateFilter,
      searchScope: ["all", "title", "title_heading"].includes(String(value.searchScope))
        ? value.searchScope as SearchScope
        : "all",
      libraryIds: Array.isArray(value.libraryIds)
        ? value.libraryIds.filter((item): item is string => typeof item === "string" && Boolean(item))
        : typeof value.libraryId === "string" && value.libraryId !== "all"
          ? [value.libraryId]
          : null,
      folderId: typeof value.folderId === "string" ? value.folderId : "",
      sourceFilters: normalizeSourceFilters(source),
    };
  } catch {
    return {
      dateFilter: "any",
      searchScope: "all",
      sourceFilters: { craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true },
      libraryIds: null,
      folderId: "",
    };
  }
}

function loadSmartCollections(): SmartCollection[] {
  return parseSmartCollections(userProfileStorage.getItem(DESKTOP_SMART_COLLECTIONS_KEY));
}

export function updatedAfter(filter: DateFilter): number | null {
  if (filter === "any") return null;
  return Math.floor(Date.now() / 1000) - Number(filter) * 24 * 60 * 60;
}

/** Owns the complete search scope, restored filters and smart collection mutations. */
export function useSearchWorkspaceState({ spaces, ready, registryAvailable = true, showOperationStatus }: { spaces: LibrarySummary[]; ready: boolean; registryAvailable?: boolean; showOperationStatus: typeof OperationNotifier }) {
const initialFilters = useMemo(loadSearchFilters, []);

const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[] | null>(initialFilters.libraryIds);

const [folders, setFolders] = useState<FolderSummary[]>([]);

const [folderId, setFolderId] = useState(initialFilters.folderId);

const [dateFilter, setDateFilter] = useState<DateFilter>(initialFilters.dateFilter);

const [sourceFilters, setSourceFilters] = useState<SourceFilters>(initialFilters.sourceFilters);

const [searchScope, setSearchScope] = useState<SearchScope>(initialFilters.searchScope);

const [query, setQuery] = useState("");

const [desktopSidebarEnabled, setDesktopSidebarEnabled] = useState(() =>
    !runtimeCapabilities.mobile && userProfileStorage.getItem(DESKTOP_SIDEBAR_KEY) === "true",
  );

const [smartCollections, setSmartCollections] = useState<SmartCollection[]>(loadSmartCollections);

const selectedLibraryIdSet = useMemo(
    () => selectedLibraryIds === null ? null : new Set(selectedLibraryIds),
    [selectedLibraryIds],
  );

const activeSpaces = useMemo(
    () => selectedLibraryIds === null
      ? spaces
      : spaces.filter((space) => selectedLibraryIdSet?.has(space.id)),
    [selectedLibraryIdSet, selectedLibraryIds, spaces],
  );

const currentSpaceIds = useMemo(
    () => selectedLibraryIds === null ? null : activeSpaces.map((space) => space.id),
    [activeSpaces, selectedLibraryIds],
  );

const currentStatusSpaceArg = activeSpaces.length === 1 ? activeSpaces[0].id : null;

const currentSpaceName = selectedLibraryIds === null
    ? "全部资料库"
    : activeSpaces.length === 1
      ? activeSpaces[0].name
      : activeSpaces.length > 1
        ? `已选 ${activeSpaces.length} 个资料库`
        : "未选择资料库";

const selectedFolder = folders.find((folder) =>
    `${folder.spaceId}\u0000${folder.id}` === folderId || folder.id === folderId,
  );

const currentSmartCollectionSnapshot = useMemo<SmartCollectionSnapshot>(() => ({
    query,
    libraryIds: selectedLibraryIds,
    folderId,
    folderLabel: selectedFolder?.path,
    dateFilter,
    sourceFilters,
    searchScope,
  }), [dateFilter, folderId, query, searchScope, selectedFolder?.path, selectedLibraryIds, sourceFilters]);

const activeSmartCollectionId = useMemo(
    () => smartCollections.find((collection) => smartCollectionMatches(collection, currentSmartCollectionSnapshot))?.id ?? "",
    [currentSmartCollectionSnapshot, smartCollections],
  );

const filterSummary = useMemo(() => searchFilterSummary({
    currentSpaceName,
    selectedFolder,
    dateFilter,
    sourceFilters,
    searchScope,
  }), [currentSpaceName, dateFilter, searchScope, selectedFolder, sourceFilters]);

const activeFilterCount = useMemo(() => countActiveFilters({
    dateFilter,
    folderId,
    searchScope,
    sourceFilters,
  }), [dateFilter, folderId, searchScope, sourceFilters]);

const effectiveSpaceIds = useMemo(
    () => selectedFolder ? [selectedFolder.spaceId] : currentSpaceIds,
    [currentSpaceIds, selectedFolder],
  );

const effectiveFolderId = selectedFolder?.id ?? "";

const toggleLibrarySelection = useCallback((libraryId: string) => {
    setSelectedLibraryIds((current) => {
      const allIds = spaces.map((space) => space.id);
      const selected = current === null
        ? allIds
        : current.filter((id) => allIds.includes(id));
      if (selected.includes(libraryId)) {
        return selected.filter((id) => id !== libraryId);
      }
      const next = [...selected, libraryId];
      return next.length === allIds.length ? null : next;
    });
  }, [spaces]);

const selectLibraries = useCallback((libraryIds: string[] | null) => setSelectedLibraryIds(libraryIds), []);

const removeLibrarySelection = useCallback((libraryId: string) => {
  setSelectedLibraryIds(current => current === null ? null : current.filter(id => id !== libraryId));
}, []);

const selectOnlyLibrary = useCallback((libraryId: string) => {
    setSelectedLibraryIds([libraryId]);
  }, []);

const selectAllLibraries = useCallback(() => {
    setSelectedLibraryIds(null);
  }, []);

const changeDesktopSidebarSetting = useCallback((enabled: boolean) => {
    setDesktopSidebarEnabled(enabled);
    userProfileStorage.setItem(DESKTOP_SIDEBAR_KEY, String(enabled));
  }, []);

const saveSmartCollections = useCallback((next: SmartCollection[]) => {
    userProfileStorage.setItem(DESKTOP_SMART_COLLECTIONS_KEY, JSON.stringify(next));
    setSmartCollections(next);
  }, []);

const addSmartCollection = useCallback((name: string): boolean => {
    const normalized = name.trim();
    if (!normalized) return false;
    if (smartCollections.some((collection) => collection.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      showOperationStatus(`智能集合“${normalized}”已存在`, "error", 3_000);
      return false;
    }
    const id = `smart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const collection = createSmartCollection(id, normalized, currentSmartCollectionSnapshot);
    saveSmartCollections([...smartCollections, collection]);
    showOperationStatus(`已保存智能集合 · ${collection.name}`, "success");
    return true;
  }, [currentSmartCollectionSnapshot, saveSmartCollections, showOperationStatus, smartCollections]);

const renameSmartCollection = useCallback((id: string, name: string): boolean => {
    const normalized = name.trim();
    if (!normalized) return false;
    if (smartCollections.some((collection) => collection.id !== id && collection.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
      showOperationStatus(`智能集合“${normalized}”已存在`, "error", 3_000);
      return false;
    }
    const next = smartCollections.map((collection) => collection.id === id
      ? { ...collection, name: normalized.slice(0, 60), updatedAt: Date.now() }
      : collection);
    saveSmartCollections(next);
    showOperationStatus(`已重命名智能集合 · ${normalized}`, "success");
    return true;
  }, [saveSmartCollections, showOperationStatus, smartCollections]);

const deleteSmartCollection = useCallback((id: string) => {
    const collection = smartCollections.find((item) => item.id === id);
    saveSmartCollections(smartCollections.filter((item) => item.id !== id));
    if (collection) showOperationStatus(`已删除智能集合 · ${collection.name}`, "success");
  }, [saveSmartCollections, showOperationStatus, smartCollections]);

const toggleAllLibraries = useCallback(() => {
    setSelectedLibraryIds((current) => current === null ? [] : null);
  }, []);

useEffect(() => {
    userProfileStorage.setItem(SEARCH_FILTERS_KEY, JSON.stringify({
      libraryIds: selectedLibraryIds,
      folderId,
      dateFilter,
      sourceFilters,
      searchScope,
    }));
  }, [dateFilter, folderId, searchScope, selectedLibraryIds, sourceFilters]);

const applySmartCollectionFilters = useCallback((collection: SmartCollection) => {
    const availableLibraryIds = new Set(spaces.map((space) => space.id));
    const libraryIds = collection.libraryIds === null
      ? null
      : collection.libraryIds.filter((id) => availableLibraryIds.has(id));
    setQuery(collection.query);
    setSelectedLibraryIds(libraryIds);
    setFolderId(collection.folderId);
    setDateFilter(collection.dateFilter);
    setSourceFilters({ ...collection.sourceFilters });
    setSearchScope(collection.searchScope);
    
    
    
    
    
    
    showOperationStatus(`已应用智能集合 · ${collection.name}`, "success");
  }, [showOperationStatus, spaces]);

  const reconcileSelectedLibraries = useCallback((libraries: LibrarySummary[]) => {
    setSelectedLibraryIds(current => {
      if (current === null) return null;
      const available = new Set(libraries.map(library => library.id));
      const next = current.filter(id => available.has(id));
      return next.length === current.length ? current : next;
    });
  }, []);

  useEffect(() => {
    if (ready && registryAvailable) reconcileSelectedLibraries(spaces);
  }, [ready, registryAvailable, reconcileSelectedLibraries, spaces]);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    void invoke<FolderSummary[]>("list_folders", { spaceIds: currentSpaceIds })
      .then(nextFolders => {
        if (cancelled) return;
        setFolders(nextFolders);
        setFolderId(current => {
          if (!current) return "";
          const match = nextFolders.find(folder =>             `${folder.spaceId}\u0000${folder.id}` === current || folder.id === current);
          return match ? `${match.spaceId}\u0000${match.id}` : "";
        });
      }).catch(() => { if (!cancelled) setFolders([]); });
    return () => { cancelled = true; };
  }, [currentSpaceIds, ready]);

  return { query, setQuery, selectedLibraryIds, selectedLibraryIdSet, activeSpaces, currentSpaceIds, currentStatusSpaceArg, folders, folderId, setFolderId, dateFilter, setDateFilter, sourceFilters, setSourceFilters, searchScope, setSearchScope, desktopSidebarEnabled, changeDesktopSidebarSetting, smartCollections, currentSpaceName, selectedFolder, currentSmartCollectionSnapshot, activeSmartCollectionId, filterSummary, activeFilterCount, effectiveSpaceIds, effectiveFolderId, toggleLibrarySelection, selectLibraries, removeLibrarySelection, selectOnlyLibrary, selectAllLibraries, toggleAllLibraries, addSmartCollection, applySmartCollectionFilters, renameSmartCollection, deleteSmartCollection, reconcileSelectedLibraries };
}
