import type { SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { taskSearchResult } from "./TaskWorkspaceResult";

/** Search uses provider content types; the task workspace uses the generic task type. */
export function isTaskPreviewResult(result?: SearchResult): boolean {
  return Boolean(result && !result.sourceItemId && (
    result.contentType === "task" || result.sourceType === "craft_task" || result.sourceType === "obsidian_task"
    || (result.provider === "craft" && result.contentType === "markdown_section" && Boolean(result.blockId))
    || (result.provider === "dida365" && !["image_ocr", "pdf_page", "pdf_ocr"].includes(result.contentType))
  ));
}

/** Aliases locate a shared task; its primary source still determines write capabilities. */
export function findTaskForResult(tasks: UnifiedTask[], result?: SearchResult): UnifiedTask | undefined {
  if (!result || !isTaskPreviewResult(result)) return undefined;
  const matches = (source: { provider: string; libraryId: string; documentId: string; sourceId: string }) =>
    source.provider === result.provider && source.libraryId === result.spaceId && source.documentId === result.documentId
    && source.sourceId === (result.provider === "dida365" ? result.documentId : result.blockId);
  return tasks.find(task => matches(task) || task.sourceRefs?.some(matches)
    || (result.contentType === "task" && result.id === task.id && result.provider === task.provider
      && result.spaceId === task.libraryId && result.documentId === task.documentId
      && result.blockId === taskSearchResult(task).blockId));
}
