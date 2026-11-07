import { resultDisplayTitle } from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";

export function resultLinkRequest(result: SearchResult) {
  return {
    libraryId: result.libraryId,
    documentId: result.documentId,
    blockId: result.blockId ?? result.documentId,
    resultId: result.id,
    matchField: result.matchField,
    matchTerms: result.matchTerms,
  };
}

export function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\\[\]])/g, "\\$1").replace(/\s+/g, " ").trim();
}

export function resultMarkdownLink(result: SearchResult, link: string): string {
  return `[${escapeMarkdownLabel(resultDisplayTitle(result))}](${link})`;
}

export function resultSummary(result: SearchResult): string {
  return result.snippet.replace(/^…/, "").replace(/\s+/g, " ").trim();
}

export function fallbackResultLink(result: SearchResult): string | undefined {
  if (result.provider === "craft") {
    const blockId = result.blockId ?? result.documentId;
    return `craftdocs://open?spaceId=${encodeURIComponent(result.spaceId)}&blockId=${encodeURIComponent(blockId)}`;
  }
  if (result.provider === "obsidian") {
    return `obsidian://open?vault=${encodeURIComponent(result.libraryName)}&file=${encodeURIComponent(result.path.replace(/\.md$/i, ""))}`;
  }
  return undefined;
}

export function writeResultDragData(dataTransfer: DataTransfer, result: SearchResult, resolvedLink?: string): void {
  const link = resolvedLink || fallbackResultLink(result);
  const title = resultDisplayTitle(result);
  const text = link ? resultMarkdownLink(result, link) : title;
  dataTransfer.effectAllowed = "copyLink";
  dataTransfer.setData("application/x-hub-agent-source",JSON.stringify({result}));
  dataTransfer.setData("text/plain", text);
  dataTransfer.setData("text/markdown", text);
  if (link) {
    dataTransfer.setData("text/uri-list", link);
    dataTransfer.setData("text/html", `<a href="${link.replace(/&/g, "&amp;").replace(/\"/g, "&quot;")}">${title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</a>`);
  }
}
