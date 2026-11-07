import { invoke } from "@tauri-apps/api/core";
import { useCallback } from "react";
import type { SearchResult } from "./SearchTypes";
import type { useResultOpener } from "./useResultOpener";
import type { showOperationStatus as OperationNotifier } from "./useOperationStatus";

export function useMarkdownLinkOpening({ previewSelected, openResult, openExternalLink, showOperationStatus }: { previewSelected: SearchResult | undefined; openResult: ReturnType<typeof useResultOpener>; openExternalLink: (url: string) => Promise<unknown>; showOperationStatus: typeof OperationNotifier }) {
const openMarkdownLink = useCallback((href?: string) => {
    if (!href) return;
    const marker = "#obsidian-wikilink=";
    if (href.startsWith(marker) && previewSelected?.provider === "obsidian") {
      const file = decodeURIComponent(href.slice(marker.length));
      void invoke("open_obsidian_wikilink", {
        libraryId: previewSelected.libraryId,
        sourcePath: previewSelected.path,
        file,
      }).catch((reason) => showOperationStatus(`打开失败 · ${String(reason)}`, "error", 6_000));
      return;
    }
    const craftPageMarker = "#craft-subpage=";
    if (href.startsWith(craftPageMarker) && previewSelected?.provider === "craft") {
      const blockId = decodeURIComponent(href.slice(craftPageMarker.length));
      openResult({ ...previewSelected, id: "", blockId, pageId: blockId }, "preview");
      return;
    }
    if (previewSelected?.provider === "dida365" && !/^https?:\/\//i.test(href)) {
      void invoke("open_dida_attachment", {
        spaceId: previewSelected.spaceId,
        documentId: previewSelected.documentId,
        source: href,
      }).catch((reason) => showOperationStatus(`打开失败 · ${String(reason)}`, "error", 6_000));
      return;
    }
    if (/^https?:\/\//i.test(href)) void openExternalLink(href);
  }, [openExternalLink, openResult, previewSelected, showOperationStatus]);
return openMarkdownLink;
}
