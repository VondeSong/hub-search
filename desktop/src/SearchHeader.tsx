import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
  SetStateAction,
} from "react";
import { PanelLeft } from "lucide-react";
import { LibrarySwitcher } from "./LibrarySwitcher";
import type { Provider } from "./ProviderLabels";
import { SearchHeaderActions } from "./SearchHeaderActions";
import { SearchInputArea } from "./SearchInputArea";
import type { SearchSuggestion, SearchSyntaxHint } from "./SearchSuggestions";
import type { LibrarySummary, SearchResult } from "./SearchTypes";

type SearchHeaderProps = {
  mobileScopeControl?: ReactNode;
  mobileSearchExpanded?: boolean;
  onCancelMobileSearch?: () => void;
  hidePreviewToggle?: boolean;
  activeFilterCount: number;
  activeSpaces: LibrarySummary[];
  currentSpaceName: string;
  filtersOpen: boolean;
  isComposing: boolean;
  isMobileLayout: boolean;
  mobilePreviewOpen: boolean;
  query: string;
  searchFocused: boolean;
  searchHistory: string[];
  searchHistoryEnabled: boolean;
  searchSuggestionsEnabled: boolean;
  searchInput: RefObject<HTMLInputElement | null>;
  suggestions: SearchSuggestion[];
  syntaxHints: SearchSyntaxHint[];
  filterSummary: string;
  searching: boolean;
  selected?: SearchResult;
  selectedLibraryIds: string[] | null;
  showPreviewPane: boolean;
  spaceMenuOpen: boolean;
  spaces: LibrarySummary[];
  libraryFacetCounts?: Record<string, number>;
  facetCountsTruncated?: boolean;
  clearSearchHistory: () => void;
  openSelectedResult: (result?: SearchResult, source?: "result" | "preview") => void;
  providerName: (provider: Provider) => string;
  providerUnavailableLabel: (provider: Provider) => string;
  rememberQuery: (value: string) => void;
  removeSearchHistoryItem: (value: string) => void;
  onApplySuggestion: (suggestion: SearchSuggestion) => void;
  renderLibraryIcon: (space: LibrarySummary) => ReactNode;
  setFiltersOpen: Dispatch<SetStateAction<boolean>>;
  setIsComposing: Dispatch<SetStateAction<boolean>>;
  setMobilePreviewOpen: Dispatch<SetStateAction<boolean>>;
  setPreviewOpen: Dispatch<SetStateAction<boolean>>;
  setQuery: Dispatch<SetStateAction<string>>;
  setSearchFocused: Dispatch<SetStateAction<boolean>>;
  setShowConnection: Dispatch<SetStateAction<boolean>>;
  setSpaceMenuOpen: Dispatch<SetStateAction<boolean>>;
  startWindowDrag: (event: ReactMouseEvent<HTMLElement>) => void;
  toggleAllLibraries: () => void;
  toggleLibrarySelection: (libraryId: string) => void;
  desktopSidebarEnabled?: boolean;
  toggleDesktopSidebar?: () => void;
  hideLibrarySwitcher?: boolean;
  flashcardsActive?: boolean;
  onOpenFlashcards?: () => void;
};

export function SearchHeader({
  mobileScopeControl,
  mobileSearchExpanded = false,
  onCancelMobileSearch,
  hidePreviewToggle = false,
  activeFilterCount,
  activeSpaces,
  currentSpaceName,
  filtersOpen,
  isComposing,
  isMobileLayout,
  mobilePreviewOpen,
  query,
  searchFocused,
  searchHistory,
  searchHistoryEnabled,
  searchSuggestionsEnabled,
  searchInput,
  suggestions,
  syntaxHints,
  filterSummary,
  searching,
  selected,
  selectedLibraryIds,
  showPreviewPane,
  spaceMenuOpen,
  spaces,
  libraryFacetCounts,
  facetCountsTruncated,
  clearSearchHistory,
  openSelectedResult,
  providerName,
  providerUnavailableLabel,
  rememberQuery,
  removeSearchHistoryItem,
  onApplySuggestion,
  renderLibraryIcon,
  setFiltersOpen,
  setIsComposing,
  setMobilePreviewOpen,
  setPreviewOpen,
  setQuery,
  setSearchFocused,
  setShowConnection,
  setSpaceMenuOpen,
  startWindowDrag,
  toggleAllLibraries,
  toggleLibrarySelection,
  desktopSidebarEnabled = false,
  toggleDesktopSidebar,
  hideLibrarySwitcher = false,
  flashcardsActive = false,
  onOpenFlashcards,
}: SearchHeaderProps) {
  return (
    <header className={`search-header${isMobileLayout && mobileSearchExpanded ? " mobile-search-expanded" : ""}`} onMouseDown={startWindowDrag}>
      <div className="header-drag-zone" aria-hidden="true" />
      {!isMobileLayout && toggleDesktopSidebar && !desktopSidebarEnabled && (
        <button
          className={`icon-button sidebar-toggle ${desktopSidebarEnabled ? "active" : ""}`}
          title={desktopSidebarEnabled ? "收起左侧边栏" : "展开左侧边栏"}
          aria-label={desktopSidebarEnabled ? "收起左侧边栏" : "展开左侧边栏"}
          aria-pressed={desktopSidebarEnabled}
          onClick={toggleDesktopSidebar}
        >
          <PanelLeft size={21} />
        </button>
      )}
      {!hideLibrarySwitcher && <LibrarySwitcher
        activeSpaces={activeSpaces}
        currentSpaceName={currentSpaceName}
        isMobileLayout={isMobileLayout}
        selectedLibraryIds={selectedLibraryIds}
        spaceMenuOpen={spaceMenuOpen}
        spaces={spaces}
        libraryFacetCounts={libraryFacetCounts}
        facetCountsTruncated={facetCountsTruncated}
        providerName={providerName}
        providerUnavailableLabel={providerUnavailableLabel}
        renderLibraryIcon={renderLibraryIcon}
        setShowConnection={setShowConnection}
        setSpaceMenuOpen={setSpaceMenuOpen}
        toggleAllLibraries={toggleAllLibraries}
        toggleLibrarySelection={toggleLibrarySelection}
      />}
      <div className="mobile-search-controls">
      <SearchInputArea
        trailingControl={mobileScopeControl}
        onCancelSearch={onCancelMobileSearch}
        scopeLabel={currentSpaceName}
        hasSpaces={spaces.length > 0 || (isMobileLayout && selectedLibraryIds === null)}
        isMobileLayout={isMobileLayout}
        isComposing={isComposing}
        query={query}
        searchFocused={searchFocused}
        searchHistory={searchHistory}
        searchHistoryEnabled={searchHistoryEnabled}
        searchSuggestionsEnabled={searchSuggestionsEnabled}
        searchInput={searchInput}
        suggestions={suggestions}
        syntaxHints={syntaxHints}
        filterSummary={filterSummary}
        selected={selected}
        clearSearchHistory={clearSearchHistory}
        openSelectedResult={openSelectedResult}
        rememberQuery={rememberQuery}
        removeSearchHistoryItem={removeSearchHistoryItem}
        onApplySuggestion={onApplySuggestion}
        setIsComposing={setIsComposing}
        setQuery={setQuery}
        setSearchFocused={setSearchFocused}
      />
      {isMobileLayout && searchFocused && <button className="mobile-search-cancel" type="button" onClick={onCancelMobileSearch}>取消</button>}
      </div>
      <SearchHeaderActions
        showAgent={!isMobileLayout && !hideLibrarySwitcher}
        hidePreviewToggle={hidePreviewToggle}
        activeFilterCount={activeFilterCount}
        filtersOpen={filtersOpen}
        hasSelectedResult={Boolean(selected)}
        isMobileLayout={isMobileLayout}
        mobilePreviewOpen={mobilePreviewOpen}
        searching={searching}
        showPreviewPane={showPreviewPane}
        flashcardsActive={flashcardsActive}
        onOpenFlashcards={onOpenFlashcards}
        setFiltersOpen={setFiltersOpen}
        setMobilePreviewOpen={setMobilePreviewOpen}
        setPreviewOpen={setPreviewOpen}
      />

    </header>
  );
}
