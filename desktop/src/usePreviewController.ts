import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { providerName } from "./ProviderLabels";
import type { OcrImagePreview, PdfPagePreview, SearchResult } from "./SearchTypes";
import type { OperationTone } from "./useOperationStatus";
import { PreviewDocumentCache } from "./PreviewDocumentCache";
import { cleanSearchSnippet } from "./ResultExcerpt";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { findTaskForResult, isTaskPreviewResult } from "./TaskResultIdentity";
import { isWindowVisible, useDocumentVisible } from "./WindowVisibility";
import { PdfPreviewRequests } from "./PdfPreviewRequests";
import { isPdfContent } from "./PdfPreviewModel";

export function previewDocumentKey(result: SearchResult): string {
  const taskStatus = result.provider === "dida365" ? `\u0000${result.taskStatus ?? "unknown"}` : "";
  return `${result.spaceId}\u0000${result.documentId}\u0000${result.entityKey || result.blockId || result.documentId}\u0000${result.modifiedAt ?? 0}${taskStatus}`;
}

export function mcpToolText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const value = result as Record<string, unknown>;
  const content = Array.isArray(value.content) ? value.content : [];
  return content
    .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).text : "")
    .filter((text): text is string => typeof text === "string" && Boolean(text))
    .join("\n");
}

function requestLocalPreviewDocument(result: SearchResult): Promise<string> {
  if (result.provider === "hub" && (result.contentType === "reading" || result.contentType === "flashcard")) {
    return invoke<string>("module_search_document", { kind: result.contentType, id: result.documentId });
  }
  return invoke<string>("local_document", {
    spaceId: result.spaceId,
    documentId: result.documentId,
    pageId: result.provider === "craft" ? result.blockId ?? result.documentId : undefined,
    resultId: result.id,
  });
}

async function requestCraftPreviewDocument(result: SearchResult): Promise<string> {
  const fallback = await invoke<unknown>("craft_read", {
    spaceId: result.spaceId,
    command: `blocks get ${result.blockId} --depth -1 --format markdown`,
  });
  return mcpToolText(fallback);
}

export async function writeClipboardText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("系统剪贴板不可用");
}

type UsePreviewControllerOptions = {
  selected?: SearchResult;
  results: SearchResult[];
  selectedIndex: number;
  selectedMatchTerms: string[];
  showPreviewPane: boolean;
  showOperationStatus: (text: string, tone?: OperationTone, duration?: number) => void;
};

export function usePreviewController({
  selected,
  results,
  selectedIndex,
  selectedMatchTerms,
  showPreviewPane,
  showOperationStatus,
}: UsePreviewControllerOptions) {
  const [preview, setPreview] = useState("");
  const [ocrImagePreview, setOcrImagePreview] = useState<OcrImagePreview | null>(null);
  const [pdfPreview, setPdfPreview] = useState<PdfPagePreview | null>(null);
  const [pdfRequests] = useState(() => new PdfPreviewRequests<PdfPagePreview>());
  const pageKey=JSON.stringify([selected?.id,selected?.pageNumber??1]);
  const [pdfPageState,setPdfPageState]=useState({key:pageKey,page:selected?.pageNumber??1});
  const pdfPreviewPage=pdfPageState.key===pageKey?pdfPageState.page:selected?.pageNumber??1;
  const setPdfPreviewPage=useCallback((change:number|((page:number)=>number))=>{
    setPdfPageState(previous=>{const current=previous.key===pageKey?previous.page:selected?.pageNumber??1;return {key:pageKey,page:typeof change==="function"?change(current):change};});
  },[pageKey,selected?.pageNumber]);
  const identity=selected?JSON.stringify([selected.spaceId,selected.documentId,selected.blockId??null,selected.sourceItemId??null,selected.contentType,pdfPreviewPage,selected.modifiedAt??0]):"";

  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewMatchCount, setPreviewMatchCount] = useState(0);
  const [previewMatchIndex, setPreviewMatchIndex] = useState(0);
  const [copiedResultId, setCopiedResultId] = useState("");
  const previewCard = useRef<HTMLElement>(null);
  const previewDocumentCache = useRef(new PreviewDocumentCache(24));
  const pendingPreviewDirection = useRef<number | null>(null);
  const visible = useDocumentVisible();
  const sharedTasks = useUnifiedTasks({ enabled: showPreviewPane && isTaskPreviewResult(selected) });
  const sourceTask = findTaskForResult(sharedTasks.dashboard.tasks, selected);
  const taskVersion = sourceTask ? `${sourceTask.status}:${sourceTask.modifiedAt ?? 0}:${sourceTask.statusMutation?.operationId ?? 0}:${sourceTask.statusMutation?.state ?? ""}` : "";
  const shownDocument = useRef("");

  const navigatePreviewMatch = useCallback((direction: number) => {
    const marks = Array.from(previewCard.current?.querySelectorAll<HTMLElement>(
      ".preview-heading mark[data-search-hit='true'], .preview-content mark[data-search-hit='true']",
    ) ?? []);
    if (!marks.length) return;
    const next = (previewMatchIndex + direction + marks.length) % marks.length;
    marks.forEach((mark, index) => mark.classList.toggle("active-match", index === next));
    marks[next].scrollIntoView({ block: "center", behavior: "smooth" });
    setPreviewMatchIndex(next);
    showOperationStatus(`已跳转到预览命中 ${next + 1}/${marks.length}`, "success", 1_800);
  }, [previewMatchIndex, showOperationStatus]);

  const copySelectedLink = useCallback(async () => {
    if (!selected) return;
    try {
      const pdf=isPdfContent(selected.contentType);
      const link = pdf?await invoke<string>("local_pdf_page_link",{resultId:selected.id,pageNumber:pdfPreviewPage}):selected.provider==="hub"?await requestLocalPreviewDocument(selected):await invoke<string>("result_link", {
        libraryId: selected.libraryId,
        documentId: selected.documentId,
        blockId: selected.blockId ?? selected.documentId,
        resultId: selected.id,
        matchField: selected.matchField,
        matchTerms: selected.matchTerms,
      });
      await writeClipboardText(link);
      setCopiedResultId(selected.id);
      showOperationStatus(`已复制${pdf?`本机 PDF 第 ${pdfPreviewPage} 页链接`:selected.provider==="hub"?"内容":"结果链接"} · ${selected.title}`, "success");
      window.setTimeout(() => setCopiedResultId((current) => current === selected.id ? "" : current), 1_800);
    } catch (reason) {
      const message = `复制链接失败：${String(reason)}`;
      showOperationStatus(message, "error", 6_000);
    }
  }, [selected, pdfPreviewPage, showOperationStatus]);

  useEffect(() => {
    setCopiedResultId("");
  }, [selected?.id, selected?.pageNumber, pdfPreviewPage]);

  useEffect(() => {
    if (!showPreviewPane || !selected) {
      shownDocument.current = "";
      setPreview("");
      setOcrImagePreview(null);
      setPdfPreview(null);
      return;
    }
    let cancelled = false;
    const requestAbort = new AbortController();
    // A page can contain several attachments. Their preview bodies and render
    // kinds must never survive a switch merely because the parent page matches.

    const sameDocument = shownDocument.current === identity;
    shownDocument.current = identity;
    if (!sameDocument) {
      setPreviewLoading(true);
      setPreview("");
      setOcrImagePreview(null);
      setPdfPreview(null);
    }
    if (selected.contentType === "image_ocr") {
      void invoke<OcrImagePreview>("local_ocr_image_preview", { resultId: selected.id })
        .then((result) => { if (!cancelled) setOcrImagePreview(result); })
        .catch((reason) => { if (!cancelled) setPreview(`无法加载图片预览：${String(reason)}`); })
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
      return () => { cancelled = true; };
    }
    if (isPdfContent(selected.contentType)) {
      void pdfRequests.request(JSON.stringify([identity,selected.id,selected.modifiedAt]),() => invoke<PdfPagePreview>("local_pdf_page_preview", { resultId: selected.id, pageNumber: pdfPreviewPage }))
        .then((result) => { if (!cancelled) setPdfPreview(result); })
        .catch((reason) => { if (!cancelled) setPreview(`无法加载 PDF 页面预览：${String(reason)}`); })
        .finally(() => { if (!cancelled) setPreviewLoading(false); });
      return () => { cancelled = true; pdfRequests.cancelPending(); };
    }
    const cacheKey = previewDocumentKey(selected) + (taskVersion ? `\u0000task:${taskVersion}` : "");
    const cached = previewDocumentCache.current.get(cacheKey);
    if (cached !== undefined) {
      setPreview(cached);
      setPreviewLoading(false);
      return () => { cancelled = true; };
    }
    void previewDocumentCache.current.load(cacheKey, () => requestLocalPreviewDocument(selected), "foreground", requestAbort.signal)
      .then((markdown) => {
        if (!cancelled) setPreview(markdown);
      })
      .catch(async (reason) => {
        if (cancelled) return;
        if (selected.provider !== "craft") {
          if (!cancelled) setPreview(`无法加载${providerName(selected.provider)}本地预览：${String(reason)}`);
          return;
        }
        try {
          const markdown = await previewDocumentCache.current.load(cacheKey, () => requestCraftPreviewDocument(selected), "foreground", requestAbort.signal);
          if (!cancelled) setPreview(markdown);
        } catch (fallbackReason) {
          if (!cancelled) setPreview(`无法加载预览：${String(fallbackReason || reason)}`);
        }
      })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; requestAbort.abort(); };
  }, [pdfPreviewPage, selected?.blockId, selected?.contentType, selected?.documentId, selected?.entityKey, selected?.id, selected?.modifiedAt, selected?.provider, selected?.sourceItemId, selected?.spaceId, selected?.taskStatus, showPreviewPane, taskVersion]);

  useEffect(() => {
    if (!showPreviewPane || !results.length || !visible) return;
    const timer = window.setTimeout(() => {
      if (!isWindowVisible()) return;
      const candidates = [
        results[selectedIndex - 1],
        results[selectedIndex + 1],
        results[selectedIndex + 2],
      ].filter((result): result is SearchResult => Boolean(result)
        && result.contentType !== "image_ocr"
        && result.contentType !== "pdf_page"
        && result.contentType !== "pdf_ocr");
      for (const result of candidates) {
        const key = previewDocumentKey(result);
        previewDocumentCache.current.prefetch(key, () => requestLocalPreviewDocument(result));
      }
    }, 100);
    return () => {
      window.clearTimeout(timer);
    };
  }, [results, selectedIndex, showPreviewPane, visible]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const marks = Array.from(previewCard.current?.querySelectorAll<HTMLElement>(
        ".preview-heading mark[data-search-hit='true'], .preview-content mark[data-search-hit='true']",
      ) ?? []);
      let initialIndex = pendingPreviewDirection.current === -1 && marks.length ? marks.length - 1 : 0;
      let snippetTarget: HTMLElement | undefined;
      if (selected?.favoriteKind === "snippet") {
        const normalize = (text: string) => text.replace(/\s+/g, "").replace(/^[.…]+|[.…]+$/g, "");
        const excerpt = normalize(cleanSearchSnippet(selected.snippet)).slice(0, 80);
        if (excerpt) {
          snippetTarget = Array.from(previewCard.current?.querySelectorAll<HTMLElement>(".preview-content p, .preview-content li, .preview-content pre, .preview-content h2, .preview-content h3") ?? [])
            .find(element => normalize(element.textContent ?? "").includes(excerpt));
          const targetIndex = snippetTarget ? marks.findIndex(mark => snippetTarget!.contains(mark)) : -1;
          if (targetIndex >= 0) initialIndex = targetIndex;
        }
      }
      marks.forEach((mark, index) => mark.classList.toggle("active-match", index === initialIndex));
      setPreviewMatchCount(marks.length);
      setPreviewMatchIndex(initialIndex);
      if (marks.length) {
        (snippetTarget ?? marks[initialIndex]).scrollIntoView({ block: "center" });
        pendingPreviewDirection.current = null;
      } else if (!previewLoading) {
        snippetTarget?.scrollIntoView({ block: "center" });
        pendingPreviewDirection.current = null;
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [ocrImagePreview, pdfPreview, preview, previewLoading, selected?.id, selected?.favoriteKind, selected?.snippet, selectedMatchTerms.join("\u0000")]);

  const currentPdf=isPdfContent(selected?.contentType);
  const belongs=shownDocument.current===identity;
  return {
    preview:currentPdf&&!belongs?"":preview,
    ocrImagePreview,
    pdfPreview:belongs?pdfPreview:null,
    pdfPreviewPage,
    setPdfPreviewPage,
    previewLoading:previewLoading||(currentPdf&&!belongs),
    previewMatchCount,
    previewMatchIndex,
    copiedResultId,
    previewCard,
    pendingPreviewDirection,
    navigatePreviewMatch,
    copySelectedLink,
  };
}
