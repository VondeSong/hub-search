import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { flushUserProfileStorage } from "./UserProfileStorage";
import type { DataPortabilityStatus } from "./useDataPortability";

export type RecoveryCleanupStatus = {
  id: string;
  phase: "requested" | "running" | "complete" | "partial" | "failed" | "cancelled";
  error: string;
  plannedFiles: number;
  plannedLogicalBytes: number;
  deletedFiles: number;
  deletedLogicalBytes: number;
  retainedFiles: number;
  updatedAt: number;
};
export type RecoveryCleanupPreview = {
  token: string;
  logicalBytes: number;
  files: number;
  candidates: { id: string; label: string; logicalBytes: number; files: number }[];
  retained: { id: string; label: string; logicalBytes: number; files: number; reason: string }[];
  warnings: string[];
  requiresRestart: boolean;
};
export type CurrentDataStatus = {
  root: string;
  usage: DataPortabilityStatus["usage"];
  activeOperation: DataPortabilityStatus["activeOperation"];
  compaction: {
    preview: { reclaimableBytes: number; requiredFreeBytes: number; availableFreeBytes: number | null };
    status: { phase: string; error: string; beforeBytes: number; afterBytes: number } | null;
    retainedBytes: number;
    note: string;
  };
  cleanup: { status: RecoveryCleanupStatus | null };
};
const call = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>("data_portability", { args: { action, ...args } });
const message = (value: unknown) => value instanceof Error ? value.message : String(value);

export function useCurrentDataManagement({ blocked = false, enabled = true }: { blocked?: boolean; enabled?: boolean } = {}) {
  const [status, setStatus] = useState<CurrentDataStatus | null>(null);
  const [preview, setPreview] = useState<RecoveryCleanupPreview | null>(null);
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true), active = useRef(false), revision = useRef(0);
  const refreshFlight = useRef<Promise<void> | null>(null), refreshPending = useRef(false);
  const refresh = useCallback((): Promise<void> => {
    if (refreshFlight.current) { refreshPending.current = true; return refreshFlight.current; }
    const work = async () => {
      do {
        refreshPending.current = false;
        const current = ++revision.current;
        const value = await call<CurrentDataStatus>("storage_status");
        if (alive.current && current === revision.current) setStatus(value);
      } while (alive.current && refreshPending.current);
    };
    const flight = work().finally(() => { refreshFlight.current = null; });
    refreshFlight.current = flight;
    return flight;
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) { setLoading(false); return () => { alive.current = false; }; }
    void refresh().catch(reason => { if (alive.current) setError(`无法读取空间占用：${message(reason)}。请刷新重试。`); })
      .finally(() => { if (alive.current) setLoading(false); });
    let dispose: (() => void) | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    void listen("data-portability-updated", () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        if (alive.current) void refresh().catch(reason => { if (alive.current) setError(`空间状态未刷新：${message(reason)}。请刷新重试。`); });
      }, 250);
    }).then(value => { if (alive.current) dispose = value; else value(); })
      .catch(reason => { if (alive.current) setError(`无法接收空间状态：${message(reason)}。请刷新重试。`); });
    return () => { alive.current = false; revision.current++; refreshPending.current = false; clearTimeout(refreshTimer); dispose?.(); };
  }, [enabled, refresh]);
  const locked = blocked || Boolean(busy) || Boolean(status?.activeOperation);
  const run = async (label: string, work: () => Promise<void>, readOnly = false) => {
    if (!enabled || !alive.current || active.current || (!readOnly && (blocked || status?.activeOperation))) return;
    active.current = true; setBusy(label); setError(""); setNotice("");
    try { await work(); }
    catch (reason) { if (alive.current) setError(`${message(reason)}。请刷新状态后重试。`); }
    finally { active.current = false; if (alive.current) { setBusy(""); setLoading(false); } }
  };
  const inspectCleanup = () => run("正在检查可清理项目…", async () => {
    setPreview(null);
    const value = await call<RecoveryCleanupPreview>("preview_recovery_cleanup", { operationId: crypto.randomUUID() });
    if (alive.current) setPreview(value);
  });
  const scheduleCleanup = () => run("正在安排清理…", async () => {
    if (!preview?.files) return;
    const token = preview.token;
    await flushUserProfileStorage();
    if (!alive.current) return;
    setPreview(null);
    const result = await call<{ status: RecoveryCleanupStatus }>("schedule_recovery_cleanup", { token, operationId: crypto.randomUUID() });
    if (!alive.current) return;
    setStatus(value => value ? { ...value, cleanup: { status: result.status } } : value);
    setNotice("已安排下次启动清理。你可以在重启前取消安排。");
    await refresh();
  });
  const cancelCleanup = () => run("正在取消清理安排…", async () => {
    const result = await call<RecoveryCleanupStatus>("cancel_recovery_cleanup", { operationId: crypto.randomUUID() });
    if (!alive.current) return;
    setStatus(value => value ? { ...value, cleanup: { status: result } } : value);
    setNotice("已取消清理安排。"); await refresh();
  });
  const compact = (cancel: boolean) => run(cancel ? "正在取消压实安排…" : "正在安排数据库压实…", async () => {
    if (!cancel) await flushUserProfileStorage();
    if (!alive.current) return;
    const result = await invoke<NonNullable<CurrentDataStatus["compaction"]["status"]>>(cancel ? "cancel_local_database_maintenance" : "schedule_local_database_maintenance");
    if (!alive.current) return;
    setStatus(value => value ? { ...value, compaction: { ...value.compaction, status: result } } : value);
    setNotice(cancel ? "已取消数据库压实安排。" : "已安排下次启动压实数据库，并保留完整恢复副本。");
    await refresh();
  });
  return { status, preview, busy, loading, error, notice, locked, inspectCleanup, scheduleCleanup, cancelCleanup, compact,
    clearPreview: () => setPreview(null), reload: () => run("正在刷新空间占用…", refresh, true) };
}
export type CurrentDataManagementState = ReturnType<typeof useCurrentDataManagement>;
