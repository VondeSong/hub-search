import { resultExcerpt } from "./ResultExcerpt";
import { didaResultStatusLabel, resultDisplayTitle } from "./SearchResultPresentation";
import { Bookmark, ChevronDown, ChevronUp, Star } from "lucide-react";
import "./GroupedSearchResults.css";
import { useMemo, useState } from "react";
import type { MouseEvent, DragEvent, ReactNode } from "react";
import { DEFAULT_VISIBLE_PASSAGES, groupQuickSearchResults, resultFields, resultMatchTerms, resultPassage } from "./QuickSearchGrouping";
import { HighlightedText } from "./SearchPresentation";
import { providerName } from "./ProviderLabels";
import type { SearchResult } from "./SearchTypes";
import { SearchResultContext } from "./SearchResultContext";
import { asPageFavorite, pageFavoriteKey, snippetFavoriteKey } from "./PageFavorites";

function evidenceLabel(result: SearchResult): string {
  const fields = resultFields(result);
  const labels: Record<string, string> = { title: "标题匹配", heading: "章节匹配", tag: "标签匹配", alias: "别名匹配", attachment: "附件名匹配", path: "路径匹配" };
  return fields.map(field => labels[field]).filter(Boolean).join(" · ")
    || (fields.includes("body") ? "正文匹配 · 打开预览定位" : "相关结果 · 打开预览查看");
}

function sourceContext(result: SearchResult): string {
  return [providerName(result.provider), result.libraryName, result.path]
    .filter((part, index, parts) => part && parts.indexOf(part) === index).join(" / ");
}

type Props = {
  compact?: boolean;
  isMobileLayout?: boolean;
  onHoverResult?: (index: number) => void;
  onContextResult?: (event: MouseEvent, result: SearchResult, index: number) => void;
  onPrepareResultLink?: (result: SearchResult) => void;
  onDragResult?: (event: DragEvent, result: SearchResult) => void;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (result: SearchResult) => void;
  snippetFavoriteIds?: Set<string>;
  onToggleSnippetFavorite?: (result: SearchResult) => void;
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
};

export function QuickSearchResultList({ query, results, selectedIndex, renderLibraryIcon, onSelectResult, onOpenResult, isMobileLayout, onContextResult, onPrepareResultLink, onDragResult, favoriteIds, onToggleFavorite, snippetFavoriteIds, onToggleSnippetFavorite, compact = false }: Props) {
  const groups = useMemo(() => groupQuickSearchResults(results), [results]);
  const [expansion, setExpansion] = useState<{ query: string; keys: Set<string> }>({ query, keys: new Set() });
  const expandedKeys = expansion.query === query ? expansion.keys : new Set<string>();

  const actions = (result: SearchResult, index: number) => ({
    onMouseEnter: () => onPrepareResultLink?.(result),
    onContextMenu: (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); onContextResult?.(event, result, index); },
    onPointerDown: () => onPrepareResultLink?.(result),
    draggable: !isMobileLayout && Boolean(onDragResult),
    onDragStart: (event: DragEvent) => onDragResult?.(event, result),
    onClick: () => onSelectResult(index),
    onDoubleClick: isMobileLayout ? undefined : () => onOpenResult(result),
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); onOpenResult(result); }
    },
  });
  const favorite = (result: SearchResult) => onToggleFavorite && <button type="button" className="grouped-search-favorite"
    aria-label={favoriteIds?.has(pageFavoriteKey(result)) ? "取消收藏页面" : "收藏页面"}
    title={favoriteIds?.has(pageFavoriteKey(result)) ? "已收藏页面，点击取消" : "收藏整个页面"}
    aria-pressed={favoriteIds?.has(pageFavoriteKey(result)) ?? false}
    onClick={() => onToggleFavorite(result)}>
    <Star size={14} fill={favoriteIds?.has(pageFavoriteKey(result)) ? "currentColor" : "none"} />
  </button>;

  const visibleLimit = compact ? 1 : DEFAULT_VISIBLE_PASSAGES;
  return <div className={`quick-craft-result-list ${compact ? "grouped-results-compact" : "grouped-results-detail"}`}>
    {groups.map(({ key, entries }) => {
      const heading = entries[0].result;
      const terms = heading.pageMatchTerms ?? [...new Set(entries.flatMap(({ result }) => resultMatchTerms(result, query)))];
      const fields = heading.pageMatchFields ?? [...new Set(entries.flatMap(({ result }) => resultFields(result)))];
      const bodyCount = entries.filter(({ result }) => resultPassage(result, query)?.body).length;
      const pageOnly = entries.length === 1 && !resultPassage(heading, query);
      // Reveal a keyboard-selected hidden hit synchronously, before parent scroll effects.
      const selectedHidden = entries.slice(visibleLimit).some(entry => entry.index === selectedIndex);
      const expanded = expandedKeys.has(key) || selectedHidden;
      const visible = expanded ? entries : entries.slice(0, visibleLimit);
      const title = resultDisplayTitle(heading);
      const context = sourceContext(heading);
      const summary = [fields.includes("title") ? "标题匹配" : "", bodyCount ? `${bodyCount} 段正文匹配` : "",
        ...["path", "tag", "alias"].filter(field => fields.includes(field)).map(field => ({ path: "路径匹配", tag: "标签匹配", alias: "别名匹配" }[field]))]
        .filter(Boolean).join(" · ");
      return <section className="quick-craft-result-group" key={key} aria-label={title}>
        <div className={`quick-craft-result-heading ${pageOnly ? "page-only" : ""} ${pageOnly && !heading.snippet.trim() ? "empty-content" : ""}`}
          onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onContextResult?.(event, asPageFavorite(heading), entries[0].index); }}>
          {renderLibraryIcon(heading, heading.libraryName)}
          <div className="grouped-heading-copy">
            <div className="grouped-heading-title-row">
              <button type="button" className={`grouped-page-hit ${pageOnly && entries[0].index === selectedIndex ? "selected" : ""}`}
                aria-current={pageOnly && entries[0].index === selectedIndex ? "true" : undefined}
                {...actions(heading, entries[0].index)}
                onContextMenu={event => { event.preventDefault(); event.stopPropagation(); onContextResult?.(event, asPageFavorite(heading), entries[0].index); }}>
                <span className="grouped-page-title">
                  <HighlightedText text={title} terms={fields.includes("title") || !fields.length ? terms : []} />
                  {didaResultStatusLabel(heading) && <small className={`dida-result-status${heading.taskStatus === -1 ? " abandoned" : ""}`}>{didaResultStatusLabel(heading)}</small>}
                </span>
                <SearchResultContext path={context} modifiedAt={heading.modifiedAt} />
              </button>
              {favorite(heading)}
            </div>
            {!compact && <div className="grouped-page-summary">{summary || (pageOnly ? evidenceLabel(heading) : "章节 / 附件匹配")}</div>}
            {!compact && pageOnly && heading.sourceTitle && <div className="grouped-page-evidence"><HighlightedText text={heading.sourceTitle} terms={terms} /></div>}
            {!compact && pageOnly && (fields.includes("tag") || fields.includes("alias")) && terms.length > 0 &&
              <div className="grouped-page-evidence">匹配词：<HighlightedText text={terms.join("、")} terms={terms} /></div>}
          </div>
        </div>
        {!pageOnly && <div className="grouped-page-passages">
          {visible.map(({ result, index }) => {
            const matchTerms = resultMatchTerms(result, query);
            const passage = resultPassage(result, query);
            const excerpt = passage ? resultExcerpt(passage.text, matchTerms, compact ? 320 : 480, title) : undefined;
            const kind = compact ? "" : /ocr/.test(result.sourceType) ? "识别文字" : passage && !passage.body ? "章节" : "";
            return <div className="grouped-search-hit" key={result.entityKey}>
              <button type="button" className={`quick-craft-result-block ${index === selectedIndex ? "selected" : ""}`}
                aria-current={index === selectedIndex ? "true" : undefined}
                {...actions(result, index)}>
                {(kind || result.sourceTitle || result.pageNumber) && <span className="grouped-passage-kind">{[kind, result.sourceTitle, result.pageNumber ? `第 ${result.pageNumber} 页` : ""].filter(Boolean).join(" · ")}</span>}
                {excerpt ? <span className="grouped-passage-excerpt"><HighlightedText text={excerpt.text} terms={matchTerms} /></span> :
                  <span className="grouped-match-evidence">{compact ? <HighlightedText text={result.sourceTitle || result.title} terms={matchTerms} /> : <>{evidenceLabel(result)}{result.sourceTitle && <> · <HighlightedText text={result.sourceTitle} terms={matchTerms} /></>}</>}</span>}
              </button>
              {onToggleSnippetFavorite && result.snippet.trim() && <div className="grouped-result-tools">
                <button type="button" className="grouped-snippet-favorite"
                  aria-label={snippetFavoriteIds?.has(snippetFavoriteKey(result)) ? "取消收藏此片段" : "收藏此片段"}
                  title={snippetFavoriteIds?.has(snippetFavoriteKey(result)) ? "已收藏此片段，点击取消" : "收藏此片段"}
                  aria-pressed={snippetFavoriteIds?.has(snippetFavoriteKey(result)) ?? false}
                  onContextMenu={actions(result, index).onContextMenu}
                  onClick={() => onToggleSnippetFavorite(result)}>
                  <Bookmark size={14} fill={snippetFavoriteIds?.has(snippetFavoriteKey(result)) ? "currentColor" : "none"} />
                </button>
              </div>}
            </div>;
          })}
          {entries.length > visibleLimit && <button type="button" className="grouped-excerpt-toggle" aria-expanded={expanded}
            onClick={() => {
              if (expanded && selectedHidden) onSelectResult(entries[0].index);
              const keys = new Set(expandedKeys);
              if (expanded) keys.delete(key); else keys.add(key);
              setExpansion({ query, keys });
            }}>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {expanded ? "收起" : compact ? `展开其余 ${entries.length - visibleLimit} 段` : `展开其余 ${entries.length - visibleLimit} ${entries.slice(visibleLimit).every(({ result }) => resultPassage(result, query)?.body) ? "段" : "处匹配"}`}
          </button>}
        </div>}
      </section>;
    })}
  </div>;
}
