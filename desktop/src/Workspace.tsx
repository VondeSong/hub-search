import type {
  ComponentProps,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  RefObject,
  ReactNode,
} from "react";
import { PreviewPane } from "./PreviewPane";
import { SearchResultsPane } from "./SearchResultsPane";
import { useState } from "react";

type SearchResultsPaneProps = ComponentProps<typeof SearchResultsPane>;
type PreviewPaneProps = ComponentProps<typeof PreviewPane>;

export type WorkspaceProps = {
  searchHeader?: ReactNode;
  resultsContent?: ReactNode;
  workspaceRef: RefObject<HTMLElement | null>;
  showPreviewPane: boolean;
  resultsPanePercent: number;
  resultsPaneProps: SearchResultsPaneProps;
  previewPaneProps: PreviewPaneProps;
  onResizePreviewPanes: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onResetPreviewSplit: () => void;
};

type WorkspaceContentProps = WorkspaceProps & {
  layout: "desktop" | "mobile";
};

function WorkspaceContent({
  workspaceRef,
  showPreviewPane,
  resultsPanePercent,
  resultsPaneProps,
  previewPaneProps,
  onResizePreviewPanes,
  onResetPreviewSplit,
  layout,
  searchHeader,
  resultsContent,
}: WorkspaceContentProps) {
  const context = `${resultsPaneProps.collectionView}:${resultsPaneProps.selectedCollectionTag?.normalizedName}:${resultsPaneProps.tagOverviewMode}:${resultsPaneProps.query}`;
  const [view, setView] = useState({ context, management: false, evidence: false });
  const current = view.context === context ? view : { context, management: false, evidence: false };
  const previewVisible = showPreviewPane && (Boolean(resultsContent) || current.evidence || !current.management);
  return (
    <section
      ref={workspaceRef}
      className={`workspace ${layout}-workspace ${resultsContent ? "library-browse-workspace" : ""} ${previewVisible ? "with-preview" : ""}`}
      style={{ "--results-pane-percent": `${resultsPanePercent}%` } as CSSProperties}
    >
      {resultsContent ?? (searchHeader ? <div className="search-results-column">
        {searchHeader}
        <SearchResultsPane {...resultsPaneProps}
          onTagTabChange={management => setView({ context, management, evidence: false })}
          onPreviewEvidence={result => { setView({ ...current, context, evidence: true }); (resultsPaneProps.onPreviewEvidence ?? resultsPaneProps.onOpenResult)(result); }} />
      </div> : <SearchResultsPane {...resultsPaneProps}
        onTagTabChange={management => setView({ context, management, evidence: false })}
        onPreviewEvidence={result => { setView({ ...current, context, evidence: true }); (resultsPaneProps.onPreviewEvidence ?? resultsPaneProps.onOpenResult)(result); }} />)}

      {previewVisible && <div
        className="pane-resizer"
        role="separator"
        aria-label="调整搜索结果和预览的宽度"
        aria-orientation="vertical"
        aria-valuemin={25}
        aria-valuemax={75}
        aria-valuenow={Math.round(resultsPanePercent)}
        title="拖动调整宽度，双击恢复默认"
        onPointerDown={onResizePreviewPanes}
        onDoubleClick={onResetPreviewSplit}
      />}

      {previewVisible && <PreviewPane {...previewPaneProps} />}
    </section>
  );
}

export function DesktopWorkspace(props: WorkspaceProps) {
  return <WorkspaceContent {...props} layout="desktop" />;
}

export function MobileWorkspace(props: WorkspaceProps) {
  return <WorkspaceContent {...props} layout="mobile" />;
}
