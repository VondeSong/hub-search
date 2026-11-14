import type { SearchResult } from "./SearchTypes";
import { queryTerms } from "./SearchResultPresentation";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { containsSearchTerm } from "./SearchMatch";

export const DEFAULT_VISIBLE_PASSAGES = 2;

function mergeContext(left: string, right: string): string | undefined {
  if (left.includes(right)) return left;
  if (right.includes(left)) return right;
  for (let size = Math.min(left.length, right.length); size >= 24; size--) {
    if (left.endsWith(right.slice(0, size))) return left + right.slice(size);
    if (right.endsWith(left.slice(0, size))) return right + left.slice(size);
  }
  return undefined;
}

export function resultMatchTerms(result: SearchResult, query: string): string[] {
  const evidence = result.matchTerms?.filter(term => term.trim()) ?? [];
  const fallback = queryTerms(query);
  // Prefer a whole literal query over overlapping tokens when available.
  return [...new Set([...evidence, ...(evidence.length && fallback.length !== 1 ? [] : fallback)])];
}

export function resultFields(result: SearchResult): string[] {
  return (result.matchField || "").split(",").map(field => field.trim()).filter(Boolean);
}

export function resultPassage(result: SearchResult, query: string): { text: string; body: boolean } | undefined {
  const fields = resultFields(result);
  const terms = resultMatchTerms(result, query);
  const snippet = cleanSearchSnippet(result.snippet, terms);
  if ((!fields.length || fields.includes("body")) && containsSearchTerm(snippet, terms)) {
    return { text: snippet, body: true };
  }
  if (fields.includes("heading") && result.title !== result.documentTitle && containsSearchTerm(result.title, terms)) {
    return { text: result.title, body: false };
  }
  return undefined;
}

export function searchResultSummary(results: SearchResult[], query: string): string {
  const pages = groupQuickSearchResults(results).length;
  const passages = results.filter(result => resultPassage(result, query)?.body).length;
  return `${pages} 项内容 · ${passages} 段正文匹配`;
}

export function groupQuickSearchResults(results: SearchResult[]) {
  const groups = new Map<string, { key: string; entries: { result: SearchResult; index: number }[] }>();
  results.forEach((result, index) => {
    const key = JSON.stringify([result.provider, result.libraryId, result.spaceId, result.documentId || result.id]);
    let group = groups.get(key);
    if (!group) {
      group = { key, entries: [] };
      groups.set(key, group);
    }
    group.entries.push({ result, index });
  });
  return [...groups.values()];
}

// Rank pages by their first hit; retain hit order within each page. Navigation
// consumes this same flattened order so Enter opens the visually selected hit.
export function prepareQuickSearchResults(results: SearchResult[], query = ""): SearchResult[] {
  return groupQuickSearchResults(results).flatMap(({ entries }) => {
    const seen = new Set<string>();
    const matches: SearchResult[] = [];
    for (const { result } of entries) {
      const candidates = [result, ...(result.subMatches ?? []).map(match => ({
        ...result, ...match,
        documentTitle: result.documentTitle || result.title,
        entityKey: JSON.stringify([result.libraryId, result.documentId, match.id]),
        subMatches: [],
      }))];
      for (const candidate of candidates) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        matches.push(candidate);
      }
    }
    const pageMatchFields = [...new Set(matches.flatMap(resultFields))];
    const pageMatchTerms = [...new Set(matches.flatMap(hit => resultMatchTerms(hit, query)))];
    const passages: SearchResult[] = [];
    for (const hit of matches) {
      const passage = resultPassage(hit, query);
      // Legacy callers without a query/evidence still retain their result rows.
      const legacy = !query && !hit.matchTerms?.length && !resultFields(hit).length;
      const attachment = Boolean(hit.sourceItemId) || /(?:ocr|pdf|attachment)/.test(hit.sourceType);
      if (!passage && !legacy && !attachment) continue;
      const text = passage?.text ?? "";
      let merged = false;
      for (let index = 0; index < passages.length; index++) {
        const previous = passages[index];
        if (previous.sourceItemId !== hit.sourceItemId || previous.pageNumber !== hit.pageNumber || previous.sourceType !== hit.sourceType) continue;
        const otherPassage = resultPassage(previous, query);
        const other = otherPassage?.text;
        // Do not conflate different anchors merely because short text repeats.
        const sameAnchor = Boolean(hit.blockId && hit.blockId === previous.blockId);
        const context = text && other && passage?.body && otherPassage?.body
          ? (sameAnchor ? mergeContext(other, text) : text.length >= 40 && other === text ? text : undefined)
          : undefined;
        if (context) {
          passages[index] = { ...previous, snippet: context,
            matchTerms: [...new Set([...resultMatchTerms(previous, query), ...resultMatchTerms(hit, query)])],
            matchField: [...new Set([...resultFields(previous), ...resultFields(hit)])].join(",") };
          merged = true;
          break;
        }
      }
      if (!merged) passages.push(hit);
    }
    const chosen = passages.length ? passages : matches.slice(0, 1);
    return chosen.map((hit, index) => index === 0 ? { ...hit, pageMatchFields, pageMatchTerms } : hit);

  });
}
