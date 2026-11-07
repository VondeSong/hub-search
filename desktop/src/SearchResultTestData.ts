import { cleanSearchSnippet } from "./ResultExcerpt";
import { containsSearchTerm } from "./SearchMatch";
import type { SearchResult, SearchSubMatch } from "./SearchTypes";

function cleanText(text: string, terms: unknown = []): string {
  const needles = Array.isArray(terms) ? terms.filter((term): term is string => typeof term === "string") : [];
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/[`*_~>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return needles.some(term => containsSearchTerm(text, [term]) && !containsSearchTerm(cleaned, [term])) ? cleanSearchSnippet(text, needles) : cleaned;
}

export function normalizeQuickSearchResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const result = item as Record<string, unknown>;
    const id = typeof result.id === "string" ? result.id : "";
    const spaceId = typeof result.spaceId === "string" ? result.spaceId : "";
    if (!id || !spaceId) return [];
    const subMatches = Array.isArray(result.subMatches)
      ? result.subMatches.flatMap((candidate): SearchSubMatch[] => {
          if (!candidate || typeof candidate !== "object") return [];
          const match = candidate as Record<string, unknown>;
          const matchId = typeof match.id === "string" ? match.id : "";
          if (!matchId) return [];
          return [{
            id: matchId,
            blockId: typeof match.blockId === "string" ? match.blockId : undefined,
            contentType: typeof match.contentType === "string" ? match.contentType : "document",
            sourceItemId: typeof match.sourceItemId === "string" ? match.sourceItemId : undefined,
            sourceType: typeof match.sourceType === "string" ? match.sourceType : "craft_page",
            sourceTitle: typeof match.sourceTitle === "string" ? match.sourceTitle : undefined,
            pageNumber: typeof match.pageNumber === "number" ? match.pageNumber : undefined,
            title: typeof match.title === "string" ? match.title : "正文命中",
            snippet: typeof match.snippet === "string" ? cleanText(match.snippet, match.matchTerms) : "",
            matchTerms: Array.isArray(match.matchTerms)
              ? match.matchTerms.filter((term): term is string => typeof term === "string" && Boolean(term.trim()))
              : [],
            matchField: typeof match.matchField === "string" ? match.matchField : "",
          }];
        })
      : [];
    return [{
      id,
      entityKey: typeof result.entityKey === "string" ? result.entityKey : id,
      blockId: typeof result.blockId === "string" ? result.blockId : id,
      documentId: typeof result.documentId === "string" ? result.documentId : id,
      contentType: typeof result.contentType === "string" ? result.contentType : "document",
      sourceItemId: typeof result.sourceItemId === "string" ? result.sourceItemId : undefined,
      sourceType: typeof result.sourceType === "string" ? result.sourceType : "craft_page",
      sourceTitle: typeof result.sourceTitle === "string" ? result.sourceTitle : undefined,
      pageNumber: typeof result.pageNumber === "number" ? result.pageNumber : undefined,
      score: typeof result.score === "number" ? result.score : undefined,
      provider: result.provider === "obsidian"
        ? "obsidian"
        : result.provider === "dida365"
          ? "dida365"
          : result.provider === "feishu" ? "feishu" : "craft",
      libraryId: typeof result.libraryId === "string" ? result.libraryId : spaceId,
      libraryName: typeof result.libraryName === "string"
        ? result.libraryName
        : typeof result.spaceName === "string" ? result.spaceName : "Hub",
      spaceId,
      spaceName: typeof result.spaceName === "string" ? result.spaceName : "Hub",
      title: typeof result.title === "string" ? result.title : "未命名页面",
      documentTitle: typeof result.documentTitle === "string" ? result.documentTitle : undefined,
      path: typeof result.path === "string" ? result.path : "未分类",
      folderId: typeof result.folderId === "string" ? result.folderId : undefined,
      modifiedAt: typeof result.modifiedAt === "number" ? result.modifiedAt : undefined,
      taskStatus: typeof result.taskStatus === "number" ? result.taskStatus : undefined,
      snippet: typeof result.snippet === "string" ? cleanText(result.snippet, result.matchTerms) : "",
      matchTerms: Array.isArray(result.matchTerms)
        ? result.matchTerms.filter((term): term is string => typeof term === "string")
        : [],
      matchField: typeof result.matchField === "string" ? result.matchField : "",
      matchCount: typeof result.matchCount === "number" ? result.matchCount : 0,
      subMatches,
    }];
  });
}

