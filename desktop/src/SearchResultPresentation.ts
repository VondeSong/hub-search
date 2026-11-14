import type { SearchResult } from "./SearchTypes";

const ABSOLUTE_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function formatDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(new Date(timestamp * 1000).getTime())) return "";
  return ABSOLUTE_DATE_FORMATTER.format(new Date(timestamp * 1000));
}

export function formatSemanticDate(timestamp?: number): string {
  if (!timestamp || !Number.isFinite(new Date(timestamp * 1000).getTime())) return "";
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.max(0, Math.floor((today.getTime() - target.getTime()) / (24 * 60 * 60 * 1000)));
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  if (days < 28) return `${Math.floor(days / 7)} 周前`;
  return formatDate(timestamp);
}

export function recentDateGroup(timestamp?: number): { key: string; label: string } {
  if (!timestamp || !Number.isFinite(new Date(timestamp * 1000).getTime())) return { key: "unknown", label: "时间未知" };
  const date = new Date(timestamp * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayMs = 24 * 60 * 60 * 1000;
  if (target.getTime() >= today.getTime()) return { key: "today", label: "今天" };
  if (target.getTime() >= today.getTime() - dayMs) return { key: "yesterday", label: "昨天" };
  const mondayOffset = (today.getDay() + 6) % 7;
  const thisWeek = new Date(today.getTime() - mondayOffset * dayMs);
  if (target.getTime() >= thisWeek.getTime()) return { key: "this-week", label: "本周" };
  if (target.getTime() >= thisWeek.getTime() - 7 * dayMs) return { key: "last-week", label: "上周" };
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  if (target.getTime() >= thisMonth.getTime()) return { key: "this-month", label: "本月" };
  return {
    key: `${target.getFullYear()}-${target.getMonth() + 1}`,
    label: `${target.getFullYear()}年${target.getMonth() + 1}月`,
  };
}

export function sourceTypeLabel(result: SearchResult): string {
  if (result.contentType === "reading") return "阅读";
  if (result.contentType === "flashcard") return "闪卡";
  if (result.sourceType === "dida_task" || result.contentType === "dida_task") return "任务";
  if (result.sourceType === "obsidian_page") return "Markdown";
  if (result.sourceType === "feishu_page" || result.contentType === "feishu_document") return "飞书文档";
  if (result.sourceType === "feishu_bitable_record" || result.contentType === "feishu_bitable_record") return "多维表格";
  if (result.sourceType === "feishu_bitable_table" || result.contentType === "feishu_bitable_table") return "多维表格";
  if (result.sourceType === "pdf_native") return "PDF 原生文字";
  if (result.sourceType === "pdf_ocr") return "PDF OCR";
  if (result.sourceType === "pdf_attachment") return "PDF 附件";
  if (result.sourceType === "image_ocr") return "图片 OCR";
  if (result.sourceType === "media_attachment") return "媒体";
  if (result.sourceType === "file_attachment") return "附件";
  return result.contentType === "craft_subpage" ? "子页面" : "页面";
}

export function didaResultStatusLabel(result: SearchResult): "已完成" | "已放弃" | undefined {
  if (result.provider !== "dida365") return undefined;
  if (result.taskStatus === 2) return "已完成";
  if (result.taskStatus === -1) return "已放弃";
  return undefined;
}

export function resultDisplayTitle(result: SearchResult): string {
  if (result.contentType === "task" && result.provider !== "dida365") return cleanCraftDisplayTitle(result.title);
  if (result.provider === "dida365") {
    return (result.documentTitle?.trim() || result.title.trim()).replace(
      /\[((?:[^\[\]]|\[[^\]]*\])*)\]\((?:[^()\s]|\([^()]*\))+(?:\s+"[^"]*")?\)/g,
      "$1",
    );
  }
  const sourceTitle = result.sourceTitle?.trim();
  const sourceObjectTypes = new Set([
    "pdf_native",
    "pdf_ocr",
    "pdf_attachment",
    "media_attachment",
    "file_attachment",
  ]);
  if (sourceTitle && (sourceObjectTypes.has(result.sourceType) || sourceObjectTypes.has(result.contentType))) {
    return sourceTitle;
  }
  if (result.sourceType === "image_ocr" && result.title.trim()) {
    return result.title.trim();
  }
  if (result.provider === "craft") {
    return cleanCraftDisplayTitle(result.documentTitle?.trim() || result.title);
  }
  if (result.documentTitle?.trim()) {
    return result.documentTitle.trim();
  }
  return result.title;
}

export function cleanCraftDisplayTitle(title: string): string {
  return title.replace(/<\/?(?:highlight|text|strong|em|b|i|u|s|span)\b[^>]*>/gi, "").trim();
}

export function compactResultPath(result: SearchResult): string {
  const parts = result.path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  const duplicateNames = [
    resultDisplayTitle(result),
    result.documentTitle,
    result.title,
    result.sourceTitle,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.replace(/\.(md|markdown)$/i, "").trim().toLocaleLowerCase());
  while (parts.length) {
    const last = parts[parts.length - 1].replace(/\.(md|markdown)$/i, "").trim().toLocaleLowerCase();
    if (!duplicateNames.includes(last)) break;
    parts.pop();
  }
  if (parts[0]?.toLocaleLowerCase() === result.libraryName.trim().toLocaleLowerCase()) parts.shift();
  if (!parts.length) return result.libraryName;
  if (parts.length === 1) return `${result.libraryName} / ${parts[0]}`;
  return `${result.libraryName} / … / ${parts[parts.length - 1]}`;
}

export function resultSectionTitle(result: SearchResult): string | undefined {
  if (!result.documentTitle?.trim()) return undefined;
  const fields = result.matchField
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  if (!fields.some((field) => field === "heading" || field === "body")) return undefined;
  const clean = result.provider === "craft" ? cleanCraftDisplayTitle : (value: string) => value.trim();
  return clean(result.documentTitle) === clean(result.title) ? undefined : clean(result.title);
}

export function resultSectionLabel(result: SearchResult): "命中章节" | "所在章节" {
  const fields = result.matchField
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  return fields.includes("heading") ? "命中章节" : "所在章节";
}

export function resultLibraryLabel(result: SearchResult): string {
  if (result.sourceType === "feishu_bitable_table" || result.contentType === "feishu_bitable_table" || result.sourceType === "feishu_bitable_record" || result.contentType === "feishu_bitable_record") return "数据表";
  if (result.provider === "feishu" && (result.sourceType === "feishu_page" || result.contentType === "feishu_document")) return "文档";
  if (result.provider !== "dida365") return result.libraryName;
  return result.path.split(" / ").map((part) => part.trim()).find(Boolean) ?? result.libraryName;
}

export function compactRecentPath(result: SearchResult): string {
  return compactResultPath(result);
}

export function resultOnlyMatchesTitle(result: SearchResult): boolean {
  const fields = result.matchField
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  return fields.length > 0 && fields.every((field) => field === "title");
}

export function resultShouldShowSnippet(result: SearchResult, query: string): boolean {
  const fields = result.matchField
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  const hasContentMatch = fields.some((field) => field === "body" || field === "heading");
  return hasContentMatch && Boolean(result.snippet.trim()) && resultSnippetMatchCount(result, query) > 0;
}

export function queryTerms(query: string): string[] {
  return query
    .match(/"[^"]+"|[^\s]+/g)
    ?.map((term) => term.replace(/^"|"$/g, "").trim())
    .filter((term) => term && !["AND", "OR", "NOT"].includes(term.toUpperCase())) ?? [];
}

export function resultSnippetMatchCount(result: SearchResult, query: string): number {
  return resultSnippetMatchCountForTerms(
    result,
    result.matchTerms.length ? result.matchTerms : queryTerms(query),
  );
}

function resultSnippetMatchCountForTerms(result: SearchResult, terms: string[]): number {
  const text = result.snippet.toLocaleLowerCase();
  const normalizedTerms = terms
    .map((term) => term.trim().toLocaleLowerCase())
    .filter(Boolean);
  let matches = 0;
  for (const term of normalizedTerms) {
    let start = 0;
    while (start < text.length) {
      const index = text.indexOf(term, start);
      if (index < 0) break;
      matches += 1;
      start = index + Math.max(term.length, 1);
    }
  }
  return matches;
}

export function resultSnippetUsesTwoLines(result: SearchResult, query: string): boolean {
  const snippet = result.snippet.trim();
  if (snippet.length <= 96) return false;
  return resultSnippetMatchCount(result, query) > 1;
}

export type SearchResultRowPresentation = {
  terms: string[];
  displayTitle: string;
  libraryLabel: string;
  contextPath: string;
  sourceLabel: string;
  dateLabel: string;
  titleOnly: boolean;
  showSnippet: boolean;
  snippetUsesTwoLines: boolean;
};

export function searchResultRowPresentation(
  result: SearchResult,
  fallbackTerms: string[],
): SearchResultRowPresentation {
  const terms = result.matchTerms.length ? result.matchTerms : fallbackTerms;
  const fields = result.matchField
    .split(",")
    .map((field) => field.trim().toLowerCase())
    .filter(Boolean);
  const hasContentMatch = fields.some((field) => field === "body" || field === "heading");
  const snippet = result.snippet.trim();
  const snippetMatchCount = hasContentMatch && snippet
    ? resultSnippetMatchCountForTerms(result, terms)
    : 0;

  return {
    terms,
    displayTitle: resultDisplayTitle(result),
    libraryLabel: resultLibraryLabel(result),
    contextPath: compactResultPath(result),
    sourceLabel: sourceTypeLabel(result),
    dateLabel: formatDate(result.modifiedAt),
    titleOnly: fields.length > 0 && fields.every((field) => field === "title"),
    showSnippet: hasContentMatch && Boolean(snippet) && snippetMatchCount > 0,
    snippetUsesTwoLines: snippet.length > 96 && snippetMatchCount > 1,
  };
}
