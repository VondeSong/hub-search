import { AgentCitationPreview, type CitationLocation } from "./AgentCitationPreview";
import { PreviewFrame, PreviewHeading, PreviewTitle, PreviewToolbar } from "./PreviewFrame";
import { canOpenResultSource } from "./ResultOpening";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  PinOff,
} from "lucide-react";
import { lazy, memo, Suspense, useCallback, useLayoutEffect, useEffect, useRef, useState, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type SetStateAction } from "react";
import { SharedTaskPreviewStatus } from "./SharedTaskPreviewStatus";
import { isTaskPreviewResult } from "./TaskResultIdentity";
import type { Provider } from "./ProviderLabels";
import { runtimeCapabilities } from "./RuntimePlatform";
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

export type PreviewPaneProps = {
  className?: string;
  label?: string;
  onClose?: () => void;
  toolbarActions?: ReactNode;
  contentBefore?: ReactNode;
  selected?: SearchResult;
  canGoBack: boolean;
  canGoForward: boolean;
  previewPinned: boolean;
  onNavigatePreviewHistory: (direction: -1 | 1) => void;
  onTogglePreviewPinned: () => void;
  selectedMatchTerms: string[];
  selectedSectionTitle?: string;
  previewMatchCount: number;
  previewMatchIndex: number;
  copiedResultId: string;
  spaces: LibrarySummary[];
  pdfPreview: PdfPagePreview | null;
  ocrImagePreview: OcrImagePreview | null;
  previewLoading: boolean;
  previewMarkdown?: string | null;
  renderedPreviewMarkdown: ReactNode;
  onOpenLink: (href?: string) => void;
  previewCard: RefObject<HTMLElement | null>;
  startWindowDrag: (event: ReactMouseEvent<HTMLElement>) => void;
  onCloseMobilePreview: () => void;
  setPdfPreviewPage: Dispatch<SetStateAction<number>>;
  navigatePreviewMatch: (direction: number) => void;
  copySelectedLink: () => void | Promise<void>;
  openSelectedResult: (result?: SearchResult, source?: "result" | "preview") => void;
  providerName: (provider: Provider) => string;
  journalDate?: string;
  canNavigateJournalOlder?: boolean;
  canNavigateJournalNewer?: boolean;
  onNavigateJournalDate?: (direction: -1 | 1) => void;
};

export const PreviewPane = memo(function PreviewPane({
  className,
  label,
  onClose,
  toolbarActions,
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
  ocrImagePreview,
  previewLoading,
  previewMarkdown,
  renderedPreviewMarkdown,
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
}: PreviewPaneProps) {
  const contentRef = useRef<HTMLDivElement>(null);
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
  const canOpenSource = canOpenResultSource(selected, spaces, runtimeCapabilities.platform);
  return (
    <PreviewFrame className={`${className || ""}${citation ? " preview-citation-active" : ""}`} label={label} cardRef={previewCard} empty={!selected ? <div className="preview-placeholder">选择一个结果以预览完整页面</div> : undefined} onMouseDown={(event) => {
      if (event.target === event.currentTarget) startWindowDrag(event);
    }}>
      {selected && (
        <>
            <PreviewHeading provider={selected.provider} source={<>
                  <span className={`provider-badge ${selected.provider}`}>{providerName(selected.provider)}</span>
                  <span className="preview-path">{selected.spaceName} / {selected.path}{selected.sourceTitle && <span> / {selected.sourceTitle}</span>}{selected.pageNumber && <span> / 第 {selected.pageNumber} 页</span>}</span>
            </>} actions={<PreviewToolbar
              copied={copiedResultId === selected.id} onCopy={copySelectedLink}
              onClose={onClose}
              openTitle={runtimeCapabilities.platform === "android" && selected.provider === "craft" ? "在浏览器中打开 Craft" : `在 ${providerName(selected.provider)} 中打开`}
              openDisabled={!canOpenSource} onOpen={() => openSelectedResult(selected, "preview")}
            >
                  <button className="mobile-preview-back" title="返回结果列表" onClick={onCloseMobilePreview}><ChevronLeft size={20} /><span>返回</span></button>
                  {previewMatchCount > 0 && <>
                    <span className="match-counter" aria-label={`第 ${previewMatchIndex + 1} 个命中，共 ${previewMatchCount} 个`}>{previewMatchIndex + 1}/{previewMatchCount}</span>
                    <button title="上一个命中" aria-label="上一个命中" onClick={() => navigatePreviewMatch(-1)}><ChevronUp size={16} /></button>
                    <button title="下一个命中" aria-label="下一个命中" onClick={() => navigatePreviewMatch(1)}><ChevronDown size={16} /></button>
                  </>}
                  <button title="上一个预览（Alt+←）" aria-label="上一个预览" disabled={!canGoBack} onClick={() => onNavigatePreviewHistory(-1)}><ArrowLeft size={16} /></button>
                  <button title="下一个预览（Alt+→）" aria-label="下一个预览" disabled={!canGoForward} onClick={() => onNavigatePreviewHistory(1)}><ArrowRight size={16} /></button>
                  <button className={`preview-pin ${previewPinned ? "active" : ""}`} title={previewPinned ? "解除固定预览" : "固定预览"} aria-label={previewPinned ? "解除固定预览" : "固定预览"} aria-pressed={previewPinned} onClick={onTogglePreviewPinned}>{previewPinned ? <PinOff size={16} /> : <Pin size={16} />}</button>
                  {toolbarActions}
                  {runtimeCapabilities.desktop && <Suspense fallback={null}><LazyAgentInvestigation result={selected} compact onPreviewCitation={showCitation} /></Suspense>}
                  {(journalDate || pdfPreview) && <details className="preview-more-menu" onKeyDown={(event) => {
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
                      {pdfPreview && <>
                        <button disabled={pdfPreview.pageNumber <= 1} onClick={() => setPdfPreviewPage((page) => Math.max(1, page - 1))}><ChevronLeft size={16} /><span>上一页</span></button>
                        <button disabled={pdfPreview.pageNumber >= pdfPreview.pageCount} onClick={() => setPdfPreviewPage((page) => Math.min(pdfPreview.pageCount, page + 1))}><ChevronRight size={16} /><span>下一页</span><small>{pdfPreview.pageNumber}/{pdfPreview.pageCount}</small></button>
                      </>}
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
            <div className="preview-content" ref={contentRef} onScroll={(event) => {
              const content = event.currentTarget;
              setShowScrollTop(content.scrollTop > content.clientHeight / 2 && content.scrollHeight > content.clientHeight);
            }}>
              {citation && <AgentCitationPreview value={{...citation,onReturn:()=>{showCitation(null);citation.onReturn();}}}/> }
              <div hidden={!!citation}>
              {contentBefore}
              {previewLoading ? (
                <div className="preview-loading"><LoaderCircle className="spin" />正在加载预览…</div>
              ) : ocrImagePreview ? (
                <div className="ocr-image-preview">
                  {ocrImagePreview.imageDataUrl && <img src={ocrImagePreview.imageDataUrl} alt={selected.title} />}
                  {ocrImagePreview.note && <p className="preview-note">{ocrImagePreview.note}</p>}
                  <h2>识别文字</h2>
                  <div className="ocr-text"><HighlightedText text={ocrImagePreview.ocrText} terms={selectedMatchTerms} navigable /></div>
                </div>
              ) : pdfPreview ? (
                <div className="pdf-page-preview">
                  {pdfPreview.imageDataUrl && <img src={pdfPreview.imageDataUrl} alt={`${selected.sourceTitle ?? selected.title} 第 ${pdfPreview.pageNumber} 页`} />}
                  {pdfPreview.note && <p className="preview-note">{pdfPreview.note}</p>}
                  <h2>{pdfPreview.sourceType === "pdf_ocr" ? "OCR 识别文字" : "PDF 原生文字"}</h2>
                  <div className="ocr-text"><HighlightedText text={pdfPreview.text || "本页没有提取到文字。"} terms={selectedMatchTerms} navigable /></div>
                </div>
              ) : renderedPreviewMarkdown ?? (
                <div className="preview-unavailable"><strong>暂无本地预览</strong><p>可在来源应用中查看完整内容。</p><button disabled={!canOpenSource} onClick={() => openSelectedResult(selected, "preview")}>在 {providerName(selected.provider)} 中打开 <ArrowUpRight size={15} /></button></div>
              )}
              </div>
            </div>
            {!citation && (pdfPreview || previewMatchCount > 0) && <nav className="mobile-preview-navigation" aria-label={pdfPreview ? "PDF 翻页" : "搜索命中导航"}>
              {pdfPreview ? <>
                <button type="button" disabled={pdfPreview.pageNumber <= 1} onClick={() => setPdfPreviewPage((page) => Math.max(1, page - 1))}><ChevronLeft size={18} />上一页</button>
                <span>第 {pdfPreview.pageNumber} / {pdfPreview.pageCount} 页</span>
                <button type="button" disabled={pdfPreview.pageNumber >= pdfPreview.pageCount} onClick={() => setPdfPreviewPage((page) => Math.min(pdfPreview.pageCount, page + 1))}>下一页<ChevronRight size={18} /></button>
              </> : <>
                <button type="button" onClick={() => navigatePreviewMatch(-1)}><ChevronUp size={18} />上一处</button>
                <span>{Math.max(0, previewMatchIndex + 1)} / {previewMatchCount}</span>
                <button type="button" onClick={() => navigatePreviewMatch(1)}>下一处<ChevronDown size={18} /></button>
              </>}
            </nav>}
            {!citation && showScrollTop && <button type="button" className="preview-scroll-top" aria-label="回到预览顶部" title="回到顶部" onClick={() => {
              const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
              contentRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
            }}><ArrowUp size={18} aria-hidden="true" /></button>}
        </>
      )}
    </PreviewFrame>
  );
});
