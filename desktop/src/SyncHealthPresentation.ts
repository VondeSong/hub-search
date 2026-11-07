import type { IndexStatus, LibrarySyncHealth } from "./IndexStatusTypes";

export const SYNC_FAILURE_ATTENTION_THRESHOLD = 3;

export type SyncHealthTone = "healthy" | "working" | "waiting" | "failed" | "offline" | "idle";

export function isLibraryAwaitingRetry(health: LibrarySyncHealth) {
  return health.failedJobs === 0
    && Boolean(health.lastError || health.syncPhase === "partial" || health.syncPhase === "failed")
    && health.consecutiveFailures > 0
    && health.consecutiveFailures < SYNC_FAILURE_ATTENTION_THRESHOLD;
}

export function isLibraryActionRequired(health: LibrarySyncHealth) {
  return health.failedJobs > 0
    || ((health.syncPhase === "partial" || health.syncPhase === "failed" || Boolean(health.lastError))
      && health.consecutiveFailures >= SYNC_FAILURE_ATTENTION_THRESHOLD);
}

export function librarySyncState(health: LibrarySyncHealth, connected: boolean): { tone: SyncHealthTone; label: string } {
  if (["listing", "fetching", "committing"].includes(health.syncPhase ?? "")) {
    return { tone: "working", label: "正在同步" };
  }
  if ((health.runningJobs ?? 0) > 0) return { tone: "working", label: `处理中 ${health.runningJobs}` };
  if (isLibraryActionRequired(health)) {
    return {
      tone: "failed",
      label: health.consecutiveFailures >= SYNC_FAILURE_ATTENTION_THRESHOLD
        ? `已停止自动重试 · ${health.consecutiveFailures} 次失败`
        : "需要处理",
    };
  }
  if (isLibraryAwaitingRetry(health)) return { tone: "waiting", label: "等待自动重试" };
  if (health.pendingJobs > 0) return { tone: "waiting", label: `等待处理 ${health.pendingJobs}` };
  if (!connected) return { tone: "offline", label: "未连接" };
  if (!health.lastSync) return { tone: "idle", label: "等待首次同步" };
  return { tone: "healthy", label: "正常" };
}

export function summarizeSyncHealth(indexStatus: IndexStatus | null, syncing: boolean) {
  const libraries = indexStatus?.libraryHealth ?? [];
  const actionRequired = libraries.filter(isLibraryActionRequired);
  const awaitingRetry = libraries.filter(isLibraryAwaitingRetry);
  const working = syncing || libraries.some(health => ["listing", "fetching", "committing"].includes(health.syncPhase ?? "") || (health.runningJobs ?? 0) > 0)
    || Boolean(indexStatus?.jobDetails.some(job => job.status === "running" && job.count > 0));
  const tone: SyncHealthTone = actionRequired.length > 0
    ? "failed"
    : working
      ? "working"
      : awaitingRetry.length > 0 || (indexStatus?.pendingJobs ?? 0) > 0
        ? "waiting"
        : "healthy";
  return { actionRequired, awaitingRetry, working, tone };
}

