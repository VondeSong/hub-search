import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeResults } from "./SearchResultNormalization";
import type { SearchResult } from "./SearchTypes";
import { journalMonthDays, normalizeJournalView, type JournalViewConfig } from "./JournalViews";

export type JournalPage = { items: SearchResult[]; total: number; days: number; libraries: number; revision: string };
const PAGE_SIZE = 200;
const EMPTY_PAGE: JournalPage = { items: [], total: 0, days: 0, libraries: 0, revision: "" };
export function journalRange(value: JournalViewConfig) {
  const view = normalizeJournalView(value);
  // Day scope is an explicit filter. Ordinary day selection lives in the UI
  // and leaves this range unchanged; all-scope calendars still read one grid.
  if (view.period === "day") return { from: view.day, to: view.day };
  if (view.period === "all" && view.layout !== "calendar") return { from: null, to: null };
  const days = journalMonthDays(view.month, view.layout === "calendar");
  return { from: days[0], to: days[days.length - 1] };
}
function canonicalScope(ids: string[] | null) { return ids === null ? null : [...new Set(ids)].sort(); }
function validPage(page: JournalPage) {
  return page && Array.isArray(page.items) && typeof page.revision === "string"
    && [page.total, page.days, page.libraries].every(count => Number.isSafeInteger(count) && count >= 0);
}
export function useJournalPage(view: JournalViewConfig, scope: string[] | null, revision: string, enabled = true, dateWindow?: { from: string; to: string }) {
  const [page, setPage] = useState<JournalPage>(EMPTY_PAGE);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [reload, setReload] = useState(0), [pageLimit, setPageLimit] = useState({ key: "", count: PAGE_SIZE });
  const completed = useRef<{ key: string; reload: number; page: JournalPage } | null>(null);
  const range = dateWindow || journalRange(view);
  const selectedScope = scope === null ? view.libraries : view.libraries === null ? scope : scope.filter(id => view.libraries!.includes(id));
  const scopeKey = JSON.stringify(canonicalScope(selectedScope));
  const query = view.query.trim();
  const key = JSON.stringify([scopeKey, range, query, view.sort, view.ascending, revision]);
  const request = useMemo(() => ({ spaceIds: JSON.parse(scopeKey) as string[] | null, options: { from: range.from, to: range.to, query, sort: view.sort, ascending: view.ascending } }), [scopeKey, range.from, range.to, query, view.sort, view.ascending]);
  const autoComplete = view.layout === "calendar" || view.layout === "stream";
  const count = pageLimit.key === key ? pageLimit.count : PAGE_SIZE;
  useEffect(() => {
    if (!enabled) {
      completed.current = null; setPage(EMPTY_PAGE); setLoading(false); setError(""); return;
    }
    let cancelled = false;
    const cached = completed.current?.key === key && completed.current.reload === reload ? completed.current.page : null;
    if (cached && (cached.items.length >= cached.total || (!autoComplete && cached.items.length >= count))) {
      setPage(cached); setLoading(false); setError(""); return;
    }
    setLoading(true); setError("");
    async function read() {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          let first = attempt === 0 ? cached : null;
          const items = first ? [...first.items] : [];
          const identities = new Set(items.map(item => JSON.stringify([item.provider, item.libraryId, item.documentId])));
          let changed = false;
          do {
            const next = await invoke<JournalPage>("journal_page", { ...request, options: { ...request.options, offset: items.length, limit: PAGE_SIZE } });
            if (cancelled) return;
            if (!validPage(next)) throw new Error("日志返回数据无效，请重试");
            if (first && first.revision !== next.revision) { changed = true; break; }
            if (first && (first.total !== next.total || first.days !== next.days || first.libraries !== next.libraries)) throw new Error("日志统计不一致，请重试");
            first = first || next;
            const normalized = normalizeResults(next.items);
            if (normalized.length !== next.items.length || (!normalized.length && items.length < next.total) || items.length + normalized.length > next.total) throw new Error("日志读取不完整，请重试");
            for (const item of normalized) {
              const identity = JSON.stringify([item.provider, item.libraryId, item.documentId]);
              if (identities.has(identity)) throw new Error("日志读取不完整，请重试");
              identities.add(identity);
            }
            items.push(...normalized);
          } while (items.length < first!.total && (autoComplete || items.length < count));
          if (changed) continue;
          const complete = { ...first!, items };
          completed.current = { key, reload, page: complete };
          setPage(complete); setLoading(false); return;
        }
        throw new Error("日志正在更新，请稍后重试");
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setLoading(false); } }
    }
    void read();
    return () => { cancelled = true; };
  }, [request, key, count, autoComplete, reload, enabled]);
  const retry = useCallback(() => setReload(n => n + 1), []);
  const loadMore = useCallback(() => setPageLimit(current => ({ key, count: (current.key === key ? current.count : PAGE_SIZE) + PAGE_SIZE })), [key]);
  return useMemo(() => ({ ...page, loading, error, retry, loadMore }), [page, loading, error, retry, loadMore]);
}

