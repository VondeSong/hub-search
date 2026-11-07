import type { FolderSummary, SearchResult } from "./SearchTypes";
import { smartCollectionSourceLabel, type SmartCollectionDateFilter } from "./SmartCollections";
import type { SearchScope, SourceFilters } from "./useLocalSearch";

export type SearchSuggestionKind = "history" | "title" | "tag" | "folder" | "phrase";

export type SearchSuggestion = {
  id: string;
  kind: SearchSuggestionKind;
  label: string;
  detail?: string;
  query?: string;
  folderId?: string;
};

export type SearchSyntaxHint = {
  id: string;
  title: string;
  detail: string;
  suggestion?: SearchSuggestion;
};

type TagSummary = { name: string; normalizedName: string; count: number };

type BuildSearchSuggestionsOptions = {
  query: string;
  history: string[];
  results: SearchResult[];
  tags: TagSummary[];
  folders: FolderSummary[];
};

function normalizedIncludes(value: string, needle: string): boolean {
  return value.toLocaleLowerCase().includes(needle.toLocaleLowerCase());
}

export function buildSearchSuggestions({
  query,
  history,
  results,
  tags,
  folders,
}: BuildSearchSuggestionsOptions): SearchSuggestion[] {
  const needle = query.trim();
  const suggestions: SearchSuggestion[] = [];
  const matchingHistory = history
    .filter((item) => !needle || normalizedIncludes(item, needle))
    .slice(0, needle ? 3 : 6);
  suggestions.push(...matchingHistory.map((item) => ({
    id: "history:" + item,
    kind: "history" as const,
    label: item,
    query: item,
  })));
  if (!needle) return suggestions;

  const seenTitles = new Set<string>();
  let titleCount = 0;
  for (const result of results) {
    const title = result.documentTitle?.trim() || result.title.trim();
    const normalized = title.toLocaleLowerCase();
    if (!title || seenTitles.has(normalized)) continue;
    seenTitles.add(normalized);
    suggestions.push({
      id: "title:" + result.entityKey,
      kind: "title",
      label: title,
      detail: result.libraryName + " · " + result.path,
      query: title,
    });
    titleCount += 1;
    if (titleCount >= 4) break;
  }

  const matchingTags = tags
    .filter((tag) => normalizedIncludes(tag.name, needle) || normalizedIncludes(tag.normalizedName, needle))
    .sort((left, right) => {
      const leftStarts = left.name.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase());
      const rightStarts = right.name.toLocaleLowerCase().startsWith(needle.toLocaleLowerCase());
      return Number(rightStarts) - Number(leftStarts) || right.count - left.count;
    })
    .slice(0, 4);
  suggestions.push(...matchingTags.map((tag) => ({
    id: "tag:" + tag.normalizedName,
    kind: "tag" as const,
    label: "#" + tag.name,
    detail: tag.count + " 条内容",
    query: tag.name,
  })));

  const matchingFolders = folders
    .filter((folder) => normalizedIncludes(folder.name, needle) || normalizedIncludes(folder.path, needle))
    .slice(0, 3);
  suggestions.push(...matchingFolders.map((folder) => ({
    id: "folder:" + folder.spaceId + ":" + folder.id,
    kind: "folder" as const,
    label: folder.path,
    detail: folder.libraryName,
    folderId: folder.spaceId + "\u0000" + folder.id,
  })));
  return suggestions;
}

export function searchSyntaxHints(query: string): SearchSyntaxHint[] {
  const value = query.trim();
  if (!value) return [{
    id: "syntax-overview",
    title: "搜索技巧",
    detail: "支持完整短语、中文全拼、拼音首字母和英文拼写容错",
  }];
  const hints: SearchSyntaxHint[] = [];
  const quoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"');
  const unquoted = value.replace(/"/g, "");
  hints.push(quoted ? {
    id: "phrase-active",
    title: "正在匹配完整短语",
    detail: "双引号内的词需要连续出现",
  } : {
    id: "phrase",
    title: "用双引号锁定完整短语",
    detail: "搜索 “" + unquoted + "”",
    suggestion: {
      id: "phrase-action",
      kind: "phrase",
      label: "“" + unquoted + "”",
      detail: "完整短语",
      query: '"' + unquoted + '"',
    },
  });
  if (/^[a-z\s]+$/i.test(value)) {
    hints.push({
      id: "pinyin",
      title: "已启用拼音匹配",
      detail: "支持中文全拼和首字母，例如 sousuo、ss",
    });
    if (!value.includes(" ") && value.length >= 3) hints.push({
      id: "fuzzy",
      title: "已启用模糊匹配",
      detail: "单个拼音或英文词允许少量拼写错误",
    });
  } else {
    hints.push({
      id: "pinyin-available",
      title: "也可以输入拼音",
      detail: "中文标题支持全拼和拼音首字母查找",
    });
  }
  return hints.slice(0, 3);
}

export function searchFilterSummary(options: {
  currentSpaceName: string;
  selectedFolder?: FolderSummary;
  dateFilter: SmartCollectionDateFilter;
  sourceFilters: SourceFilters;
  searchScope: SearchScope;
}): string {
  const scope = options.searchScope === "title"
    ? "页面名称"
    : options.searchScope === "title_heading"
      ? "页面名称与章节"
      : "全部字段";
  const parts = [options.currentSpaceName, smartCollectionSourceLabel(options.sourceFilters)];
  if (options.selectedFolder) parts.push(options.selectedFolder.path);
  parts.push(options.dateFilter === "any" ? "不限时间" : "近 " + options.dateFilter + " 天", scope);
  return parts.join(" · ");
}
