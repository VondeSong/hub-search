import { Check, ChevronDown, Layers3, Settings } from "lucide-react";
import { memo } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createPortal } from "react-dom";
import type { Provider } from "./ProviderLabels";
import type { LibrarySummary } from "./SearchTypes";

type LibrarySwitcherProps = {
  activeSpaces: LibrarySummary[];
  currentSpaceName: string;
  isMobileLayout?: boolean;
  selectedLibraryIds: string[] | null;
  spaceMenuOpen: boolean;
  spaces: LibrarySummary[];
  libraryFacetCounts?: Record<string, number>;
  facetCountsTruncated?: boolean;
  providerName: (provider: Provider) => string;
  providerUnavailableLabel: (provider: Provider) => string;
  renderLibraryIcon: (space: LibrarySummary) => ReactNode;
  setShowConnection: Dispatch<SetStateAction<boolean>>;
  setSpaceMenuOpen: Dispatch<SetStateAction<boolean>>;
  toggleAllLibraries: () => void;
  toggleLibrarySelection: (libraryId: string) => void;
};

export const LibrarySwitcher = memo(function LibrarySwitcher({
  activeSpaces,
  currentSpaceName,
  isMobileLayout = false,
  selectedLibraryIds,
  spaceMenuOpen,
  spaces,
  libraryFacetCounts,
  facetCountsTruncated = false,
  providerName,
  providerUnavailableLabel,
  renderLibraryIcon,
  setShowConnection,
  setSpaceMenuOpen,
  toggleAllLibraries,
  toggleLibrarySelection,
}: LibrarySwitcherProps) {
  const menu = spaceMenuOpen ? (
    <div className="space-menu" role="menu" aria-label="选择资料库">
      <button
        className={`space-all-row ${selectedLibraryIds === null ? "active" : ""}`}
        aria-pressed={selectedLibraryIds === null}
        title={selectedLibraryIds === null ? "点击取消全部资料库" : "点击选择全部资料库"}
        onClick={toggleAllLibraries}
        onDoubleClick={toggleAllLibraries}
      >
        <span className="space-avatar"><Layers3 size={16} /></span>
        <span className="space-menu-copy"><strong>全部资料库</strong><small>{spaces.length} 个资料库 · {libraryFacetCounts ? Object.values(libraryFacetCounts).reduce((sum, count) => sum + count, 0) : spaces.reduce((count, space) => count + space.documentCount, 0)}{libraryFacetCounts && facetCountsTruncated ? "+" : ""} 篇</small></span>
        <span className={`selection-box ${selectedLibraryIds === null ? "checked" : selectedLibraryIds.length ? "partial" : ""}`}>{selectedLibraryIds === null ? <Check size={13} /> : selectedLibraryIds.length ? <i /> : null}</span>
      </button>
      {(["craft", "feishu", "dida365", "obsidian"] as const).map((provider) => {
        const providerSpaces = spaces.filter((space) => space.provider === provider);
        if (!providerSpaces.length) return null;
        return <div className="space-menu-group" key={provider}>
          <div className="space-menu-group-label">{providerName(provider)}</div>
          {providerSpaces.map((space) => {
            const selectedSpace = selectedLibraryIds === null || selectedLibraryIds.includes(space.id);
            return <button key={space.id} className={selectedSpace ? "active" : ""} aria-pressed={selectedSpace} onClick={() => toggleLibrarySelection(space.id)}>
              {renderLibraryIcon(space)}
              <span className="space-menu-copy"><strong>{space.name}</strong><small>{libraryFacetCounts ? libraryFacetCounts[space.id] ?? 0 : space.documentCount}{libraryFacetCounts && facetCountsTruncated ? "+" : ""} {space.provider === "dida365" ? "项" : "篇"}{space.connected ? "" : ` · ${providerUnavailableLabel(space.provider)}`}</small></span>
              <span className={`selection-box ${selectedSpace ? "checked" : ""}`}>{selectedSpace && <Check size={13} />}</span>
            </button>;
          })}
        </div>;
      })}
      <button className="add-space-row" onClick={() => { setSpaceMenuOpen(false); setShowConnection(true); }}><Settings size={15} />管理资料库</button>
    </div>
  ) : null;

  return (
    <div className="space-switcher" onBlur={(event) => {
      if (!isMobileLayout && !event.currentTarget.contains(event.relatedTarget)) setSpaceMenuOpen(false);
    }}>
      <button className="space-button" aria-haspopup="menu" aria-expanded={spaceMenuOpen} onClick={() => setSpaceMenuOpen((open) => !open)}>
        {selectedLibraryIds === null
          ? <span className="space-avatar all"><Layers3 size={17} /></span>
          : activeSpaces.length === 0
            ? <span className="space-avatar all"><Layers3 size={17} /></span>
            : activeSpaces.length === 1
              ? renderLibraryIcon(activeSpaces[0])
              : <span className="space-avatar-stack">{activeSpaces.map((space) =>
                <span key={space.id}>{renderLibraryIcon(space)}</span>
              )}</span>}
        <span>{currentSpaceName}</span><ChevronDown size={15} />
      </button>
      {spaceMenuOpen && (isMobileLayout
        ? createPortal(
          <div className="mobile-space-menu-backdrop" onClick={() => setSpaceMenuOpen(false)}>
            <div onClick={(event) => event.stopPropagation()}>{menu}</div>
          </div>,
          document.body,
        )
        : menu)}
    </div>
  );
});
