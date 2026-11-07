import { FileText, Folder, History, Quote, Search, SlidersHorizontal, Sparkles, Tag, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Dispatch,
  KeyboardEvent as ReactKeyboardEvent,
  RefObject,
  SetStateAction,
} from "react";
import type { SearchSuggestion, SearchSuggestionKind, SearchSyntaxHint } from "./SearchSuggestions";

type SearchInputAreaProps<TSelected> = {
  onCancelSearch?: () => void;
  scopeLabel?: string;
  hasSpaces: boolean;
  isMobileLayout: boolean;
  isComposing: boolean;
  query: string;
  searchFocused: boolean;
  searchHistory: string[];
  searchHistoryEnabled: boolean;
  searchSuggestionsEnabled: boolean;
  searchInput: RefObject<HTMLInputElement | null>;
  suggestions: SearchSuggestion[];
  syntaxHints: SearchSyntaxHint[];
  filterSummary: string;
  selected?: TSelected;
  clearSearchHistory: () => void;
  openSelectedResult: (result?: TSelected, source?: "result" | "preview") => void;
  rememberQuery: (value: string) => void;
  removeSearchHistoryItem: (value: string) => void;
  onApplySuggestion: (suggestion: SearchSuggestion) => void;
  setIsComposing: Dispatch<SetStateAction<boolean>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setSearchFocused: Dispatch<SetStateAction<boolean>>;
};

export function SearchInputArea<TSelected>({
  onCancelSearch,
  scopeLabel = "全部资料库",
  hasSpaces,
  isMobileLayout,
  isComposing,
  query,
  searchFocused,
  searchHistory,
  searchHistoryEnabled,
  searchSuggestionsEnabled,
  searchInput,
  suggestions,
  syntaxHints,
  filterSummary,
  selected,
  clearSearchHistory,
  openSelectedResult,
  rememberQuery,
  removeSearchHistoryItem,
  onApplySuggestion,
  setIsComposing,
  setQuery,
  setSearchFocused,
}: SearchInputAreaProps<TSelected>) {
  const [highlightedSuggestion, setHighlightedSuggestion] = useState(-1);
  const [inputValue, setInputValue] = useState(query);
  const compositionActive = useRef(false);
  const actionableSuggestions = useMemo(
    () => [...suggestions, ...syntaxHints.flatMap((hint) => hint.suggestion ?? [])],
    [suggestions, syntaxHints],
  );
  useEffect(() => setHighlightedSuggestion(-1), [query, actionableSuggestions.length]);
  useEffect(() => {
    if (!compositionActive.current) setInputValue(query);
  }, [query]);
  const applySuggestion = (suggestion: SearchSuggestion) => {
    onApplySuggestion(suggestion);
    setHighlightedSuggestion(-1);
    setSearchFocused(false);
    searchInput.current?.blur();
  };
  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (isMobileLayout && onCancelSearch) onCancelSearch();
      else clearQuery();
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && actionableSuggestions.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setHighlightedSuggestion((current) => {
        if (current < 0) return direction > 0 ? 0 : actionableSuggestions.length - 1;
        return (current + direction + actionableSuggestions.length) % actionableSuggestions.length;
      });
      return;
    }
    if (event.key !== "Enter") return;
    event.stopPropagation();
    if (highlightedSuggestion >= 0 && actionableSuggestions[highlightedSuggestion]) {
      event.preventDefault();
      applySuggestion(actionableSuggestions[highlightedSuggestion]);
      return;
    }
    event.preventDefault();
    rememberQuery(query);
    setSearchFocused(false);
    searchInput.current?.blur();
    if (!isMobileLayout) openSelectedResult(selected);
  };
  const iconFor = (kind: SearchSuggestionKind) => {
    if (kind === "history") return <History size={14} />;
    if (kind === "title") return <FileText size={14} />;
    if (kind === "tag") return <Tag size={14} />;
    if (kind === "folder") return <Folder size={14} />;
    return <Quote size={14} />;
  };
  const suggestionLabel = (kind: SearchSuggestionKind) => {
    if (kind === "history") return "最近搜索";
    if (kind === "title") return "匹配标题";
    if (kind === "tag") return "匹配标签";
    if (kind === "folder") return "匹配文件夹";
    return "搜索语法";
  };
  const kinds = (["history", "title", "tag", "folder"] as SearchSuggestionKind[])
    .filter((kind) => suggestions.some((suggestion) => suggestion.kind === kind));
  const actionIndex = (id: string) => actionableSuggestions.findIndex((suggestion) => suggestion.id === id);
  const clearQuery = () => {
    compositionActive.current = false;
    setIsComposing(false);
    setHighlightedSuggestion(-1);
    if (searchInput.current) searchInput.current.value = "";
    setInputValue("");
    setQuery("");
    setSearchFocused(true);
    window.requestAnimationFrame(() => searchInput.current?.focus());
  };

  return (
    <div className="search-box" onClick={(event) => {
      if (!(event.target as Element).closest("button, .search-suggestions")) searchInput.current?.focus();
    }}>
      <Search size={24} strokeWidth={1.8} />
      <div className="search-input-wrap">
        <input
          ref={searchInput}
          enterKeyHint={isMobileLayout ? "search" : undefined}
          autoCapitalize="none"
          autoCorrect="off"
          value={inputValue}
          onChange={(event) => {
            const value = event.target.value;
            const nativeComposing = (event.nativeEvent as InputEvent).isComposing;
            setInputValue(value);
            if (!compositionActive.current && !nativeComposing) setQuery(value);
          }}
          onCompositionStart={() => {
            compositionActive.current = true;
            setIsComposing(true);
          }}
          onCompositionEnd={(event) => {
            const value = event.currentTarget.value;
            compositionActive.current = false;
            setInputValue(value);
            setIsComposing(false);
            setQuery(value);
          }}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => window.setTimeout(() => setSearchFocused(false), 120)}
          onKeyDown={onInputKeyDown}
          placeholder={`搜索${scopeLabel}…`}
          disabled={!hasSpaces}
          aria-label={`搜索${scopeLabel}`}
        />
        {inputValue && (
          <button
            type="button"
            className="search-clear"
            title="清空搜索"
            aria-label="清空搜索"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              clearQuery();
            }}
            onClick={(event) => {
              event.stopPropagation();
              clearQuery();
            }}
          >
            <X size={15} />
          </button>
        )}
        {searchSuggestionsEnabled && searchFocused && hasSpaces && (
          <div className="search-suggestions" role="listbox" aria-label="搜索建议">
            <div className="suggestion-filter-summary"><SlidersHorizontal size={14} /><span>{filterSummary}</span></div>
            {kinds.map((kind) => (
              <section className={`suggestion-section ${kind}`} key={kind}>
                <div className="suggestion-heading">
                  <span>{iconFor(kind)}{suggestionLabel(kind)}</span>
                  {kind === "history" && searchHistoryEnabled && searchHistory.length > 0 && (
                    <button onMouseDown={(event) => event.preventDefault()} onClick={clearSearchHistory}>清除</button>
                  )}
                </div>
                {suggestions.filter((suggestion) => suggestion.kind === kind).map((suggestion) => {
                  const index = actionIndex(suggestion.id);
                  return <div className={`suggestion-row ${index === highlightedSuggestion ? "selected" : ""}`} key={suggestion.id}>
                    <button
                      role="option"
                      aria-selected={index === highlightedSuggestion}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlightedSuggestion(index)}
                      onClick={() => applySuggestion(suggestion)}
                    >
                      {iconFor(suggestion.kind)}
                      <span><strong>{suggestion.label}</strong>{suggestion.detail && <small>{suggestion.detail}</small>}</span>
                    </button>
                    {kind === "history" && <button
                      className="suggestion-remove"
                      aria-label={`删除搜索历史 ${suggestion.label}`}
                      title="删除这条历史"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => removeSearchHistoryItem(suggestion.label)}
                    ><X size={13} /></button>}
                  </div>;
                })}
              </section>
            ))}
            <section className="suggestion-section syntax">
              <div className="suggestion-heading"><span><Sparkles size={14} />搜索语法</span></div>
              {syntaxHints.map((hint) => {
                const index = hint.suggestion ? actionIndex(hint.suggestion.id) : -1;
                const content = <><Sparkles size={14} /><span><strong>{hint.title}</strong><small>{hint.detail}</small></span></>;
                return hint.suggestion
                  ? <button
                      className={`syntax-hint actionable ${index === highlightedSuggestion ? "selected" : ""}`}
                      role="option"
                      aria-selected={index === highlightedSuggestion}
                      key={hint.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlightedSuggestion(index)}
                      onClick={() => applySuggestion(hint.suggestion!)}
                    >{content}</button>
                  : <div className="syntax-hint" key={hint.id}>{content}</div>;
              })}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
