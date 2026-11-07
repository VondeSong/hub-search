import { invoke } from "@tauri-apps/api/core";
import { normalizeResults } from "./SearchResultNormalization";
import type { SearchResult } from "./SearchTypes";

/** Find the nearest matching journal day without depending on loaded view pages. */
export async function readAdjacentJournalPreview(
  currentDate: string,
  direction: -1 | 1,
  dates: Array<{ date: string }>,
  spaceIds: string[] | null,
  query: string,
): Promise<SearchResult | null> {
  const candidates = [...new Set(dates.map(item => item.date))]
    .filter(date => direction === 1 ? date < currentDate : date > currentDate)
    .sort((left, right) => direction === 1 ? right.localeCompare(left) : left.localeCompare(right));
  for (const date of candidates) {
    const page = await invoke<{ items: unknown }>("journal_page", {
      spaceIds,
      options: { from: date, to: date, query, limit: 1, offset: 0, ascending: true },
    });
    const first = normalizeResults(page.items)[0];
    if (first) return first;
  }
  return null;
}
