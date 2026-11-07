import type { SearchScope, SourceFilters } from "./useLocalSearch";

export type SmartCollectionDateFilter = "any" | "7" | "30" | "90";

export type SmartCollectionSnapshot = {
  query: string;
  libraryIds: string[] | null;
  folderId: string;
  folderLabel?: string;
  dateFilter: SmartCollectionDateFilter;
  sourceFilters: SourceFilters;
  searchScope: SearchScope;
};

export type SmartCollection = SmartCollectionSnapshot & {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

const DATE_FILTERS = new Set<SmartCollectionDateFilter>(["any", "7", "30", "90"]);
const SEARCH_SCOPES = new Set<SearchScope>(["all", "title", "title_heading"]);

function parseSourceFilters(value: unknown): SourceFilters {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    craft: source.craft !== false,
    task: source.task !== false,
    pdf: source.pdf !== false,
    media: source.media !== false,
    attachment: source.attachment !== false,
  };
}

function normalizeLibraryIds(value: unknown): string[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())))]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeSmartCollectionSnapshot(snapshot: SmartCollectionSnapshot): SmartCollectionSnapshot {
  return {
    query: snapshot.query.trim(),
    libraryIds: normalizeLibraryIds(snapshot.libraryIds),
    folderId: snapshot.folderId,
    folderLabel: snapshot.folderLabel?.trim() || undefined,
    dateFilter: snapshot.dateFilter,
    sourceFilters: { ...snapshot.sourceFilters },
    searchScope: snapshot.searchScope,
  };
}

export function createSmartCollection(
  id: string,
  name: string,
  snapshot: SmartCollectionSnapshot,
  timestamp = Date.now(),
): SmartCollection {
  return {
    id,
    name: name.trim().slice(0, 60),
    ...normalizeSmartCollectionSnapshot(snapshot),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function parseSmartCollections(raw: string | null, limit = 50): SmartCollection[] {
  try {
    const value = JSON.parse(raw ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): SmartCollection[] => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
      const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 60) : "";
      if (!id || !name) return [];
      const dateFilter = DATE_FILTERS.has(candidate.dateFilter as SmartCollectionDateFilter)
        ? candidate.dateFilter as SmartCollectionDateFilter
        : "any";
      const searchScope = SEARCH_SCOPES.has(candidate.searchScope as SearchScope)
        ? candidate.searchScope as SearchScope
        : "all";
      const timestamp = Date.now();
      return [{
        id,
        name,
        query: typeof candidate.query === "string" ? candidate.query.trim() : "",
        libraryIds: normalizeLibraryIds(candidate.libraryIds),
        folderId: typeof candidate.folderId === "string" ? candidate.folderId : "",
        folderLabel: typeof candidate.folderLabel === "string" && candidate.folderLabel.trim()
          ? candidate.folderLabel.trim()
          : undefined,
        dateFilter,
        sourceFilters: parseSourceFilters(candidate.sourceFilters),
        searchScope,
        createdAt: typeof candidate.createdAt === "number" ? candidate.createdAt : timestamp,
        updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : timestamp,
      }];
    }).slice(0, limit);
  } catch {
    return [];
  }
}

export function smartCollectionMatches(
  collection: SmartCollection,
  snapshot: SmartCollectionSnapshot,
): boolean {
  const current = normalizeSmartCollectionSnapshot(snapshot);
  const saved = normalizeSmartCollectionSnapshot(collection);
  return saved.query === current.query
    && JSON.stringify(saved.libraryIds) === JSON.stringify(current.libraryIds)
    && saved.folderId === current.folderId
    && saved.dateFilter === current.dateFilter
    && saved.searchScope === current.searchScope
    && Object.keys(saved.sourceFilters).every((key) => (
      saved.sourceFilters[key as keyof SourceFilters] === current.sourceFilters[key as keyof SourceFilters]
    ));
}

export function smartCollectionSourceLabel(sourceFilters: SourceFilters): string {
  const entries = ([
    ["craft", "页面"],
    ["task", "任务"],
    ["pdf", "PDF"],
    ["media", "媒体"],
    ["attachment", "附件"],
  ] as const).filter(([key]) => sourceFilters[key]).map(([, label]) => label);
  return entries.length === 5 ? "全部类型" : entries.length ? entries.join("、") : "未选择类型";
}
