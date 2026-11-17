import { Search, X } from "lucide-react";
import type { SearchResult } from "./SearchTypes";

export function matchesMobileCollection(query: string, ...values: (string | undefined)[]) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = values.filter(Boolean).join(" ").toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}

export function filterMobileFavorites(results: SearchResult[], query: string) {
  return results.filter(result => matchesMobileCollection(query, result.title, result.documentTitle, result.snippet, result.libraryName));
}

export type MobileCollectionSearchProps = { label: string; value: string; onChange: (value: string) => void };
export function MobileCollectionSearch({ label, value, onChange }: MobileCollectionSearchProps) {
  return <div className="mobile-collection-search"><Search size={18}/><input type="search" aria-label={label} placeholder={label} value={value} onChange={event => onChange(event.target.value)}/>{value && <button type="button" aria-label={`清除${label}`} onClick={() => onChange("")}><X size={18}/></button>}</div>;
}
