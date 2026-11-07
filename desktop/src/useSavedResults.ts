import { userProfileStorage } from "./UserProfileStorage";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SearchResult } from "./SearchTypes";
import { normalizePageFavorites, pageFavoriteKey, snippetFavoriteKey, togglePageFavorite, toggleSnippetFavorite } from "./PageFavorites";

const SEARCH_HISTORY_KEY = "craft-search-history-v1";
const DESKTOP_FAVORITES_KEY = "hub-desktop-favorites-v2";
const DESKTOP_VIEW_HISTORY_KEY = "hub-desktop-view-history-v1";

function loadSearchHistory(): string[] {
  try {
    const value = JSON.parse(userProfileStorage.getItem(SEARCH_HISTORY_KEY) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

function loadStoredResults(key: string, limit: number): SearchResult[] {
  try {
    const value = JSON.parse(userProfileStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((item): item is SearchResult => Boolean(item && typeof item === "object" && typeof item.entityKey === "string")).slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

/** Owns saved search and result facts, including their restoration and persistence. */
export function useSavedResults({ searchHistoryEnabled }: { searchHistoryEnabled: boolean }) {
const [searchHistory, setSearchHistory] = useState<string[]>(loadSearchHistory);

const [favoriteResults, setFavoriteResults] = useState<SearchResult[]>(() => normalizePageFavorites(
    loadStoredResults(userProfileStorage.getItem(DESKTOP_FAVORITES_KEY) !== null ? DESKTOP_FAVORITES_KEY : "hub-desktop-favorites-v1", 200),
  ));

const [viewHistory, setViewHistory] = useState<SearchResult[]>(() => loadStoredResults(DESKTOP_VIEW_HISTORY_KEY, 100));

const [favoriteFilter, setFavoriteFilter] = useState<"all" | "page" | "snippet">("all");

const filteredFavorites = useMemo(() => favoriteResults.filter(item => favoriteFilter === "all" || (item.favoriteKind ?? "page") === favoriteFilter), [favoriteResults, favoriteFilter]);

const snippetFavoriteIds = useMemo(() => new Set(favoriteResults.filter(item => item.favoriteKind === "snippet").map(snippetFavoriteKey)), [favoriteResults]);

const favoriteIds = useMemo(() => new Set(favoriteResults.filter(item => item.favoriteKind !== "snippet").map(pageFavoriteKey)), [favoriteResults]);

const rememberQuery = useCallback((value: string) => {
    if (!searchHistoryEnabled) return;
    const normalized = value.trim();
    if (!normalized) return;
    setSearchHistory((current) => {
      const next = [normalized, ...current.filter((item) => item !== normalized)].slice(0, 12);
      userProfileStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [searchHistoryEnabled]);

const clearSearchHistory = useCallback(() => {
    userProfileStorage.removeItem(SEARCH_HISTORY_KEY);
    setSearchHistory([]);
  }, []);

const removeSearchHistoryItem = useCallback((value: string) => {
    setSearchHistory((current) => {
      const next = current.filter((item) => item !== value);
      userProfileStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const toggleFavorite = useCallback((result: SearchResult) => {
    setFavoriteResults((current) => {
      const next = result.favoriteKind === "snippet" ? toggleSnippetFavorite(current, result) : togglePageFavorite(current, result);
      userProfileStorage.setItem(DESKTOP_FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

const rememberViewedResult = useCallback((result: SearchResult) => {
    setViewHistory((current) => {
      const next = [result, ...current.filter((item) => item.entityKey !== result.entityKey)].slice(0, 100);
      userProfileStorage.setItem(DESKTOP_VIEW_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  useEffect(() => {
    if (!searchHistoryEnabled) clearSearchHistory();
  }, [clearSearchHistory, searchHistoryEnabled]);

  return { searchHistory, favoriteResults, viewHistory, favoriteFilter, filteredFavorites, snippetFavoriteIds, favoriteIds, rememberQuery, clearSearchHistory, removeSearchHistoryItem, toggleFavorite, rememberViewedResult , setFavoriteFilter };
}
