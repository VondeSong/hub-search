import { useCallback, useRef } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "./SearchTypes";
import { resultLinkRequest, resultMarkdownLink, resultSummary, writeResultDragData } from "./ResultActions";
import { resultDisplayTitle } from "./SearchResultPresentation";
import { writeClipboardText } from "./usePreviewController";
import type { showOperationStatus as OperationNotifier } from "./useOperationStatus";

export function useResultActions({ showOperationStatus }: { showOperationStatus: typeof OperationNotifier }) {
const resultLinkCache = useRef(new Map<string, string>());

const getResultLink = useCallback(async (result: SearchResult) => {
    const cached = resultLinkCache.current.get(result.entityKey);
    if (cached) return cached;
    const link = await invoke<string>("result_link", resultLinkRequest(result));
    resultLinkCache.current.set(result.entityKey, link);
    return link;
  }, []);

const prepareResultLink = useCallback((result: SearchResult) => {
    void getResultLink(result).catch(() => undefined);
  }, [getResultLink]);

const copyResultValue = useCallback(async (result: SearchResult, kind: "link" | "markdown" | "title" | "summary") => {
    try {
      let value: string;
      let label: string;
      if (kind === "link") {
        value = await getResultLink(result);
        label = "深链接";
      } else if (kind === "markdown") {
        value = resultMarkdownLink(result, await getResultLink(result));
        label = "Markdown 链接";
      } else if (kind === "summary") {
        value = resultSummary(result);
        label = "正文摘要";
      } else {
        value = resultDisplayTitle(result);
        label = "标题";
      }
      if (!value) throw new Error("当前结果没有可复制的内容");
      await writeClipboardText(value);
      showOperationStatus(`已复制${label} · ${resultDisplayTitle(result)}`, "success");
    } catch (reason) {
      const message = `复制失败：${String(reason)}`;
      showOperationStatus(message, "error", 6_000);
    }
  }, [getResultLink, showOperationStatus]);

const revealResult = useCallback(async (result: SearchResult) => {
    try {
      await invoke("reveal_result_in_file_manager", {
        libraryId: result.libraryId,
        documentId: result.documentId,
        resultId: result.id,
      });
      showOperationStatus(`已在文件管理器中定位 · ${resultDisplayTitle(result)}`, "success");
    } catch (reason) {
      const message = `无法定位文件：${String(reason)}`;
      showOperationStatus(message, "error", 6_000);
    }
  }, [showOperationStatus]);

const dragResult = useCallback((event: ReactDragEvent, result: SearchResult) => {
    writeResultDragData(event.dataTransfer, result, resultLinkCache.current.get(result.entityKey));
  }, []);

return { getResultLink, prepareResultLink, copyResultValue, revealResult, dragResult };
}
