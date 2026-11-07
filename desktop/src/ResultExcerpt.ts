import { containsSearchTerm, searchMatchRanges } from "./SearchMatch";

export function cleanSearchSnippet(text: string, terms: readonly string[] = []): string {
  // Retain a link target only when it is the matching evidence.
  return text
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, (_, label: string, url: string) =>
      terms.some(term => containsSearchTerm(url, [term]) && !containsSearchTerm(label, [term])) ? `${label} ${url}` : label)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) =>
      alias && terms.some(term => containsSearchTerm(target, [term]) && !containsSearchTerm(alias, [term])) ? `${alias} ${target}` : alias || target)
    .replace(/<[^>]+>/g, tag => containsSearchTerm(tag, terms) ? tag : " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX-]\]\s*)?/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\s+/g, " ").trim();
}

export function resultExcerpt(text: string, terms: readonly string[], limit = 120, title = "") {
  let readable = cleanSearchSnippet(text, terms);
  // Prefer matching prose over an import/source preamble, without discarding
  // metadata when it is the only available matching evidence.
  const sentences = readable.match(/[^。！？\n]+[。！？]?/g) ?? [readable];
  const prose = sentences.find(sentence => containsSearchTerm(sentence, terms)
    && !/^\s*(?:来源|原文|导入|作者|source|author|date|url)\s*[:：]/i.test(sentence)
    && !/^\s*https?:\/\//i.test(sentence));
  if (prose && sentences.length > 1) {
    const offset = readable.indexOf(prose);
    if (offset > 0) readable = `…${readable.slice(offset).trimStart()}`;
  }
  if (title && readable.startsWith(title)) {
    const rest = readable.slice(title.length).replace(/^[\s:：|·—-]+/, "");
    if (containsSearchTerm(rest, terms)) readable = rest;
  }
  readable = readable.replace(/https?:\/\/[^\s<>]+/gi, url => containsSearchTerm(url, terms) ? url : "…");
  const first = searchMatchRanges(readable, terms)[0];
  if (readable.length <= limit && (first?.start ?? 0) <= 8) return { text: readable, truncated: false };
  const start = Math.max(0, (first?.start ?? 0) - 8);
  // Keep the whole match, including unusually long phrases and surrogate pairs.
  let end = Math.min(readable.length, Math.max(start + limit, first?.end ?? 0));
  if (end < readable.length && /[\uDC00-\uDFFF]/.test(readable[end])) end++;
  const safeStart = start > 0 && /[\uDC00-\uDFFF]/.test(readable[start]) ? start - 1 : start;
  return { text: `${safeStart ? "…" : ""}${readable.slice(safeStart, end)}${end < readable.length ? "…" : ""}`, truncated: true };
}
