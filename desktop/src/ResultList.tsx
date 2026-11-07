import "./ResultFavoriteToggle.css";
import { Star } from "lucide-react";
import { memo, useMemo, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import "./ResultList.css";
import { HighlightedText, MatchFieldIcons } from "./SearchPresentation";
import {
  queryTerms,
  searchResultRowPresentation,
} from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";
import { pageFavoriteKey } from "./PageFavorites";

export type ResultListProps = {
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  isMobileLayout: boolean;
  onHoverResult: (index: number) => void;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onContextResult: (event: ReactMouseEvent, result: SearchResult, index: number) => void;
  onPrepareResultLink: (result: SearchResult) => void;
  onDragResult: (event: ReactDragEvent, result: SearchResult) => void;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  favoriteIds?: Set<string>;
  onToggleFavorite?: (result: SearchResult) => void;
};

type ResultRowProps = {
  result: SearchResult;
  index: number;
  selected: boolean;
  isMobileLayout: boolean;
  favorite: boolean;
  fallbackTerms: string[];
  onHoverResult: (index: number) => void;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onContextResult: (event: ReactMouseEvent, result: SearchResult, index: number) => void;
  onPrepareResultLink: (result: SearchResult) => void;
  onDragResult: (event: ReactDragEvent, result: SearchResult) => void;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  onToggleFavorite?: (result: SearchResult) => void;
};

const ResultRow = memo(function ResultRow({
  result, index, selected, isMobileLayout, favorite, fallbackTerms,
  onHoverResult, onSelectResult, onOpenResult, onContextResult,
  onPrepareResultLink, onDragResult, renderLibraryIcon, onToggleFavorite,
}: ResultRowProps) {
  const presentation = searchResultRowPresentation(result, fallbackTerms);

  return (
    <div
      className={`result-group ${result.provider} ${onToggleFavorite ? "has-favorite-action" : ""} ${presentation.titleOnly ? "title-only" : ""} ${result.snippet.trim() ? "" : "empty-content"} ${selected ? "selected" : ""}`}
      onMouseEnter={() => {
        if (!isMobileLayout) onHoverResult(index);
        onPrepareResultLink(result);
      }}
      onContextMenu={(event) => onContextResult(event, result, index)}
    >
      <button
        className="result-row"
        role="option"
        aria-selected={selected}
        draggable={!isMobileLayout}
        onPointerDown={() => onPrepareResultLink(result)}
        onDragStart={isMobileLayout ? undefined : (event) => onDragResult(event, result)}
        onClick={() => onSelectResult(index)}
        onDoubleClick={isMobileLayout ? undefined : () => onOpenResult(result)}
      >
        <span className="result-leading">
          {renderLibraryIcon(result, presentation.libraryLabel)}
          <span className={`library-badge ${result.provider}`} title={presentation.libraryLabel}>{presentation.libraryLabel}</span>
        </span>
        <span className="result-copy">
          <span className="result-title-line">
            <span className="result-title"><HighlightedText text={presentation.displayTitle} terms={presentation.terms} /></span>
            <MatchFieldIcons matchField={result.matchField} provider={result.provider} />
          </span>
          <span className="result-meta">
            <span className="content-type">{presentation.sourceLabel}</span>
            <span className="result-path" title={result.path}>
              <HighlightedText text={presentation.contextPath} terms={presentation.terms} />
            </span>
            {result.pageNumber && <span className="result-page-number">第 {result.pageNumber} 页</span>}
            {presentation.dateLabel && <span className="result-date">{presentation.dateLabel}</span>}
          </span>
          {presentation.showSnippet && (
            <span className={`result-snippet ${presentation.snippetUsesTwoLines ? "multiline" : ""}`}>
              <HighlightedText text={result.snippet} terms={presentation.terms} />
            </span>
          )}
        </span>
        {isMobileLayout && <span className="mobile-result-disclosure" aria-hidden="true">›</span>}
      </button>
      {onToggleFavorite && <button
        className={`result-favorite-toggle ${favorite ? "active" : ""}`}
        onClick={(event) => { event.stopPropagation(); onToggleFavorite(result); }}
        aria-label={favorite ? "取消收藏页面" : "收藏页面"}
        title={favorite ? "取消收藏页面" : "收藏整个页面"}
        aria-pressed={favorite}
      ><Star size={14} fill={favorite ? "currentColor" : "none"} /></button>}
    </div>
  );
});

export function ResultList({
  query,
  results,
  selectedIndex,
  isMobileLayout,
  onHoverResult,
  onSelectResult,
  onOpenResult,
  onContextResult,
  onPrepareResultLink,
  onDragResult,
  renderLibraryIcon,
  favoriteIds,
  onToggleFavorite,
}: ResultListProps) {
  const fallbackTerms = useMemo(() => queryTerms(query), [query]);

  return (
    <div className="result-list" role="listbox">
      {results.map((result, index) => <ResultRow
        key={result.entityKey}
        result={result}
        index={index}
        selected={index === selectedIndex}
        isMobileLayout={isMobileLayout}
        favorite={favoriteIds?.has(pageFavoriteKey(result)) ?? false}
        fallbackTerms={fallbackTerms}
        onHoverResult={onHoverResult}
        onSelectResult={onSelectResult}
        onOpenResult={onOpenResult}
        onContextResult={onContextResult}
        onPrepareResultLink={onPrepareResultLink}
        onDragResult={onDragResult}
        renderLibraryIcon={renderLibraryIcon}
        onToggleFavorite={onToggleFavorite}
      />)}
    </div>
  );
}
