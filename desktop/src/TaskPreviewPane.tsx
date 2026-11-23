import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { PreviewPane } from "./PreviewPane";
import type { SelectionSnippetOutcome } from "./PreviewSelectionActions";
import { usePreviewController } from "./usePreviewController";
import { providerName } from "./ProviderLabels";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { OperationTone } from "./useOperationStatus";
import {TaskAnswerOrigin} from "./TaskAnswerOrigin";

const Renderer = lazy(() => import("./PreviewRenderer").then(module => ({ default: module.PreviewRenderer })));
const NO_TERMS: string[] = [];
const NO_DRAG = () => undefined;

/** Task pages use the search preview's surface, document loader and status store. */
export function TaskPreviewPane({ selected, libraries, onClose, onOpenLink, onOpenSource, onCopyLink,
  copiedResultId, canGoBack, canGoForward, previewPinned, onNavigate, onTogglePinned,
  toolbarActions, moreMenuItems, contentBefore, onStatus,
  isFavorite, snippetFavoriteIds, onToggleFavorite, onToggleSnippetFavorite,
  previewFocusMode, onTogglePreviewFocus }: {
  selected: SearchResult; libraries: LibrarySummary[]; onClose: () => void;
  onOpenLink: (href?: string) => void; onOpenSource: () => void;
  onCopyLink: () => void | Promise<void>; copiedResultId: string;
  canGoBack: boolean; canGoForward: boolean; previewPinned: boolean;
  onNavigate: (direction: -1 | 1) => void; onTogglePinned: () => void;
  toolbarActions?: ReactNode; moreMenuItems?: ReactNode; contentBefore?: ReactNode;
  onStatus: (text: string, tone?: OperationTone, duration?: number) => void;
  isFavorite?: boolean;
  snippetFavoriteIds?: ReadonlySet<string>;
  onToggleFavorite?: (result: SearchResult) => SelectionSnippetOutcome;
  onToggleSnippetFavorite?: (result: SearchResult) => SelectionSnippetOutcome;
  previewFocusMode?: boolean;
  onTogglePreviewFocus?: () => void;
}) {
  const results = useMemo(() => [selected], [selected]);
  const controller = usePreviewController({ selected, results, selectedIndex: 0, selectedMatchTerms: NO_TERMS,
    showPreviewPane: true, showOperationStatus: onStatus });
  useEffect(() => {
    const navigate = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !event.altKey || event.ctrlKey || event.metaKey
        || !["ArrowLeft", "ArrowRight"].includes(event.key) || document.querySelector("dialog[open]")) return;
      event.preventDefault(); event.stopImmediatePropagation();
      onNavigate(event.key === "ArrowLeft" ? -1 : 1);
    };
    window.addEventListener("keydown", navigate, true);
    return () => window.removeEventListener("keydown", navigate, true);
  }, [onNavigate]);
  return <PreviewPane {...controller} className="task-preview-pane" label="任务详情" selected={selected}
    previewMarkdown={controller.preview} spaces={libraries} selectedMatchTerms={NO_TERMS}
    canGoBack={canGoBack} canGoForward={canGoForward} previewPinned={previewPinned}
    onNavigatePreviewHistory={onNavigate} onTogglePreviewPinned={onTogglePinned}
    copiedResultId={copiedResultId} copySelectedLink={onCopyLink} openSelectedResult={onOpenSource}
    onOpenLink={onOpenLink} providerName={providerName} startWindowDrag={NO_DRAG}
    onClose={onClose} onCloseMobilePreview={onClose} toolbarActions={toolbarActions} moreMenuItems={moreMenuItems}
    isFavorite={isFavorite} snippetFavoriteIds={snippetFavoriteIds}
    onToggleFavorite={onToggleFavorite} onToggleSnippetFavorite={onToggleSnippetFavorite}
    previewFocusMode={previewFocusMode} onTogglePreviewFocus={onTogglePreviewFocus}
    onNotify={(message, tone) => onStatus(message, tone ?? "success", tone === "error" ? 6000 : 2500)} contentBefore={<><TaskAnswerOrigin provider={selected.provider||""} libraryId={selected.libraryId||selected.spaceId} objectId={selected.documentId}/>{contentBefore}</>}
    renderedPreviewMarkdown={controller.preview ? <Suspense fallback={<div className="preview-lazy-loading">正在准备预览…</div>}>
      <Renderer selected={selected} markdown={controller.preview} matchTerms={NO_TERMS} hasSectionContext={false} onOpenLink={onOpenLink}/>
    </Suspense> : null}/>
}
