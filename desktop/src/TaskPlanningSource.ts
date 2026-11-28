import type { UnifiedTask } from "./TaskWorkspacePresentation";
import { invoke } from "@tauri-apps/api/core";
import type { TaskSuggestion } from "./TaskPlanning";
export type TaskReadReceipt = { taskId: string; provider: string; libraryName: string; state: "confirmed" | "cached" | "failed"; checkedAt: number; indexedAt?: number; error?: string };
export type TaskNoteAction = { id: string; taskId: string; sourceId: string; title?: string; libraryName: string; state: "prepared" | "retryable" | "writing" | "confirmed" | "unknown" | "conflict" | "cancelled"; before: string; after: string; error?: string; updatedAt: number };
export type TaskCreateReceipt = {
  id: string;
  state: "writing" | "confirmed" | "unknown" | "failed";
  libraryId: string;
  libraryName: string;
  projectId: string;
  projectName: string;
  sourceId: string;
  taskId: string;
  title: string;
  priority: number;
  task?: UnifiedTask;
  error?: string | null;
  updatedAt: number;
};

export const taskSourceCall = <T,>(args: Record<string, unknown>) => invoke<T>("task_planning_source", { args });
export const refreshPlanningSources = (taskIds: string[]) => taskSourceCall<{ receipts: TaskReadReceipt[]; coverage: string; inventoryComplete: boolean }>({ action: "refresh", taskIds });
export const prepareSourceNote = (s: TaskSuggestion, text: string) => taskSourceCall<TaskNoteAction>({ action: "prepareNote", taskId: s.task.id, contentRevision: s.task.contentRevision, workId: s.workId, text });
export function sourceNoteStatus(action: TaskNoteAction) {
  return action.state === "confirmed" ? action.error ? "来源已确认，本地刷新待重试" : "已回读确认写入滴答"
    : action.state === "conflict" ? "来源已变化，未覆盖原文"
    : action.state === "prepared" ? "尚未提交来源"
    : action.state === "retryable" ? "来源仍为原文，可以重新确认同一变更" : "写入结果待核对，未重复提交";
}

export const createDidaTaskSource = (args: { requestId: string; title: string; priority: 0 | 5; libraryId?: string; projectId?: string }) =>
  taskSourceCall<TaskCreateReceipt>({ action: "createTask", ...args });
