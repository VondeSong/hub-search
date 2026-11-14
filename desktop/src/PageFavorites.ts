import type { SearchResult } from "./SearchTypes";

// Use the same document boundary as search's page groups. Hit/block IDs must
// never affect whether the containing page is already saved.
export function pageFavoriteKey(result: SearchResult): string {
  if (result.favoriteKind === "page" && result.provider === "craft" && result.pageId && result.pageId !== result.documentId) {
    return JSON.stringify([result.provider, result.libraryId, result.spaceId, result.documentId, result.pageId]);
  }
  return JSON.stringify([result.provider, result.libraryId, result.spaceId, result.documentId || result.id]);
}

export function asPageFavorite(result: SearchResult): SearchResult {
  if(result.provider==="hub")return result;
  const key = pageFavoriteKey(result);
  const subpage = result.favoriteKind === "page" && result.provider === "craft" && result.pageId && result.pageId !== result.documentId;
  return {
    ...result,
    favoriteKind: "page",
    id: `favorite-page:${key}`,
    entityKey: key,
    blockId: subpage ? result.pageId : result.documentId,
    pageId: subpage ? result.pageId : result.documentId,
    title: result.documentTitle || result.title,
    contentType: subpage ? "craft_subpage" : "document",
    sourceType: `${result.provider}_page`,
    sourceItemId: undefined,
    sourceTitle: undefined,
    pageNumber: undefined,
    snippet: "",
    matchTerms: [],
    matchField: "",
    matchCount: 0,
    subMatches: [],
    pageMatchFields: undefined,
    pageMatchTerms: undefined,
  };
}

export function normalizePageFavorites(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(result => {
    const key = result.favoriteKind === "snippet" ? snippetFavoriteKey(result) : pageFavoriteKey(result);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(result => result.favoriteKind === "snippet" ? result : asPageFavorite(result));
}

export function togglePageFavorite(current: SearchResult[], result: SearchResult): SearchResult[] {
  const key = pageFavoriteKey(result);
  const pages = normalizePageFavorites(current);
  return pages.some(item => item.favoriteKind !== "snippet" && pageFavoriteKey(item) === key)
    ? pages.filter(item => item.favoriteKind === "snippet" || pageFavoriteKey(item) !== key)
    : [asPageFavorite(result), ...pages].slice(0, 200);
}

export function snippetFavoriteKey(result: SearchResult): string {
  return JSON.stringify(["snippet", pageFavoriteKey(result), result.sourceItemId || "", result.pageNumber ?? "", result.blockId || result.id, result.snippet.trim()]);
}

export function toggleSnippetFavorite(current: SearchResult[], result: SearchResult): SearchResult[] {
  const key = snippetFavoriteKey(result);
  return current.some(item => item.favoriteKind === "snippet" && snippetFavoriteKey(item) === key)
    ? current.filter(item => item.favoriteKind !== "snippet" || snippetFavoriteKey(item) !== key)
    : [{ ...result, favoriteKind: "snippet", entityKey: key, subMatches: [] } as SearchResult, ...current].slice(0, 200);
}
