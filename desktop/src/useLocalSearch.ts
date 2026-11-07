import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { LatestRequestGate } from "./LatestRequestGate";
import type { SearchResult } from "./SearchTypes";

export type SearchScope = "all" | "title" | "title_heading";
export type SourceFilters = { craft: boolean; task: boolean; pdf: boolean; media: boolean; attachment: boolean };

type SearchRequestOptions = {
  query: string;
  spaceIds: string[] | null;
  folderId: string;
  updatedAfter: number | null;
  sourceFilters: SourceFilters;
  searchScope: SearchScope;
  recentPageLimit: number;
  recentTaskLimit: number;
};

export function buildLocalSearchRequest(options: SearchRequestOptions) {
  return {
    query: options.query,
    limit: 60,
    spaceIds: options.spaceIds,
    folderId: options.folderId || null,
    updatedAfter: options.updatedAfter,
    includeCraftPages: options.sourceFilters.craft,
    includeDidaTasks: options.sourceFilters.task,
    includeImageOcr: options.sourceFilters.media,
    includePdf: options.sourceFilters.pdf,
    includePdfOcr: options.sourceFilters.pdf,
    includeAttachments: options.sourceFilters.attachment,
    searchScope: options.searchScope,
  };
}

export function buildRecentDocumentsRequest(options: Pick<SearchRequestOptions, "spaceIds" | "folderId" | "updatedAfter" | "recentPageLimit" | "recentTaskLimit">) {
  return {
    pageLimit: options.recentPageLimit,
    taskLimit: options.recentTaskLimit,
    spaceIds: options.spaceIds,
    folderId: options.folderId || null,
    updatedAfter: options.updatedAfter,
  };
}

export function usesFilteredEmptySearch(options: Pick<SearchRequestOptions, "sourceFilters" | "searchScope">): boolean {
  return options.searchScope !== "all" || Object.values(options.sourceFilters).some((enabled) => !enabled);
}

type UseLocalSearchOptions = SearchRequestOptions & {
  refreshRevision?: number;
  ready: boolean;
  hasSpaces: boolean;
  syncing: boolean;
  isComposing: boolean;
  normalizeResults: (value: unknown) => SearchResult[];
  publishResults: (next: SearchResult[], keepSelection: boolean) => void;
  setError: Dispatch<SetStateAction<string>>;
};

export function useLocalSearch(options: UseLocalSearchOptions) {
  const [searching, setSearching] = useState(false);
  const requestKey = JSON.stringify(buildLocalSearchRequest(options));
  const [settledKey, setSettledKey] = useState("");
  const requestGate = useRef(new LatestRequestGate());
  const publishedKey = useRef<string | null>(null);
  const {
    ready, hasSpaces, syncing, isComposing, normalizeResults,
    publishResults, setError,
  } = options;
  const publish = useCallback((value: unknown) => {
    const next = normalizeResults(value);
    const keepSelection = publishedKey.current === requestKey;
    publishedKey.current = requestKey;
    publishResults(next, keepSelection);
    setSettledKey(requestKey);
  }, [normalizeResults, requestKey, publishResults]);

  const loadRecent = useCallback(async () => {
    if (!ready || !hasSpaces) return;
    const requestSequence = requestGate.current.begin();
    setSearching(true);
    setError("");
    try {
      const result = await invoke<unknown>("recent_documents", buildRecentDocumentsRequest(options));
      if (!requestGate.current.isCurrent(requestSequence)) return;
      publish(result);
    } catch (reason) {
      if (requestGate.current.isCurrent(requestSequence)) setError(String(reason));
    } finally {
      if (requestGate.current.isCurrent(requestSequence)) setSearching(false);
    }
  }, [hasSpaces, options.folderId, options.recentPageLimit, options.recentTaskLimit, options.spaceIds, options.updatedAfter, ready, publish, setError]);

  useEffect(() => {
    if (!ready || !hasSpaces || syncing || isComposing) {
      requestGate.current.invalidate();
      setSearching(false);
      return;
    }
    const timer = window.setTimeout(async () => {
      if (!options.query.trim() && !usesFilteredEmptySearch(options)) {
        await loadRecent();
        return;
      }
      const requestSequence = requestGate.current.begin();
      setSearching(true);
      setError("");
      try {
        const result = await invoke<unknown>("local_search", buildLocalSearchRequest(options));
        if (!requestGate.current.isCurrent(requestSequence)) return;
        publish(result);
      } catch (reason) {
        if (requestGate.current.isCurrent(requestSequence)) setError(String(reason));
      } finally {
        if (requestGate.current.isCurrent(requestSequence)) setSearching(false);
      }
    }, 280);
    return () => {
      window.clearTimeout(timer);
      requestGate.current.invalidate();
      setSearching(false);
    };
  }, [
    hasSpaces, isComposing, loadRecent, normalizeResults, requestKey, options.folderId,
    options.query, options.searchScope, options.sourceFilters, options.spaceIds,
    options.updatedAfter, options.refreshRevision, ready, setError, publish, syncing,
  ]);

  return { searching, loadRecent, resultsCurrent: settledKey === requestKey };
}
