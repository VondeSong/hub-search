import { Bookmark, ChevronDown, ChevronRight, Clock3, FileText, FolderTree, Pin, Plus, X } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { SmartCollection } from "./SmartCollections";
import { resultDisplayTitle } from "./SearchResultPresentation";
import { userProfileStorage } from "./UserProfileStorage";

export const SIDEBAR_PINS_KEY = "hub.desktop.sidebar.pins.v1";
export const SIDEBAR_RECENT_COLLAPSED_KEY = "hub.desktop.sidebar.recent-collapsed.v1";

export type SidebarPinItem =
  | { id: string; kind: "library"; targetId: string; title: string }
  | { id: string; kind: "collection"; targetId: string; title: string }
  | { id: string; kind: "result"; targetId: string; title: string; result: SearchResult };

function isValidPinItem(value: unknown): value is SidebarPinItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.targetId !== "string" || typeof item.title !== "string") {
    return false;
  }
  if (item.kind === "library" || item.kind === "collection") return true;
  if (item.kind === "result") {
    return Boolean(item.result && typeof item.result === "object" && typeof (item.result as SearchResult).entityKey === "string");
  }
  return false;
}

export function loadSidebarPins(): SidebarPinItem[] {
  try {
    const raw = userProfileStorage.getItem(SIDEBAR_PINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isValidPinItem).slice(0, 24) : [];
  } catch {
    return [];
  }
}

export function saveSidebarPins(items: SidebarPinItem[]) {
  try {
    userProfileStorage.setItem(SIDEBAR_PINS_KEY, JSON.stringify(items.slice(0, 24)));
  } catch {
    // Ignore storage unavailability so sidebar navigation keeps working.
  }
}

export function loadSidebarRecentCollapsed(): boolean {
  try {
    return userProfileStorage.getItem(SIDEBAR_RECENT_COLLAPSED_KEY) !== "false";
  } catch {
    return true;
  }
}

type SidebarPinnedSectionProps = {
  spaces: LibrarySummary[];
  smartCollections: SmartCollection[];
  favoriteResults?: SearchResult[];
  viewHistory?: SearchResult[];
  onApplySmartCollection: (collection: SmartCollection) => void;
  onOpenPinnedLibrary?: (libraryId: string) => void;
  onOpenPinnedResult?: (result: SearchResult) => void;
};

export const SidebarPinnedSection = memo(function SidebarPinnedSection({
  spaces,
  smartCollections,
  favoriteResults = [],
  viewHistory = [],
  onApplySmartCollection,
  onOpenPinnedLibrary,
  onOpenPinnedResult,
}: SidebarPinnedSectionProps) {
  const [pins, setPins] = useState<SidebarPinItem[]>(loadSidebarPins);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [recentCollapsed, setRecentCollapsed] = useState<boolean>(loadSidebarRecentCollapsed);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!sectionRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setPickerOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [pickerOpen]);

  const pinIdSet = useMemo(() => new Set(pins.map((item) => item.id)), [pins]);
  const spaceById = useMemo(() => new Map(spaces.map((space) => [space.id, space])), [spaces]);
  const collectionById = useMemo(() => new Map(smartCollections.map((item) => [item.id, item])), [smartCollections]);

  const candidateLibraries = useMemo(
    () => spaces.filter((space) => !pinIdSet.has(`library:${space.id}`)),
    [pinIdSet, spaces],
  );
  const candidateCollections = useMemo(
    () => smartCollections.filter((item) => !pinIdSet.has(`collection:${item.id}`)),
    [pinIdSet, smartCollections],
  );
  const candidateFavorites = useMemo(() => {
    const seen = new Set<string>();
    const items: SearchResult[] = [];
    for (const fav of favoriteResults) {
      if (fav.favoriteKind === "snippet") continue;
      if (seen.has(fav.entityKey) || pinIdSet.has(`result:${fav.entityKey}`)) continue;
      seen.add(fav.entityKey);
      items.push(fav);
      if (items.length >= 6) break;
    }
    return items;
  }, [favoriteResults, pinIdSet]);

  const recentItems = useMemo(() => viewHistory.slice(0, 6), [viewHistory]);

  const addPin = (item: SidebarPinItem) => {
    setPins((current) => {
      if (current.some((existing) => existing.id === item.id)) return current;
      const next = [...current, item].slice(0, 24);
      saveSidebarPins(next);
      return next;
    });
    setPickerOpen(false);
  };

  const removePin = (id: string) => {
    setPins((current) => {
      const next = current.filter((item) => item.id !== id);
      saveSidebarPins(next);
      return next;
    });
  };

  const toggleRecent = () => {
    setRecentCollapsed((current) => {
      const next = !current;
      try {
        userProfileStorage.setItem(SIDEBAR_RECENT_COLLAPSED_KEY, String(next));
      } catch {
        // Ignore storage unavailability.
      }
      return next;
    });
  };

  const openPin = (item: SidebarPinItem) => {
    if (item.kind === "library") {
      onOpenPinnedLibrary?.(item.targetId);
      return;
    }
    if (item.kind === "collection") {
      const live = collectionById.get(item.targetId);
      if (live) onApplySmartCollection(live);
      return;
    }
    onOpenPinnedResult?.(item.result);
  };

  const hasCandidates = candidateLibraries.length > 0 || candidateCollections.length > 0 || candidateFavorites.length > 0;

  return (
    <div className="sidebar-plan-c" ref={sectionRef}>
      <section className="sidebar-pin-section" aria-label="置顶">
        <div className="sidebar-pin-header">
          <span className="sidebar-pin-header-label">
            <Pin size={12} />
            <span>置顶</span>
          </span>
          <button
            type="button"
            className="sidebar-pin-add-btn"
            onClick={() => setPickerOpen((open) => !open)}
            title="添加置顶项"
            aria-label="添加置顶项"
            aria-expanded={pickerOpen}
          >
            <Plus size={13} />
          </button>
        </div>

        {pickerOpen && (
          <div className="sidebar-pin-picker" role="dialog" aria-label="选择要置顶的项目">
            {candidateLibraries.length > 0 && (
              <div className="sidebar-pin-picker-group">
                <div className="sidebar-pin-picker-title">资料库</div>
                {candidateLibraries.map((space) => (
                  <button
                    key={space.id}
                    type="button"
                    className="sidebar-pin-picker-item"
                    onClick={() => addPin({ id: `library:${space.id}`, kind: "library", targetId: space.id, title: space.name })}
                  >
                    <FolderTree size={13} />
                    <span>{space.name}</span>
                  </button>
                ))}
              </div>
            )}
            {candidateCollections.length > 0 && (
              <div className="sidebar-pin-picker-group">
                <div className="sidebar-pin-picker-title">智能集合</div>
                {candidateCollections.map((collection) => (
                  <button
                    key={collection.id}
                    type="button"
                    className="sidebar-pin-picker-item"
                    onClick={() => addPin({ id: `collection:${collection.id}`, kind: "collection", targetId: collection.id, title: collection.name })}
                  >
                    <Bookmark size={13} />
                    <span>{collection.name}</span>
                  </button>
                ))}
              </div>
            )}
            {candidateFavorites.length > 0 && (
              <div className="sidebar-pin-picker-group">
                <div className="sidebar-pin-picker-title">收藏文档</div>
                {candidateFavorites.map((result) => {
                  const title = resultDisplayTitle(result);
                  return (
                    <button
                      key={result.entityKey}
                      type="button"
                      className="sidebar-pin-picker-item"
                      onClick={() => addPin({ id: `result:${result.entityKey}`, kind: "result", targetId: result.entityKey, title, result })}
                    >
                      <FileText size={13} />
                      <span>{title}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {!hasCandidates && (
              <div className="sidebar-pin-picker-empty">没有更多可置顶的项目</div>
            )}
          </div>
        )}

        <div className="sidebar-pin-list">
          {pins.map((item) => {
            const label = item.kind === "library"
              ? spaceById.get(item.targetId)?.name ?? item.title
              : item.kind === "collection"
                ? collectionById.get(item.targetId)?.name ?? item.title
                : item.title;
            const icon = item.kind === "library"
              ? <FolderTree size={14} />
              : item.kind === "collection"
                ? <Bookmark size={14} />
                : <FileText size={14} />;
            return (
              <div className="sidebar-pin-row" key={item.id}>
                <button
                  type="button"
                  className="sidebar-pin-open"
                  onClick={() => openPin(item)}
                  title={label}
                >
                  {icon}
                  <span>{label}</span>
                </button>
                <button
                  type="button"
                  className="sidebar-pin-remove"
                  onClick={() => removePin(item.id)}
                  title={`取消置顶 ${label}`}
                  aria-label={`取消置顶 ${label}`}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          {pins.length === 0 && (
            <div className="sidebar-pin-empty">点击＋固定常用资料库、集合或文档</div>
          )}
        </div>
      </section>

      {recentItems.length > 0 && (
        <section className="sidebar-recent-section" aria-label="最近打开">
          <button
            type="button"
            className="sidebar-recent-toggle"
            onClick={toggleRecent}
            aria-expanded={!recentCollapsed}
          >
            {recentCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
            <Clock3 size={12} />
            <span>最近打开</span>
            <small>{recentItems.length}</small>
          </button>
          {!recentCollapsed && (
            <div className="sidebar-recent-list">
              {recentItems.map((result) => {
                const title = resultDisplayTitle(result);
                return (
                  <button
                    key={result.entityKey}
                    type="button"
                    className="sidebar-recent-open"
                    onClick={() => onOpenPinnedResult?.(result)}
                    title={title}
                  >
                    <FileText size={14} />
                    <span>{title}</span>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
});
