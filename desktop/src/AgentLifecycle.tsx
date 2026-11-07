import type {ProviderBudget,ExecutionBudget} from "./AgentProviderBudget";
export type Lifecycle = {
  providerBudget?:ProviderBudget; executionBudget?:ExecutionBudget;
  schemaVersion: number; controlRevision: number; workRevision: number;
  activeRunId: string | null; state: string; requiresExplicitResume: boolean;
  canResume: boolean; recoveryMode: string; runsUsed: number; runLimit: number | null;
  unresolvedActions: number; reason: string; recordedUsage: Record<string, number>;
  usageCompleteness?: "recorded" | "incomplete"; unmeasuredRunIds?: string[];
  recordedUsageIsLowerBound?: boolean;
  executionModes?: Record<string, boolean>;
};

export function canRunMode(value: Lifecycle | undefined, mode: string) {
  return value?.executionModes?.[mode] !== false;
}

export function lifecycleRequest(value: Lifecycle, commandId: string) {
  return { commandId, expectedControlRevision: value.controlRevision,
    expectedWorkRevision: value.workRevision, expectedRunId: value.activeRunId };
}

export function acceptLifecycleSnapshot<T extends { work: {id: string}; lifecycle?: Lifecycle }>(current: T | null, incoming: T): T {
  if (current?.work.id === incoming.work.id && current.lifecycle && incoming.lifecycle &&
      (current.lifecycle.controlRevision > incoming.lifecycle.controlRevision ||
       current.lifecycle.workRevision > incoming.lifecycle.workRevision)) return current;
  return incoming;
}

export function AgentLifecycle({ value, disabled, mode = "quick", onResume, onCancel }: {
  value: Lifecycle; disabled: boolean; mode?: string; onResume: () => void; onCancel: () => void;
}) {
  if (value.state === "revoked") return null;
  const label = value.state === "stopping" ? "正在停止本轮" : value.state === "cancelled" ? "任务已停止" : value.state === "paused" ? "本轮已停止" : "工作记录";
  return <section className="agent-progress" aria-label="工作生命周期">
    {value.usageCompleteness==="incomplete" && <p role="status">有 {value.unmeasuredRunIds?.length || 1} 轮模型用量未完整返回。累计数字仅包含已记录部分，不能视为未消耗。</p>}
    {!canRunMode(value,mode) && !value.reason && <p role="status">当前处理深度不能开始新分析；可以保存补充，旧成果与历史仍可查看。</p>}
    {(value.requiresExplicitResume || value.unresolvedActions > 0 || Boolean(value.reason) || (value.runLimit !== null && value.runsUsed >= value.runLimit)) && <p role="status"><strong>{label}</strong> · {value.reason}</p>}
    <div className="agent-actions">
      {value.requiresExplicitResume && <button type="button" disabled={disabled || !value.canResume || !canRunMode(value,mode)} onClick={onResume}>恢复并继续</button>}
      {(!value.requiresExplicitResume || value.state === "paused") && <button type="button" disabled={disabled} title="停止后续处理；聊天、成果和已完成的操作保留" onClick={onCancel}>停止此任务</button>}
    </div>
    {value.state !== "cancelled" && <p className="agent-note">停止此任务会暂停后续处理和自动复查，保留聊天、成果与已完成的操作；之后可手动恢复。</p>}
    {value.requiresExplicitResume && <p className="agent-note">恢复会在同一事项中开启新一轮，重新核对来源、任务和成果。已完成的业务动作保留；待核验动作不会自动重做。</p>}
  </section>;
}
