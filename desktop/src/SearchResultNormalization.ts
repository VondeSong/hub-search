import type { SearchResult, SearchSubMatch } from "./SearchTypes";
import { containsSearchTerm } from "./SearchMatch";
import { cleanSearchSnippet } from "./ResultExcerpt";

function cleanCraftText(text: string, terms: unknown = []): string {
  const needles = Array.isArray(terms) ? terms.filter((term): term is string => typeof term === "string") : [];
  const cleaned = text
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```[^\n]*\n?|```$/g, " "))
    .replace(/!\[([^\]]*)]\([^)]*\)/g, "$1")
    .replace(/<page\b[^>]*>/gi, " ")
    .replace(/<\/page>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?]]/g, (_, target: string, alias?: string) => alias || target)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX-]\]\s*)?/gm, "")
    .replace(/^\s*\[[ xX-]\]\s*/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|[\s（(])[*_]([^*_\n]+)[*_](?=$|[\s，。！？、；：）)])/g, "$1$2")
    .replace(/^\s*\|/gm, "")
    .replace(/\|\s*$/gm, "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return needles.some(term => containsSearchTerm(text, [term]) && !containsSearchTerm(cleaned, [term])) ? cleanSearchSnippet(text, needles) : cleaned;
}

export function normalizeResults(result: unknown): SearchResult[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if(value.provider==="hub"&&value.contentType!=="reading"&&value.contentType!=="flashcard")return [];
    const id = typeof value.id === "string" ? value.id : "";
    const spaceId = typeof value.spaceId === "string" ? value.spaceId : "";
    if (!id || !spaceId) return [];
    const subMatches = Array.isArray(value.subMatches)
      ? value.subMatches.flatMap((candidate): SearchSubMatch[] => {
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
            snippet: typeof match.snippet === "string" ? cleanCraftText(match.snippet, match.matchTerms) : "",
            matchTerms: Array.isArray(match.matchTerms)
              ? match.matchTerms.filter((term): term is string => typeof term === "string" && Boolean(term.trim()))
              : [],
            matchField: typeof match.matchField === "string" ? match.matchField : "",
          }];
        })
      : [];
    return [{
      id,
      journalDate: typeof value.journalDate === "string" ? value.journalDate : undefined,
      entityKey: typeof value.entityKey === "string" ? value.entityKey : id,
      blockId: typeof value.blockId === "string" ? value.blockId : id,
      documentId: typeof value.documentId === "string" ? value.documentId : id,
      contentType: typeof value.contentType === "string" ? value.contentType : "document",
      sourceItemId: typeof value.sourceItemId === "string" ? value.sourceItemId : undefined,
      sourceType: typeof value.sourceType === "string" ? value.sourceType : "craft_page",
      sourceTitle: typeof value.sourceTitle === "string" ? value.sourceTitle : undefined,
      pageNumber: typeof value.pageNumber === "number" ? value.pageNumber : undefined,
      score: typeof value.score === "number" ? value.score : undefined,
      provider: value.provider === "obsidian"
        ? "obsidian"
        : value.provider === "dida365"
          ? "dida365"
          : value.provider === "feishu"
            ? "feishu"
          : value.provider === "hub" ? "hub" : "craft",
      libraryId: typeof value.libraryId === "string" ? value.libraryId : spaceId,
      libraryName: typeof value.libraryName === "string" ? value.libraryName : (typeof value.spaceName === "string" ? value.spaceName : "Craft"),
      spaceId,
      spaceName: typeof value.spaceName === "string" ? value.spaceName : "Craft",
      title: typeof value.title === "string" ? value.title : "未命名页面",
      documentTitle: typeof value.documentTitle === "string" ? value.documentTitle : undefined,
      path: typeof value.path === "string" ? value.path : "未分类",
      folderId: typeof value.folderId === "string" ? value.folderId : undefined,
      modifiedAt: typeof value.modifiedAt === "number" ? value.modifiedAt : undefined,
      taskStatus: typeof value.taskStatus === "number" ? value.taskStatus : undefined,
      snippet: typeof value.snippet === "string" ? cleanCraftText(value.snippet, value.matchTerms) : "",
      matchTerms: Array.isArray(value.matchTerms)
        ? value.matchTerms.filter((term): term is string => typeof term === "string" && Boolean(term.trim()))
        : [],
      matchField: typeof value.matchField === "string" ? value.matchField : "",
      matchCount: typeof value.matchCount === "number" ? value.matchCount : subMatches.length,
      subMatches,
    }];
  });
}
