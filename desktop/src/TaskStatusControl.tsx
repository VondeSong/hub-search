import { Circle, X } from "lucide-react";
import { TaskCompletionIcon } from "./TaskCompletionIcon";
import { canSetUnifiedTaskStatus } from "./UnifiedTaskData";
import type { UnifiedTask } from "./TaskWorkspacePresentation";
import "./TaskStatusControl.css";

export function TaskStatusControl({ task, busy, pendingStatus, onChange }: {
  task: UnifiedTask; busy: boolean; pendingStatus?: "open" | "completed"; onChange: (task: UnifiedTask, completed: boolean) => void;
}) {
  const writable = canSetUnifiedTaskStatus(task);
  const target = pendingStatus ?? (task.statusMutation && task.statusMutation.state !== "confirmed" ? task.statusMutation.targetStatus : undefined);
  const syncing = busy || task.statusMutation?.state === "pending";
  const unsynced = syncing || target !== undefined;
  const completed = target ? target === "completed" : task.completed;
  const action = completed ? "重新打开任务" : "完成任务";
  const title = task.statusWriteBlockedReason || (!writable ? "请在来源中修改任务状态" :
    syncing ? `${action}（正在同步，以最后一次操作为准）` :
    unsynced ? `${action}（同步失败，可再次切换或重试）` : action);
  return <button type="button" className="task-status-control" role="checkbox"
    aria-checked={completed} aria-label={`${completed ? "重新打开" : "完成"}任务：${task.title}`}
    aria-busy={syncing} data-unsynced={unsynced} disabled={!writable} title={title}
    onClick={event => { event.stopPropagation(); onChange(task, !completed); }}>
    {task.status === "abandoned" ? <X size={18}/> : completed ? <TaskCompletionIcon size={18}/> : <Circle size={18}/>}
  </button>;
}

export function TaskStatusNotice({ task, onRetry }: { task: UnifiedTask; onRetry?: (task: UnifiedTask) => void }) {
  if (task.statusMutation?.state !== "failed") return null;
  if (onRetry) return <button type="button" className="task-status-notice task-status-retry"
    title={task.statusMutation.error} aria-label={`重试状态同步：${task.title}`}
    onClick={event => { event.stopPropagation(); onRetry(task); }}>重试同步</button>;
  return <small className="task-status-notice" title={task.statusMutation.error || "操作已保存，联网后会继续同步"} role="status">
    同步失败，可重试
  </small>;
}
