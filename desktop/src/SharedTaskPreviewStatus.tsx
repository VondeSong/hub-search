import { useEffect } from "react";
import { Circle, CircleSlash } from "lucide-react";
import type { SearchResult } from "./SearchTypes";
import { useUnifiedTasks } from "./UnifiedTaskData";
import { TaskStatusControl, TaskStatusNotice } from "./TaskStatusControl";
import { TaskCompletionIcon } from "./TaskCompletionIcon";
import { findTaskForResult } from "./TaskResultIdentity";

export function SharedTaskPreviewStatus({ result, fallbackStatus }: { result: SearchResult; fallbackStatus?: string }) {
  const { dashboard, taskBusyIds, taskStatusTargets, setTaskCompleted, refreshSources } = useUnifiedTasks();
  const task = findTaskForResult(dashboard.tasks, result);
  useEffect(() => { if (task) void refreshSources([task.id]); }, [task?.id, refreshSources]);
  return task ? <><TaskStatusControl task={task} busy={taskBusyIds.has(task.id)} pendingStatus={taskStatusTargets.get(task.id)}
    onChange={(task, completed) => { void setTaskCompleted(task, completed); }}/><TaskStatusNotice task={task}
      onRetry={task => { void setTaskCompleted(task, task.statusMutation?.targetStatus === "completed"); }}/></>
    : fallbackStatus ? <span className={`preview-task-status${fallbackStatus === "已完成" ? " completed" : fallbackStatus === "已放弃" ? " abandoned" : ""}`}
      role="img" aria-label={fallbackStatus} title={fallbackStatus}>
      {fallbackStatus === "已完成" ? <TaskCompletionIcon /> : fallbackStatus === "已放弃" ? <CircleSlash size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
    </span> : null;
}
