import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { SearchResult } from "./SearchTypes";
import type { IndexStatus } from "./IndexStatusTypes";

export type JournalSummary = {
  count: number;
  dates: Array<{ date: string; sources: number }>;
};

type JournalView = { summary: JournalSummary; items: unknown };

const EMPTY_SUMMARY: JournalSummary = { count: 0, dates: [] };

/** Committed journal inputs and visible library membership own invalidation. */
export function journalDataVersion(
  status: Pick<IndexStatus, "journalVersions"> | null | undefined,
  spaceIds: string[] | null,
): string {
  const selected = spaceIds === null ? null : new Set(spaceIds);
  const versions = (status ? status.journalVersions : [])
    .filter(item => item.provider === "craft" || item.provider === "obsidian")
    .filter(item => selected === null || selected.has(item.libraryId))
    .map(item => [item.libraryId, item.revision, item.name, item.provider])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(versions);
}

const RETRY_DELAYS = [1_000, 3_000, 10_000] as const;

/** Each effect owns its retries and rejects results from an obsolete generation. */
function readWithRetry<T>(request: () => Promise<T>, onSuccess: (value: T) => void, onSettled?: () => void): () => void {
  let cancelled = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    try {
      const value = await request();
      if (cancelled) return;
      onSuccess(value);
      onSettled?.();
    } catch {
      if (cancelled) return;
      const delay = RETRY_DELAYS[retries++];
      if (delay === undefined) { onSettled?.(); return; }
      timer = setTimeout(() => { timer = undefined; void read(); }, delay);
    }
  };
  void read();
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Navigation owns metadata; only the active journal workspace owns page reads. */
export function useJournalData({
  enabled, active, spaceIds, dataVersion, selectedDate, normalize,
}: {
  enabled: boolean;
  active: boolean;
  spaceIds: string[] | null;
  dataVersion: string;
  selectedDate: string;
  normalize: (value: unknown) => SearchResult[];
}) {
  const [summary, setSummary] = useState<JournalSummary>(EMPTY_SUMMARY);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const scopeKey = JSON.stringify(spaceIds === null ? null : [...new Set(spaceIds)].sort());
  const scope = useMemo(() => JSON.parse(scopeKey) as string[] | null, [scopeKey]);

  useEffect(() => {
    if (!enabled) { setSummary(EMPTY_SUMMARY); return; }
    if (active) return;
    setSummary(EMPTY_SUMMARY);
    return readWithRetry(() => invoke<JournalSummary>("journal_summary", { spaceIds: scope }), setSummary);
  }, [enabled, active, scope, dataVersion]);

  useEffect(() => {
    if (!enabled || !active) { setLoading(false); setResults([]); return; }
    setLoading(true);
    setSummary(EMPTY_SUMMARY);
    setResults([]);
    return readWithRetry(() => invoke<JournalView>("journal_view", {
      spaceIds: scope, limit: 500, dateKey: selectedDate || null,
    }), value => {
      // React batches both projections from the same native read transaction.
      const items = normalize(value.items);
      setSummary(value.summary);
      setResults(items);
    }, () => setLoading(false));
  }, [enabled, active, scope, dataVersion, selectedDate, normalize]);

  return { summary, results, loading };
}
