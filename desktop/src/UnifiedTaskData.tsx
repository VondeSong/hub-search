import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { summarizeTasks, type UnifiedTask } from "./TaskWorkspacePresentation";
import { useWindowResumeRefresh } from "./useWindowResumeRefresh";

export type TaskSyncReview = {
  id: number;
  hubTaskId: string;
  action: "conflict";
  title: string;
  message: string;
  mergeAllowed: boolean;
  status: "review" | "pending" | "failed";
  conflictType: "content" | "identity";
  boundCraftSourceId?: string;
  boundCraftTitle?: string;
  boundCraftDocumentTitle?: string;
  boundCraftModifiedAt?: number;
  managedCraftSourceId?: string;
  managedCraftTitle?: string;
  managedCraftDocumentTitle?: string;
  managedCraftModifiedAt?: number;
  managedCraftState?: "available" | "missing" | "linked_elsewhere";
};

export type UnifiedTaskDashboard = {
  tasks: UnifiedTask[];
  total: number;
  open: number;
  completed: number;
  craft: number;
  dida365: number;
  obsidian: number;
  linked: number;
  syncEnabled: boolean;
  backgroundSyncIntervalMinutes: number;
  lastSyncAt?: number;
  lastSyncStatus?: "running" | "completed" | "completed_with_errors" | "failed" | "interrupted";
  lastSyncFailed: number;
  syncReviews: TaskSyncReview[];
};

const EMPTY_DASHBOARD: UnifiedTaskDashboard = {
  tasks: [], total: 0, open: 0, completed: 0,
  craft: 0, dida365: 0, obsidian: 0, linked: 0, syncEnabled: false,
  backgroundSyncIntervalMinutes: 15, lastSyncFailed: 0, syncReviews: [],
};

type TaskSnapshot = { dashboard: UnifiedTaskDashboard; ready: boolean; loading: boolean; error: string; taskBusyIds: ReadonlySet<string>; taskStatusTargets: ReadonlyMap<string, "open" | "completed"> };

/** Mutability is restricted to native task blocks; the host performs the final capability check. */
export function canSetUnifiedTaskStatus(task: UnifiedTask): boolean {
  return ["craft", "dida365"].includes(task.provider) && !task.isProject && Boolean(task.sourceId)
    && !task.statusWriteBlockedReason
    && !task.sourceId.includes(":line:") && task.status !== "abandoned" && task.syncState !== "conflict";
}

function sameIdentity(left: UnifiedTask, right: UnifiedTask): boolean {
  return left.id === right.id && left.provider === right.provider && left.libraryId === right.libraryId
    && left.documentId === right.documentId && left.sourceId === right.sourceId;
}

function countedDashboard(dashboard: UnifiedTaskDashboard, tasks: UnifiedTask[]): UnifiedTaskDashboard {
  const { total, open, completed, craft, dida365, obsidian, linked } = summarizeTasks(tasks);
  return { ...dashboard, tasks, total, open, completed, craft, dida365, obsidian, linked };
}

/** One unfiltered local dashboard for every task consumer in this application session. */
export function createUnifiedTaskStore() {
  let snapshot: TaskSnapshot = { dashboard: EMPTY_DASHBOARD, ready: false, loading: false, error: "", taskBusyIds: new Set(), taskStatusTargets: new Map() };
  const subscribers = new Set<() => void>(), consumers = new Set<object>(), pending = new Map<string, "open" | "completed">();
  let loaded = false, dirty = true, queued = false, flight: Promise<void> | null = null, version: string | undefined;
  let writes = 0;
  const confirmed = new Map<string, { revision: number; task: UnifiedTask }>();
  const statusWorkers = new Map<string, Promise<boolean>>();
  const publish = (patch: Partial<TaskSnapshot>) => {
    const dashboard = patch.dashboard ?? snapshot.dashboard;
    const targets = new Map(pending);
    const busy = new Set(pending.keys());
    dashboard.tasks.forEach(task => {
      if (task.statusMutation?.state === "pending") busy.add(task.id);
      if (task.statusMutation && task.statusMutation.state !== "confirmed" && !targets.has(task.id)) {
        targets.set(task.id, task.statusMutation.targetStatus);
      }
    });
    snapshot = { ...snapshot, ...patch, taskBusyIds: busy, taskStatusTargets: targets };
    subscribers.forEach(subscriber => subscriber());
  };

  const refresh = (): Promise<void> => {
    dirty = true;
    if (flight) { queued = true; return flight; }
    publish({ loading: true, error: "" });
    flight = (async () => {
      do {
        queued = false;
        dirty = false;
        const readRevision = writes;
        try {
          const next = await invoke<UnifiedTaskDashboard>("list_unified_tasks");
          if (!Array.isArray(next?.tasks) || !Array.isArray(next.syncReviews)) throw new Error("任务数据格式无效");
          const seen = new Set<string>();
          const tasks = next.tasks.map(task => {
            if (!task?.id || seen.has(task.id)) throw new Error("任务数据发生变化，请刷新后重试");
            seen.add(task.id);
            const saved = confirmed.get(task.id);
            return saved && saved.revision > readRevision && sameIdentity(saved.task, task) ? saved.task : task;
          });
          // A query begun before a successful write must not remove its confirmed task either.
          for (const saved of confirmed.values()) {
            if (saved.revision > readRevision && !seen.has(saved.task.id)) tasks.push(saved.task);
          }
          loaded = true;
          publish({ dashboard: countedDashboard(next, tasks), ready: true, error: "" });
        } catch (reason) {
          dirty = true;
          publish({ error: String(reason) });
        }
      } while (queued);
    })().finally(() => {
      flight = null;
      publish({ loading: false });
    });
    return flight;
  };

  const invalidate = () => {
    dirty = true;
    if (consumers.size) void refresh();
  };
  const setVersion = (next: string | undefined) => {
    if (next === undefined || next === version) return;
    const changed = version !== undefined;
    version = next;
    if (changed) invalidate();
  };
  const acquire = (owner: object) => {
    consumers.add(owner);
    if ((!loaded || dirty) && !flight) void refresh();
    return () => { consumers.delete(owner); };
  };

  const setTaskCompleted = async (task: UnifiedTask, completed: boolean): Promise<boolean> => {
    if (!canSetUnifiedTaskStatus(task)) return false;
    const current = snapshot.dashboard.tasks.find(item => item.id === task.id);
    const worker = statusWorkers.get(task.id);
    if (!current || !sameIdentity(current, task) || !canSetUnifiedTaskStatus(current)
      || (!worker && current.status !== task.status)) {
      publish({ error: "任务已发生变化，请刷新后重试" });
      return false;
    }
    const target = completed ? "completed" : "open";
    if (!worker && current.completed === completed && current.status === target
      && (!current.statusMutation || current.statusMutation.state === "confirmed")) return true;
    pending.set(task.id, target);
    publish({ error: "" });
    const work = worker ?? (async () => {
      let source = current;
      try {
        while (pending.has(task.id)) {
          const goal = pending.get(task.id)!;
          let saved: UnifiedTask;
          try {
            saved = await invoke<UnifiedTask>("set_unified_task_status", {
              taskId: source.id, status: goal, expectedStatus: source.status,
              expectedLibraryId: source.libraryId, expectedDocumentId: source.documentId, expectedSourceId: source.sourceId,
            });
          } catch (reason) {
            if (pending.get(task.id) === goal) throw reason;
            // A superseded write may have reached the source despite a failed
            // readback. Rebase the newest request on the current local read.
            await refresh();
            const fresh = snapshot.dashboard.tasks.find(item => item.id === task.id);
            if (!fresh || !sameIdentity(fresh, task) || !canSetUnifiedTaskStatus(fresh)) throw reason;
            source = fresh;
            continue;
          }
          if (!saved || !sameIdentity(saved, task)) throw new Error("来源尚未确认任务状态，请刷新后重试");
          const settled = saved.status === goal && saved.completed === (goal === "completed");
          if (!settled && (!saved.statusMutation || saved.statusMutation.targetStatus !== goal)) {
            throw new Error("来源尚未确认任务状态，请刷新后重试");
          }
          confirmed.set(saved.id, { revision: ++writes, task: saved });
          const items = snapshot.dashboard.tasks;
          const tasks = items.some(item => item.id === saved.id)
            ? items.map(item => item.id === saved.id ? saved : item) : [...items, saved];
          publish({ dashboard: countedDashboard(snapshot.dashboard, tasks), error: pending.get(task.id) !== goal || settled
            || saved.statusMutation?.state === "pending" ? "" :
            saved.statusMutation?.error || "任务状态未确认，请刷新后重试" });
          source = saved;
          if (pending.get(task.id) === goal) return settled;
          // Only the newest target is sent after this request settles; the
          // shared target remains visible while old confirmations arrive.
        }
        return false;
      } catch (reason) {
        publish({ error: String(reason) });
        return false;
      } finally {
        pending.delete(task.id);
        statusWorkers.delete(task.id);
        publish({});
      }
    })();
    if (!worker) statusWorkers.set(task.id, work);
    const settled = await work;
    const final = snapshot.dashboard.tasks.find(item => item.id === task.id);
    return settled && final?.status === target && final.completed === completed;
  };

  const refreshSources = async (taskIds: string[] = []) => {
    try { await invoke("refresh_unified_task_sources", { taskIds }); }
    catch { /* Local data remains usable; regular provider sync is the fallback. */ }
  };

  return {
    subscribe: (callback: () => void) => { subscribers.add(callback); return () => { subscribers.delete(callback); }; },
    getSnapshot: () => snapshot,
    acquire, setVersion, invalidate, refresh, setTaskCompleted, refreshSources,
  };
}

type UnifiedTaskStore = ReturnType<typeof createUnifiedTaskStore>;
const UnifiedTasksContext = createContext<{ store: UnifiedTaskStore; revisionControlled: boolean } | null>(null);

function useTaskStoreEvents(store: UnifiedTaskStore) {
  useWindowResumeRefresh(() => { store.invalidate(); void store.refreshSources(); });
  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const unlisteners: Array<() => void> = [];
    for (const name of ["task-list-updated", "task-sync-updated", "library-runtime-updated", "library-registry-updated"]) {
      void listen<{ state?: string; status?: string; activeOperations?: number; pending?: number }>(name, event => {
        if (disposed || (name === "task-sync-updated" && event.payload?.status === "running")) return;
        if (name === "library-runtime-updated" && (
          ["running", "pausing", "removing"].includes(event.payload?.state ?? "")
          || (event.payload?.activeOperations ?? 0) > 0 || (event.payload?.pending ?? 0) > 0
        )) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(() => { if (!disposed) store.invalidate(); }, 160);
      }).then(unlisten => {
        if (disposed) unlisten(); else unlisteners.push(unlisten);
      }).catch(() => { /* Poll and manual refresh remain available if host events are unavailable. */ });
    }
    return () => { disposed = true; window.clearTimeout(timer); unlisteners.forEach(unlisten => unlisten()); };
  }, [store]);
}

export function UnifiedTaskProvider({ children, dataVersion }: { children: ReactNode; dataVersion?: string }) {
  const [store] = useState(createUnifiedTaskStore);
  useTaskStoreEvents(store);
  useEffect(() => store.setVersion(dataVersion), [store, dataVersion]);
  return <UnifiedTasksContext.Provider value={{ store, revisionControlled: dataVersion !== undefined }}>{children}</UnifiedTasksContext.Provider>;
}

/** Date, scope and text filters belong to consumers, never to this shared read. */
export function useUnifiedTasks({ enabled = true, dataVersion }: { enabled?: boolean; dataVersion?: string } = {}) {
  const context = useContext(UnifiedTasksContext);
  // Standalone previews/tests remain independent; the real app always provides the shared session.
  const [standalone] = useState(createUnifiedTaskStore);
  const store = context?.store ?? standalone;
  const owner = useRef({});
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => {
    if (!context?.revisionControlled) store.setVersion(dataVersion);
  }, [store, context?.revisionControlled, dataVersion]);
  useEffect(() => enabled ? store.acquire(owner.current) : undefined, [store, enabled]);
  return {
    ...snapshot,
    loading: snapshot.loading || (enabled && !snapshot.ready && !snapshot.error),
    refresh: store.refresh, setTaskCompleted: store.setTaskCompleted, refreshSources: store.refreshSources,
  };
}
