type Task = {
  taskId: string; parentId: string | null; criterion: string; status: string;
  dependencies: string[]; needsRevalidation: string | null; blocker: string | null;
  completionEvidence: { semanticReview: string } | null;
};
export type TaskTree = { revision: number; tasks: Task[] };
const labels: Record<string, string> = {
  pending: "待处理", in_progress: "进行中", waiting_decision: "等待决定",
  blocked: "受阻", done: "已完成", cancelled: "已取消",
};

export function AgentTaskTree({ value }: { value: TaskTree }) {
  if (!value.tasks.length) return null;
  const names = new Map(value.tasks.map(task => [task.taskId, task.criterion]));
  function branch(parent: string | null, ancestors: Set<string>) {
    const children = value.tasks.filter(task => task.parentId === parent && !ancestors.has(task.taskId));
    if (!children.length) return null;
    return <ul>{children.map(task => <li key={task.taskId}>
      <strong>{task.needsRevalidation && task.status === "pending" ? "待重新核对" : labels[task.status] || "待处理"}：{task.criterion}</strong>
      {task.needsRevalidation && <p>{task.needsRevalidation}</p>}
      {task.blocker && <p>等待条件：{task.blocker}</p>}
      {!!task.dependencies.length && <p className="agent-note">依赖：{task.dependencies.map(id => names.get(id) || "已移除的任务").join("、")}</p>}
      {task.completionEvidence && <details><summary>{task.status === "done" ? "查看完成核对" : "查看上次完成核对"}</summary>
        <p>{task.completionEvidence.semanticReview}</p><p className="agent-note">内容符合情况由模型评估；系统核对依赖和成果版本。</p>
      </details>}
      {branch(task.taskId, new Set([...ancestors, task.taskId]))}
    </li>)}</ul>;
  }
  return <section className="agent-progress" aria-label="任务树"><p><strong>执行任务</strong></p>{branch(null, new Set())}</section>;
}
