import { createContext, useContext, type ReactNode } from "react";
import type { TaskStatusStyle } from "./AppSettings";
import { CompletedStatusIcon } from "./CompletedStatusIcon";

const TaskStatusStyleContext = createContext<TaskStatusStyle>("filled");

export function TaskStatusStyleProvider({ style, children }: { style: TaskStatusStyle; children: ReactNode }) {
  return <TaskStatusStyleContext.Provider value={style}>{children}</TaskStatusStyleContext.Provider>;
}

export function TaskCompletionIcon({ size = 18 }: { size?: number }) {
  const variant = useContext(TaskStatusStyleContext);
  return <CompletedStatusIcon size={size} className="task-completion-icon" variant={variant}/>;
}
