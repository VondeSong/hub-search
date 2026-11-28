import { AgentCitationPreview, type CitationLocation } from "./AgentCitationPreview";
import { PreviewFrame, PreviewHeading, PreviewTitle, PreviewToolbar } from "./PreviewFrame";
import { canOpenResultSource } from "./ResultOpening";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LoaderCircle,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  Pin,
  PinOff,
  Star,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useLayoutEffect, useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { snippetFavoriteKey } from "./PageFavorites";
import { PreviewSelectionActions, type SelectionNotifyTone, type SelectionSnippetOutcome } from "./PreviewSelectionActions";
import { PreviewTocPopover } from "./PreviewTocPopover";
import { userProfileStorage } from "./UserProfileStorage";
import { SharedTaskPreviewStatus } from "./SharedTaskPreviewStatus";
import { isTaskPreviewResult } from "./TaskResultIdentity";
import type { SearchProvider } from "./ProviderLabels";
import { MobileReaderFontButton } from "./MobileAppearance";
import { runtimeCapabilities } from "./RuntimePlatform";
import { PreviewThemePicker, usePreviewTheme } from "./PreviewTheme";
import { PdfPreviewPanel } from "./PdfPreviewPanel";
import { isPdfContent } from "./PdfPreviewModel";
import { HighlightedText } from "./SearchPresentation";
import { resultDisplayTitle, resultSectionLabel } from "./SearchResultPresentation";
import type {
  LibrarySummary,
  OcrImagePreview,
  PdfPagePreview,
  SearchResult,
} from "./SearchTypes";

const LazyPreviewTaskTitle = lazy(() => import("./PreviewTaskTitle"));
const LazyAgentInvestigation = lazy(() => import("./AgentInvestigation").then(module => ({ default: module.AgentInvestigation })));
const PREVIEW_WIDE_TEXT_KEY = "hub.preview.wide-text.v1";

function loadPreviewWideText(): boolean {
  try {
    return userProfileStorage.getItem(PREVIEW_WIDE_TEXT_KEY) === "true";
  } catch {
    return false;
  }
}

export type PreviewPaneProps = {
  className?: string;
  label?: string;
  onClose?: () => void;
  toolbarActions?: ReactNode;
  moreMenuItems?: ReactNode;
  contentBefore?: ReactNode;
  selected?: SearchResult;
  canGoBack: boolean;
  canGoForward: boolean;
  previewPinned: boolean;
  onNavigatePreviewHistory: (direction: -1 | 1) => void;
  onTogglePreviewPinned?: () => void;
  selectedMatchTerms: string[];
  selectedSectionTitle?: string;
  previewMatchCount: number;
  previewMatchIndex: number;
  copiedResultId: string;
  spaces: LibrarySummary[];
  pdfPreview: PdfPagePreview | null;
  pdfPreviewPage?: number;
  pdfQuery?: string;
  ocrImagePreview: OcrImagePreview | null;
  previewLoading: boolean;
  previewMarkdown?: string | null;
  mobileDock?: ReactNode;
  renderedPreviewMarkdown: ReactNode;
  onOpenLink: (href?: string) => void;
  previewCard: RefObject<HTMLElement | null>;
  startWindowDrag: (event: ReactMouseEvent<HTMLElement>) => void;
  onCloseMobilePreview: () => void;
  setPdfPreviewPage: Dispatch<SetStateAction<number>>;
  navigatePreviewMatch: (direction: number) => void;
  copySelectedLink: () => void | Promise<void>;
  openSelectedResult: (result?: SearchResult, source?: "result" | "preview") => void;
  providerName: (provider: SearchProvider) => string;
  journalDate?: string;
  canNavigateJournalOlder?: boolean;
  canNavigateJournalNewer?: boolean;
  onNavigateJournalDate?: (direction: -1 | 1) => void;
  isFavorite?: boolean;
  snippetFavoriteIds?: ReadonlySet<string>;
  onToggleFavorite?: (result: SearchResult) => SelectionSnippetOutcome;
  onToggleSnippetFavorite?: (result: SearchResult) => SelectionSnippetOutcome;
  previewFocusMode?: boolean;
  onTogglePreviewFocus?: () => void;
  onNotify?: (message: string, tone?: SelectionNotifyTone) => void;
};

export const PreviewPane = memo(function PreviewPane({
  className,
  label,
  onClose,
  toolbarActions,
  moreMenuItems,
  contentBefore,
  selected,
  canGoBack,
  canGoForward,
  previewPinned,
  onNavigatePreviewHistory,
  onTogglePreviewPinned,
  selectedMatchTerms,
  selectedSectionTitle,
  previewMatchCount,
  previewMatchIndex,
  copiedResultId,
  spaces,
  pdfPreview,
  pdfPreviewPage,
  pdfQuery = "",
  ocrImagePreview,
  previewLoading,
  previewMarkdown,
  renderedPreviewMarkdown,
  mobileDock,
  onOpenLink,
  previewCard,
  startWindowDrag,
  onCloseMobilePreview,
  setPdfPreviewPage,
  navigatePreviewMatch,
  copySelectedLink,
  openSelectedResult,
  providerName,
  journalDate,
  canNavigateJournalOlder,
  canNavigateJournalNewer,
  onNavigateJournalDate,
  isFavorite = false,
  snippetFavoriteIds,
  onToggleFavorite,
  onToggleSnippetFavorite,
  previewFocusMode = false,
  onTogglePreviewFocus,
  onNotify,
}: PreviewPaneProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const previewTheme = usePreviewTheme(contentRef);
  const [wideText, setWideText] = useState<boolean>(loadPreviewWideText);
  const toggleWideText = useCallback(() => {
    setWideText((current) => {
      const next = !current;
      try {
        userProfileStorage.setItem(PREVIEW_WIDE_TEXT_KEY, String(next));
      } catch {
        // Ignore storage unavailability so reading still works.
      }
      return next;
    });
  }, []);
  const [citation, setCitation] = useState<CitationLocation | null>(null);
  const previousScroll = useRef<number | null>(null);
  const showCitation = useCallback((value: CitationLocation | null) => {
    if (value && previousScroll.current === null) previousScroll.current = contentRef.current?.scrollTop ?? 0;
    setCitation(value);
  }, []);
  useLayoutEffect(() => {
    if (!citation && previousScroll.current !== null) {
      if (contentRef.current) contentRef.current.scrollTop = previousScroll.current;
      previousScroll.current = null;
    }
  }, [citation]);
  useEffect(() => { setCitation(null); }, [selected?.id, previewMarkdown]);
  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const content = contentRef.current;
    setShowScrollTop(Boolean(content && content.scrollTop > content.clientHeight / 2 && content.scrollHeight > content.clientHeight));
  }, [selected?.id, previewMarkdown, previewLoading]);
  const didaStatus = selected?.provider === "dida365"
    ? previewMarkdown?.match(/^\*\*状态[：:]\*\*\s*(已完成|已放弃|未完成)/m)?.[1]
      ?? (selected.taskStatus === 2 ? "已完成" : selected.taskStatus === -1 ? "已放弃" : "未完成")
    : undefined;
  const didaTitle = selected?.documentTitle?.trim() || selected?.title || "";
  const taskPreview = isTaskPreviewResult(selected);
  const themedDocument = runtimeCapabilities.platform !== "android" && !isPdfContent(selected?.contentType) && !pdfPreview && !ocrImagePreview && !taskPreview && !!renderedPreviewMarkdown;
  const canOpenSource = canOpenResultSource(selected, spaces, runtimeCapabilities.platform);
  const supportsFavorites = Boolean(selected && selected.provider !== "hub");
  const showMoreMenu = Boolean(journalDate || moreMenuItems || (runtimeCapabilities.platform !== "android" && onTogglePreviewFocus));
  return (
    <PreviewFrame className={`${className || ""}${citation ? " preview-citation-active" : ""}${themedDocument && previewTheme.theme === "craft" ? " preview-theme-craft" : ""}${runtimeCapabilities.platform !== "android" && wideText ? " preview-wide-text" : ""}`} label={label} cardRef={previewCard} empty={!selected ? <div className="preview-placeholder">选择一个结果以预览完整页面</div> : undefined} onMouseDown={(event) => {
      if (event.target === event.currentTarget) startWindowDrag(event);
    }}>
      {selected && (
        <>
            <PreviewHeading provider={selected.provider} source={<>
                  <span className={`provider-badge ${selected.provider}`}>{providerName(selected.provider)}</span>
                  <span className="preview-path">{selected.spaceName} / {selected.path}{selected.sourceTitle && <span> / {selected.sourceTitle}</span>}{(isPdfContent(selected.contentType)?pdfPreviewPage??pdfPreview?.pageNumber??selected.pageNumber:selected.pageNumber) && <span> / 第 {isPdfContent(selected.contentType)?pdfPreviewPage??pdfPreview?.pageNumber??selected.pageNumber:selected.pageNumber} 页</span>}</span>
            </>} actions={<PreviewToolbar
              copied={copiedResultId === selected.id} onCopy={copySelectedLink}
              copyTitle={isPdfContent(selected.contentType)?"复制本机 PDF 当前页链接":selected.provider==="hub"?"复制内容":undefined}
              onClose={onClose}
              openTitle={selected.provider==="hub"?`在${selected.contentType==="reading"?"阅读":"闪卡"}中打开`:runtimeCapabilities.platform === "android" && selected.provider === "craft" ? "在浏览器中打开 Craft" : `在 ${providerName(selected.provider)} 中打开`}
              openDisabled={!canOpenSource} onOpen={() => openSelectedResult(selected, "preview")}
            >
                  <button className="mobile-preview-back" title="返回结果列表" onClick={onCloseMobilePreview}><ChevronLeft size={20} /><span>返回</span></button>
                  {runtimeCapabilities.mobile && mobileDock && <span className="mobile-reader-location"><strong>{selected.libraryName || selected.spaceName}</strong><small title={selected.path}>{selected.path}</small></span>}
                  {runtimeCapabilities.mobile && mobileDock && <MobileReaderFontButton/>}
                  {previewMatchCount > 0 && <>
                    <span className="match-counter" aria-label={`第 ${previewMatchIndex + 1} 个命中，共 ${previewMatchCount} 个`}>{previewMatchIndex + 1}/{previewMatchCount}</span>
                    <button title="上一个命中" aria-label="上一个命中" onClick={() => navigatePreviewMatch(-1)}><ChevronUp size={16} /></button>
                    <button title="下一个命中" aria-label="下一个命中" onClick={() => navigatePreviewMatch(1)}><ChevronDown size={16} /></button>
                  </>}
                  <button title="上一个预览（Alt+←）" aria-label="上一个预览" disabled={!canGoBack} onClick={() => onNavigatePreviewHistory(-1)}><ArrowLeft size={16} /></button>
                  <button title="下一个预览（Alt+→）" aria-label="下一个预览" disabled={!canGoForward} onClick={() => onNavigatePreviewHistory(1)}><ArrowRight size={16} /></button>
                  {onTogglePreviewPinned && <button className={`preview-pin ${previewPinned ? "active" : ""}`} title={previewPinned ? "解除固定预览" : "固定预览"} aria-label={previewPinned ? "解除固定预览" : "固定预览"} aria-pressed={previewPinned} onClick={onTogglePreviewPinned}>{previewPinned ? <PinOff size={16} /> : <Pin size={16} />}</button>}
                  {runtimeCapabilities.platform !== "android" && !citation && !isPdfContent(selected.contentType) && (
                    <PreviewTocPopover contentRef={contentRef} contentKey={`${selected.id}:${previewMarkdown?.length ?? 0}`} />
                  )}
                  {runtimeCapabilities.platform !== "android" && onTogglePreviewFocus && (
                    <button
                      type="button"
                      className={`preview-focus-btn${previewFocusMode ? " active" : ""}`}
                      title={previewFocusMode ? "退出专注阅读（Esc）" : "全宽专注阅读"}
                      aria-label={previewFocusMode ? "退出专注阅读" : "全宽专注阅读"}
                      aria-pressed={previewFocusMode}
                      onClick={onTogglePreviewFocus}
                    >
                      {previewFocusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                    </button>
                  )}
                  {supportsFavorites && onToggleFavorite && (
                    <button
                      type="button"
                      className={`preview-favorite-btn${isFavorite ? " active" : ""}`}
                      title={isFavorite ? "取消收藏本页" : "收藏本页"}
                      aria-label={isFavorite ? "取消收藏本页" : "收藏本页"}
                      aria-pressed={isFavorite}
                      onClick={() => {
                        try {
                          onToggleFavorite(selected);
                        } catch (reason) {
                          const detail = reason instanceof Error ? reason.message : String(reason);
                          onNotify?.(`收藏操作失败：${detail}`, "error");
                        }
                      }}
                    >
                      <Star size={15} fill={isFavorite ? "currentColor" : "none"} />
                    </button>
                  )}
                  {toolbarActions}
                  {runtimeCapabilities.desktop && selected.provider !== "hub" && <Suspense fallback={null}><LazyAgentInvestigation result={selected} compact onPreviewCitation={showCitation} /></Suspense>}
                  {showMoreMenu && <details className="preview-more-menu" onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      event.currentTarget.open = false;
                      event.currentTarget.querySelector("summary")?.focus();
                    }
                  }}>
                    <summary title="更多预览操作" aria-label="更多预览操作"><MoreHorizontal size={18} /></summary>
                    <div>
                      {journalDate && <>
                        <button disabled={!canNavigateJournalOlder} onClick={() => onNavigateJournalDate?.(1)}><ChevronLeft size={16} /><span>较早的日志</span></button>
                        <button disabled={!canNavigateJournalNewer} onClick={() => onNavigateJournalDate?.(-1)}><ChevronRight size={16} /><span>较新的日志</span><small>{journalDate}</small></button>
                      </>}
                      {moreMenuItems}
                      {runtimeCapabilities.platform !== "android" && onTogglePreviewFocus && (
                        <button type="button" aria-pressed={wideText} onClick={toggleWideText}>
                          {wideText ? <Check size={14} /> : null}
                          <span>宽松行宽</span>
                        </button>
                      )}
                    </div>
                  </details>}
            </PreviewToolbar>}>
              <PreviewTitle agentSource={{result:selected}} key={selected.id} text={resultDisplayTitle(selected)} className={taskPreview ? "preview-dida-heading" : undefined}>
                {taskPreview && <SharedTaskPreviewStatus result={selected} fallbackStatus={didaStatus}/>}
                {selected.provider === "dida365" && /\[[^\]]+\]\([^)]+\)/.test(didaTitle)
                  ? <Suspense fallback={<HighlightedText text={resultDisplayTitle(selected)} terms={selectedMatchTerms} navigable />}>
                    <LazyPreviewTaskTitle markdown={didaTitle} terms={selectedMatchTerms} onOpenLink={onOpenLink} />
                  </Suspense>
                  : <HighlightedText text={resultDisplayTitle(selected)} terms={selectedMatchTerms} navigable />}
              </PreviewTitle>
              {selectedSectionTitle && (
                <div className="preview-section-title">
                  <span>{resultSectionLabel(selected)}</span>
                  <HighlightedText text={selectedSectionTitle} terms={selectedMatchTerms} navigable />
                </div>
              )}
            </PreviewHeading>
            {themedDocument && !citation && <PreviewThemePicker {...previewTheme} sourceLayout={selected.provider === "craft"} />}
            <div className="preview-content" ref={contentRef} onScroll={(event) => {
              const content = event.currentTarget;
              setShowScrollTop(content.scrollTop > content.clientHeight / 2 && content.scrollHeight > content.clientHeight);
            }}>
              {citation && <AgentCitationPreview value={{...citation,onReturn:()=>{showCitation(null);citation.onReturn();}}}/> }
              <div hidden={!!citation}>
              {contentBefore}
              {isPdfContent(selected.contentType) ? <PdfPreviewPanel key={selected.sourceItemId ?? selected.id} selected={selected} query={pdfQuery} page={pdfPreviewPage ?? pdfPreview?.pageNumber ?? selected.pageNumber ?? 1} preview={pdfPreview} loading={previewLoading} error={previewMarkdown} terms={selectedMatchTerms} onPageChange={setPdfPreviewPage}/> : previewLoading ? (
                <div className="preview-loading"><LoaderCircle className="spin" />正在加载预览…</div>
              ) : ocrImagePreview ? (
                <div className="ocr-image-preview">
                  {ocrImagePreview.imageDataUrl && <img src={ocrImagePreview.imageDataUrl} alt={selected.title} />}
                  {ocrImagePreview.note && <p className="preview-note">{ocrImagePreview.note}</p>}
                  <h2>识别文字</h2>
                  <div className="ocr-text"><HighlightedText text={ocrImagePreview.ocrText} terms={selectedMatchTerms} navigable /></div>
                </div>
              ) : renderedPreviewMarkdown ?? (
                <div className="preview-unavailable"><strong>暂无本地预览</strong><p>可在来源应用中查看完整内容。</p><button disabled={!canOpenSource} onClick={() => openSelectedResult(selected, "preview")}>在 {providerName(selected.provider)} 中打开 <ArrowUpRight size={15} /></button></div>
              )}
              </div>
            </div>
            {!citation && !isPdfContent(selected.contentType) && previewMatchCount > 0 && <nav className="mobile-preview-navigation" aria-label="搜索命中导航">
                <button type="button" onClick={() => navigatePreviewMatch(-1)}><ChevronUp size={18} />上一处</button>
                <span>{Math.max(0, previewMatchIndex + 1)} / {previewMatchCount}</span>
                <button type="button" onClick={() => navigatePreviewMatch(1)}>下一处<ChevronDown size={18} /></button>
            </nav>}
            {!citation && showScrollTop && <button type="button" className="preview-scroll-top" aria-label="回到预览顶部" title="回到顶部" onClick={() => {
              const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
              contentRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
            }}><ArrowUp size={18} aria-hidden="true" /></button>}
            {runtimeCapabilities.mobile && !previewLoading && !citation && mobileDock}
            <PreviewSelectionActions
              scrollRef={contentRef}
              contentKey={selected.id}
              title={resultDisplayTitle(selected)}
              agentEntry={selected.provider !== "hub" ? { result: selected } : null}
              isSnippetSaved={supportsFavorites && snippetFavoriteIds ? (text) => snippetFavoriteIds.has(snippetFavoriteKey({ ...selected, favoriteKind: "snippet", snippet: text })) : undefined}
              onSaveSnippet={supportsFavorites && onToggleSnippetFavorite ? (text) => onToggleSnippetFavorite({ ...selected, favoriteKind: "snippet", snippet: text }) : undefined}
              onNotify={onNotify}
              enabled={!citation && !isPdfContent(selected.contentType) && !previewLoading}
            />
        </>
      )}
    </PreviewFrame>
  );
});
