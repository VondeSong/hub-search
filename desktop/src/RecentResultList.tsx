import "./ResultFavoriteToggle.css";
import { Star } from "lucide-react";
import { memo, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { TaskCompletionIcon } from "./TaskCompletionIcon";
import {
  compactRecentPath,
  didaResultStatusLabel,
  formatDate,
  formatSemanticDate,
  resultDisplayTitle,
} from "./SearchResultPresentation";
import type { SearchResult } from "./SearchTypes";
import { pageFavoriteKey, snippetFavoriteKey } from "./PageFavorites";
import { journalEntryTitle } from "./JournalPresentation";

export type RecentGroup = {
  key: string;
  label: string;
  entries: Array<{ result: SearchResult; index: number }>;
  hideEntryDates?: boolean;
};

export type RecentResultListProps = {
  recentGroups: RecentGroup[];
  selectedIndex: number;
  isMobileLayout: boolean;
  semanticRecentDates: boolean;
  onHoverResult: (index: number) => void;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onContextResult: (event: ReactMouseEvent, result: SearchResult, index: number) => void;
  onPrepareResultLink: (result: SearchResult) => void;
  onDragResult: (event: ReactDragEvent, result: SearchResult) => void;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  favoriteIds?: Set<string>;
  snippetFavoriteIds?: Set<string>;
  onToggleFavorite?: (result: SearchResult) => void;
};

type RecentResultRowProps = {
  result: SearchResult;
  index: number;
  selected: boolean;
  hideEntryDate: boolean;
  isMobileLayout: boolean;
  semanticRecentDates: boolean;
  favorite: boolean;
  onHoverResult: (index: number) => void;
  onSelectResult: (index: number) => void;
  onOpenResult: (result: SearchResult) => void;
  onContextResult: (event: ReactMouseEvent, result: SearchResult, index: number) => void;
  onPrepareResultLink: (result: SearchResult) => void;
  onDragResult: (event: ReactDragEvent, result: SearchResult) => void;
  renderLibraryIcon: (result: SearchResult, name: string) => ReactNode;
  onToggleFavorite?: (result: SearchResult) => void;
};

const RecentResultRow = memo(function RecentResultRow({
  result, index, selected, hideEntryDate, isMobileLayout, semanticRecentDates, favorite,
  onHoverResult, onSelectResult, onOpenResult, onContextResult, onPrepareResultLink,
  onDragResult, renderLibraryIcon, onToggleFavorite,
}: RecentResultRowProps) {
  const absoluteDate = formatDate(result.modifiedAt);
  const displayedDate = semanticRecentDates ? formatSemanticDate(result.modifiedAt) : absoluteDate;
  const contextPath = compactRecentPath(result).trim();
  const showContextPath = Boolean(contextPath) && contextPath !== resultDisplayTitle(result).trim();
  const taskStatusLabel = didaResultStatusLabel(result);
  const taskCompleted = taskStatusLabel === "已完成";
  // Page favorites deliberately omit search snippets; that is not empty-page evidence.
  const dimEmptyContent = !favorite && !result.favoriteKind && !result.snippet.trim();
  const displayedTitle = hideEntryDate ? journalEntryTitle(result) : resultDisplayTitle(result);

  return (
    <div
      className={`recent-item ${result.favoriteKind === "snippet" ? "saved-snippet" : ""} ${result.provider} ${onToggleFavorite ? "has-favorite-action" : ""} ${dimEmptyContent ? "empty-content" : ""} ${taskCompleted ? "task-completed" : ""} ${selected ? "selected" : ""}`}
      onMouseEnter={() => {
        if (!isMobileLayout) onHoverResult(index);
        onPrepareResultLink(result);
      }}
      onContextMenu={(event) => onContextResult(event, result, index)}
    >
      <button
        className="recent-row"
        role="option"
        aria-selected={selected}
        draggable={!isMobileLayout}
        onPointerDown={() => onPrepareResultLink(result)}
        onDragStart={isMobileLayout ? undefined : (event) => onDragResult(event, result)}
        onClick={() => onSelectResult(index)}
        onDoubleClick={isMobileLayout ? undefined : () => onOpenResult(result)}
      >
        {renderLibraryIcon(result, result.libraryName)}
        <span className="recent-copy">
          {result.favoriteKind === "snippet" && <span className="saved-snippet-excerpt">「{result.snippet}」</span>}
          <strong className="recent-title" title={resultDisplayTitle(result)}>
            <span className="recent-title-text">{displayedTitle}</span>
            {taskStatusLabel && (taskCompleted
              ? <small className="dida-result-status completed" role="img" aria-label="已完成" title="已完成"><TaskCompletionIcon /></small>
              : <small className="dida-result-status abandoned">{taskStatusLabel}</small>)}
          </strong>
          {!isMobileLayout && showContextPath && <>
            <span className="recent-separator" aria-hidden="true">—</span>
            <span className="recent-path" title={`${result.libraryName} / ${result.path}`}>{contextPath}</span>
          </>}
          {isMobileLayout && <span className="mobile-recent-meta">
            {showContextPath && <span className="recent-path" title={`${result.libraryName} / ${result.path}`}>{contextPath}</span>}
            {result.modifiedAt && absoluteDate && !hideEntryDate && <time className="recent-date" dateTime={new Date(result.modifiedAt * 1000).toISOString()} title={absoluteDate}>{displayedDate}</time>}
          </span>}
        </span>
        {!isMobileLayout && result.modifiedAt && absoluteDate && !hideEntryDate && (
          <time className="recent-date" dateTime={new Date(result.modifiedAt * 1000).toISOString()} title={absoluteDate}>
            {displayedDate}
          </time>
        )}
        {isMobileLayout && <span className="mobile-result-disclosure" aria-hidden="true">›</span>}
      </button>
      {onToggleFavorite && <button
        className={`result-favorite-toggle recent ${favorite ? "active" : ""}`}
        onClick={(event) => { event.stopPropagation(); onToggleFavorite(result); }}
        aria-label={result.favoriteKind === "snippet" ? "取消收藏此片段" : favorite ? "取消收藏页面" : "收藏页面"}
        title={result.favoriteKind === "snippet" ? "取消收藏此片段" : favorite ? "取消收藏页面" : "收藏整个页面"}
        aria-pressed={favorite}
      ><Star size={14} fill={favorite ? "currentColor" : "none"} /></button>}
    </div>
  );
});

export function RecentResultList({
  recentGroups,
  selectedIndex,
  isMobileLayout,
  semanticRecentDates,
  onHoverResult,
  onSelectResult,
  onOpenResult,
  onContextResult,
  onPrepareResultLink,
  onDragResult,
  renderLibraryIcon,
  favoriteIds,
  snippetFavoriteIds,
  onToggleFavorite,
}: RecentResultListProps) {
  return (
    <div className="recent-list" role="listbox">
      {recentGroups.map((group) => (
        <section className={`recent-group ${group.hideEntryDates ? "journal-day-group" : ""}`} key={group.key}>
          {group.label && <h2 className="recent-group-label">{group.label}<small>{group.entries.length > 1 ? `${group.entries.length} ${isMobileLayout ? "项" : "个来源"}` : ""}</small></h2>}
          {group.entries.map(({ result, index }) => <RecentResultRow
              key={result.entityKey}
              result={result}
              index={index}
              selected={index === selectedIndex}
              hideEntryDate={Boolean(group.hideEntryDates)}
              isMobileLayout={isMobileLayout}
              semanticRecentDates={semanticRecentDates}
              favorite={result.favoriteKind === "snippet" ? snippetFavoriteIds?.has(snippetFavoriteKey(result)) ?? false : favoriteIds?.has(pageFavoriteKey(result)) ?? false}
              onHoverResult={onHoverResult}
              onSelectResult={onSelectResult}
              onOpenResult={onOpenResult}
              onContextResult={onContextResult}
              onPrepareResultLink={onPrepareResultLink}
              onDragResult={onDragResult}
              renderLibraryIcon={renderLibraryIcon}
              onToggleFavorite={onToggleFavorite}
            />)}
        </section>
      ))}
    </div>
  );
}
