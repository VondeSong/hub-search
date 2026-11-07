import { invoke } from "@tauri-apps/api/core";
import type { SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

type UnifiedTaskSearchLocator = {
  resultId: string;
  documentId: string;
  blockId: string;
  matchField: string;
};

export function taskSearchResult(task: UnifiedTask): SearchResult {
  const craftMarkdownTask = task.provider === "craft" && task.sourceId.includes(":line:");
  const blockId = task.provider === "craft"
    ? task.isProject || craftMarkdownTask
      ? task.parentPageId || task.documentId
      : task.sourceId
    : task.documentId;
  return {
    id: task.id,
    taskSourceId: task.sourceId,
    entityKey: task.id,
    blockId,
    pageId: task.provider === "craft" ? task.parentPageId || task.documentId : undefined,
    documentId: task.documentId,
    contentType: "task",
    sourceType: task.provider === "dida365" ? "dida_task" : `${task.provider}_task`,
    provider: task.provider,
    libraryId: task.libraryId,
    libraryName: task.libraryName,
    spaceId: task.libraryId,
    spaceName: task.libraryName,
    title: task.title,
    // Dida's unified documentTitle is its list name; preview documents use the task title.
    documentTitle: task.provider === "dida365" ? task.title : task.documentTitle,
    taskStatus: task.provider === "dida365" ? task.status === "completed" ? 2 : task.status === "abandoned" ? -1 : 0 : undefined,
    path: task.path,
    modifiedAt: task.modifiedAt,
    snippet: "",
    matchTerms: [],
    matchField: "",
    matchCount: 0,
    subMatches: [],
  };
}

export async function resolveTaskResult(task: UnifiedTask): Promise<SearchResult> {
      const locator = await invoke<UnifiedTaskSearchLocator>("resolve_unified_task_search_result", {
        provider: task.provider,
        libraryId: task.libraryId,
        documentId: task.documentId,
        sourceId: task.sourceId,
        parentPageId: task.parentPageId,
        title: task.title,
        isProject: task.isProject,
      });
      const result = taskSearchResult(task);
      return {
        ...result,
        id: locator.resultId || result.id,
        entityKey: locator.resultId || result.id,
        documentId: locator.documentId,
        blockId: locator.blockId,
        matchField: locator.matchField,
        matchTerms: [],
      };
}

