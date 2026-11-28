import { prepareQuickSearchResults } from "./QuickSearchGrouping";
import { recentDateGroup } from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";

export type SearchWorkspaceView = "home" | "tasks" | "journals" | "favorites" | "history" | "tags" | "flashcards";

export type SearchWorkspaceResultGroup = {
  key: string;
  label: string;
  entries: Array<{ result: SearchResult; index: number }>;
  hideEntryDates?: boolean;
};

export type SearchWorkspaceResultPresentation = {
  visibleResults: SearchResult[];
  groups: SearchWorkspaceResultGroup[];
  journalDayCount: number;
};

export function findMatchingResultIndex(results: readonly SearchResult[], target?: SearchResult): number {
  if (!target) return -1;
  const byEntity = target.entityKey
    ? results.findIndex((item) => item.entityKey && item.entityKey === target.entityKey)
    : -1;
  if (byEntity >= 0) return byEntity;
  const byId = target.id
    ? results.findIndex((item) => item.id && item.id === target.id)
    : -1;
  if (byId >= 0) return byId;
  if (target.documentId) {
    return results.findIndex((item) =>
      item.provider === target.provider
      && item.libraryId === target.libraryId
      && item.documentId === target.documentId
      && (item.pageId ?? "") === (target.pageId ?? ""),
    );
  }
  return -1;
}

export function journalDateKey(result?: SearchResult): string {
  if (result?.journalDate) return result.journalDate;
  const value = result?.title.trim().replace(/\./g, "-") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

export function journalDateLabel(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "日期待核对";
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (!Number.isFinite(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) return "日期待核对";
  const keyFor = (target: Date) => `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const prefix = value === keyFor(today) ? "今天 · " : value === keyFor(yesterday) ? "昨天 · " : "";
  return `${prefix}${year}年${month}月${day}日 · ${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date)}`;
}

type DeriveSearchWorkspaceResultsOptions = {
  desktopSidebarEnabled: boolean;
  isMobileLayout: boolean;
  query: string;
  view: SearchWorkspaceView;
  results: SearchResult[];
  journalResults: SearchResult[];
  favoriteResults: SearchResult[];
  historyResults: SearchResult[];
  tagResults: SearchResult[];
  selectedLibraryIdSet: ReadonlySet<string> | null;
  selectedJournalDate: string;
  dateFilter: "any" | "7" | "30" | "90";
  groupRecentByDateWhenUnlimited: boolean;
};

export function deriveSearchWorkspaceResults({
  desktopSidebarEnabled,
  isMobileLayout,
  query,
  view,
  results,
  journalResults,
  favoriteResults,
  historyResults,
  tagResults,
  selectedLibraryIdSet,
  selectedJournalDate,
  dateFilter,
  groupRecentByDateWhenUnlimited,
}: DeriveSearchWorkspaceResultsOptions): SearchWorkspaceResultPresentation {
  const normalizedQuery = query.trim();
  const useSidebarSource = (desktopSidebarEnabled || isMobileLayout) && !normalizedQuery && view !== "home";
  let visibleResults: SearchResult[];
  let visibleJournalDates: string[] | null = null;

  if (!useSidebarSource) {
    visibleResults = normalizedQuery ? prepareQuickSearchResults(results, query) : results;
  } else {
    const source = view === "journals"
      ? journalResults
      : view === "favorites"
        ? favoriteResults
        : view === "history"
          ? historyResults
          : view === "tags"
            ? tagResults
            : [];
    const filtered: SearchResult[] = [];
    const journalDates: string[] = [];
    for (const result of source) {
      if (selectedLibraryIdSet !== null && !selectedLibraryIdSet.has(result.libraryId)) continue;
      if (view === "journals") {
        const date = journalDateKey(result);
        if (selectedJournalDate && (
          selectedJournalDate.length === 7
            ? !date.startsWith(`${selectedJournalDate}-`)
            : date !== selectedJournalDate
        )) continue;
        journalDates.push(date);
      }
      filtered.push(result);
    }
    visibleResults = filtered;
    if (view === "journals") visibleJournalDates = journalDates;
  }

  const entries = visibleResults.map((result, index) => ({ result, index }));
  if (!normalizedQuery && useSidebarSource && view === "journals") {
    const groups = new Map<string, SearchWorkspaceResultGroup>();
    const journalDays = new Set<string>();
    for (const entry of entries) {
      const date = visibleJournalDates?.[entry.index] ?? journalDateKey(entry.result);
      if (date) journalDays.add(date);
      const existing = groups.get(date);
      if (existing) {
        existing.entries.push(entry);
      } else {
        groups.set(date, {
          key: `journal:${date}`,
          label: journalDateLabel(date),
          entries: [entry],
          hideEntryDates: true,
        });
      }
    }
    return { visibleResults, groups: [...groups.values()], journalDayCount: journalDays.size };
  }

  if (!normalizedQuery && useSidebarSource) {
    return { visibleResults, groups: [{ key: view, label: "", entries }], journalDayCount: 0 };
  }
  if (isMobileLayout && view === "home" && !normalizedQuery) {
    return { visibleResults, groups: [{ key: "recent", label: "最近更新与命中", entries }], journalDayCount: 0 };
  }
  if (normalizedQuery || (dateFilter === "any" && !groupRecentByDateWhenUnlimited)) {
    return { visibleResults, groups: [{ key: "recent", label: "", entries }], journalDayCount: 0 };
  }

  const groups = new Map<string, SearchWorkspaceResultGroup>();
  for (const entry of entries) {
    const group = recentDateGroup(entry.result.modifiedAt);
    const existing = groups.get(group.key);
    if (existing) {
      existing.entries.push(entry);
    } else {
      groups.set(group.key, { ...group, entries: [entry] });
    }
  }
  return { visibleResults, groups: [...groups.values()], journalDayCount: 0 };
}
