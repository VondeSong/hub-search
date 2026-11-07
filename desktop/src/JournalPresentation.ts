import { cleanSearchSnippet } from "./ResultExcerpt";
import { resultDisplayTitle } from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";

/** Clean display copy only; preserve the source page and its date identity. */
export function journalEntryTitle(result: SearchResult): string {
  const title = resultDisplayTitle(result);
  const datePrefix = /^\d{4}[-.]\d{2}[-.]\d{2}(?:\s+|$)/;
  const clean = (value: string) => cleanSearchSnippet(value)
    .replace(/<\/?[a-z][^>]*$/i, "")
    .replace(datePrefix, "").trim();
  return (clean(title) || clean(result.snippet) || `${result.libraryName} 的日志`).slice(0, 160);
}

export function journalScopeTitle(date: string): string {
  if (!date) return "全部日志";
  const [year, month, day] = date.split("-").map(Number);
  return day ? `${month}月${day}日` : `${year}年${month}月`;
}
