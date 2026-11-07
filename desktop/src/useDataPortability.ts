import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { flushUserProfileStorage } from "./UserProfileStorage";

export type DataDependency = {
  id: string;
  kind: "obsidian" | "craftBackup" | "reading" | "externalAttachment";
  name: string;
  sourcePath: string;
  included: boolean;
  archivePath: string | null;
  available: boolean;
  canRelocate?: boolean;
  description?: string;
};
export type DataBackupSchedule = {
  enabled: boolean;
  destination: string;
  intervalHours: number;
  keepCount: number;
  includeExternalSources: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
};
export type DataPortabilityStatus = {
  hasAccountCopy?: boolean;
  root: string;
  usage: {
    root: string;
    logicalBytes: number;
    files: number;
    categories: { id: string; label: string; logicalBytes: number; files: number; rebuildable: boolean }[];
    warnings: string[];
  };
  dependencies: DataDependency[];
  schedule: DataBackupSchedule;
  activeOperation: { operationId: string; phase: string } | null;
  warnings: string[];
};
export type DataDirectoryPreview = {
  token: string;
  path: string;
  schemaVersion: number;
  libraries: number;
  documents: number;
  profileValues: number;
  warnings: string[];
  dependencies: DataDependency[];
};
export type DataBackupSummary = {
  path: string;
  datasetId: string;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  files: number;
  bytes: number;
  archiveBytes: number;
  checksum: string;
  complete: boolean;
  dependencies: DataDependency[];
  warnings: string[];
};
export type DataBackupPreview = DataBackupSummary & { token: string };
export type DataPortabilityProgress = {
  operationId: string;
  phase: string;
  completedBytes?: number;
  totalBytes?: number | null;
  completedFiles?: number;
  totalFiles?: number | null;
  completed?: number;
  total?: number | null;
  message?: string;
};
type RestoreResult = {
  destination: string;
  backup: DataBackupSummary;
  pathMappings: { sourcePath: string; restoredPath: string; kind: string; id: string }[];
  warnings: string[];
  restartRequired: boolean;
};
type Operation = { id: string; cancelRequested: boolean; cancellable: boolean };
const command = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>("data_portability", { args: { action, ...args } });
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
export const defaultDataBackupSchedule: DataBackupSchedule = {
  enabled: false, destination: "", intervalHours: 24, keepCount: 7,
  includeExternalSources: false, lastAttemptAt: null, lastSuccessAt: null, lastError: null,
};

export function useDataPortability({ blocked = false }: { blocked?: boolean } = {}) {
  const [status, setStatus] = useState<DataPortabilityStatus | null>(null);
  const [directoryPreview, setDirectoryPreview] = useState<DataDirectoryPreview | null>(null);
  const [backupPreview, setBackupPreview] = useState<DataBackupPreview | null>(null);
  const [createdBackup, setCreatedBackup] = useState<DataBackupSummary | null>(null);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [restoreDestination, setRestoreDestination] = useState("");
  const [openAfterRestore, setOpenAfterRestore] = useState(true);
  const [includeExternalSources, setIncludeExternalSources] = useState(false);
  const [schedule, setSchedule] = useState(defaultDataBackupSchedule);
  const [busy, setBusy] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<DataPortabilityProgress | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [restarting, setRestarting] = useState(false);
  const mounted = useRef(true), generation = useRef(0), active = useRef<Operation | null>(null);
  const scheduleDirty = useRef(false);
  const owns = (operation: Operation) => mounted.current && active.current === operation;

  const refresh = useCallback(async () => {
    const id = ++generation.current;
    const value = await command<DataPortabilityStatus>("status");
    if (!mounted.current || id !== generation.current) return;
    setStatus(value);
    setSchedule(current => scheduleDirty.current ? {
      ...current,
      lastAttemptAt: value.schedule.lastAttemptAt,
      lastSuccessAt: value.schedule.lastSuccessAt,
      lastError: value.schedule.lastError,
    } : value.schedule);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(reason => { if (mounted.current) setError(message(reason)); });
    const disposers: (() => void)[] = [];
    const keepListener = (unlisten: () => void) => { if (mounted.current) disposers.push(unlisten); else unlisten(); };
    void listen<DataPortabilityProgress>("data-portability-progress", event => {
      if (mounted.current && active.current?.id === event.payload.operationId) setProgress(event.payload);
    }).then(keepListener)
      .catch(reason => { if (mounted.current) setError(`无法接收备份进度：${message(reason)}`); });
    void listen("data-portability-updated", () => {
      if (mounted.current) void refresh().catch(reason => { if (mounted.current) setError(`备份状态刷新失败：${message(reason)}`); });
    }).then(keepListener)
      .catch(reason => { if (mounted.current) setError(`无法接收备份状态：${message(reason)}`); });
    return () => { mounted.current = false; generation.current++; disposers.forEach(dispose => dispose()); };
  }, [refresh]);

  const run = async (label: string, work: (operation: Operation) => Promise<void>, cancellable = false) => {
    if (!mounted.current || active.current || blocked || restarting || status?.activeOperation) return;
    const operation: Operation = { id: crypto.randomUUID(), cancelRequested: false, cancellable };
    active.current = operation;
    setBusy(label); setError(""); setNotice(""); setProgress(null); setCancelling(false);
    try { await work(operation); }
    catch (reason) { if (owns(operation)) setError(message(reason)); }
    finally {
      if (active.current === operation) active.current = null;
      if (mounted.current) { setBusy(""); setProgress(null); setCancelling(false); }
    }
  };
  const proceed = (operation: Operation) => owns(operation) && !operation.cancelRequested;
  const flush = async (operation: Operation) => {
    if (!proceed(operation)) return false;
    await flushUserProfileStorage();
    return proceed(operation);
  };
  const refreshAfterSuccess = async (operation: Operation) => {
    if (!owns(operation)) return;
    try { await refresh(); }
    catch (reason) { if (owns(operation)) setError(`操作已完成，状态刷新失败：${message(reason)}`); }
  };
  const chooseExistingDirectory = () => run("正在检查已有数据目录…", async operation => {
    setDirectoryPreview(null); setBackupPreview(null); setRestoreResult(null);
    const path = await open({ directory: true, multiple: false, title: "选择已有 Hub 数据目录" });
    if (!proceed(operation) || typeof path !== "string") return;
    const preview = await command<DataDirectoryPreview>("inspect_directory", { path });
    if (proceed(operation)) setDirectoryPreview(preview);
  });
  const openExistingDirectory = () => {
    if (!directoryPreview) return Promise.resolve();
    const preview = directoryPreview;
    return run("正在准备打开数据目录…", async operation => {
      if (!await flush(operation)) return;
      try {
        const result = await command<{ restartRequired: boolean }>("open_directory", { token: preview.token });
        if (!owns(operation)) return;
        setDirectoryPreview(null); setRestarting(result.restartRequired);
        setNotice(result.restartRequired ? "数据目录已确认，Hub 即将重启。" : "当前已经使用这个数据目录。");
        if (!result.restartRequired) await refreshAfterSuccess(operation);
      } catch (reason) { if (owns(operation)) setDirectoryPreview(null); throw reason; }
    });
  };
  const createBackup = () => run("正在生成并校验备份…", async operation => {
    setCreatedBackup(null);
    const destination = await save({ defaultPath: `Hub备份-${new Date().toISOString().slice(0, 10)}.hubbackup`, filters: [{ name: "Hub 数据备份", extensions: ["hubbackup"] }] });
    if (!proceed(operation) || !destination || !await flush(operation)) return;
    const result = await command<DataBackupSummary>("create_backup", { destination, includeExternalSources, operationId: operation.id });
    if (!owns(operation)) return;
    setCreatedBackup(result);
    setNotice(result.complete ? "备份文件已生成并通过校验。" : "备份文件已生成并通过校验，请查看覆盖范围中的缺项。");
    await refreshAfterSuccess(operation);
  }, true);
  const chooseBackup = () => run("正在检查备份文件…", async operation => {
    setBackupPreview(null); setDirectoryPreview(null); setRestoreResult(null); setRestoreDestination("");
    const path = await open({ multiple: false, directory: false, filters: [{ name: "Hub 数据备份", extensions: ["hubbackup"] }] });
    if (!proceed(operation) || typeof path !== "string") return;
    const result = await command<DataBackupPreview>("inspect_backup", { path, operationId: operation.id });
    if (proceed(operation)) setBackupPreview(result);
  }, true);
  const chooseRestoreDestination = () => run("正在选择恢复位置…", async operation => {
    const path = await open({ multiple: false, directory: true, title: "选择用于恢复的空文件夹" });
    if (proceed(operation) && typeof path === "string") setRestoreDestination(path);
  });
  const restoreBackup = () => {
    if (!backupPreview || !restoreDestination.trim()) return Promise.resolve();
    const preview = backupPreview, destination = restoreDestination.trim(), shouldOpen = openAfterRestore;
    return run("正在恢复并校验数据…", async operation => {
      if (!await flush(operation)) return;
      try {
        const result = await command<RestoreResult>("restore_backup", { token: preview.token, destination, openAfterRestore: shouldOpen, operationId: operation.id });
        if (!owns(operation)) return;
        setBackupPreview(null); setRestoreResult(result); setRestarting(result.restartRequired);
        setNotice(result.restartRequired ? "数据已恢复并通过校验，Hub 即将重启。" : `数据已恢复到 ${result.destination}，当前使用的数据目录未变。`);
        if (!result.restartRequired) await refreshAfterSuccess(operation);
      } catch (reason) { if (owns(operation)) setBackupPreview(null); throw reason; }
    }, true);
  };
  const changeSchedule = (patch: Partial<DataBackupSchedule>) => {
    scheduleDirty.current = true; setSchedule(current => ({ ...current, ...patch }));
  };
  const chooseScheduleDestination = () => run("正在选择自动备份位置…", async operation => {
    const path = await open({ multiple: false, directory: true, title: "选择自动备份文件的保存位置", defaultPath: schedule.destination || undefined });
    if (proceed(operation) && typeof path === "string") changeSchedule({ destination: path });
  });
  const saveSchedule = () => run("正在保存自动备份设置…", async operation => {
    if (schedule.enabled && !schedule.destination.trim()) throw new Error("请先选择自动备份位置。");
    if (!Number.isInteger(schedule.intervalHours) || schedule.intervalHours < 1 || schedule.intervalHours > 720) throw new Error("备份间隔应为 1 至 720 小时。");
    if (!Number.isInteger(schedule.keepCount) || schedule.keepCount < 1 || schedule.keepCount > 100) throw new Error("保留份数应为 1 至 100 份。");
    const result = await command<DataBackupSchedule>("save_schedule", { config: { ...schedule, destination: schedule.destination.trim() } });
    if (!owns(operation)) return;
    scheduleDirty.current = false; setSchedule(result);
    setNotice(result.enabled ? "自动备份设置已保存。" : "自动备份已关闭，已有备份文件保留。");
    await refreshAfterSuccess(operation);
  });
  const relocateDependency = (dependency: DataDependency) => run("正在更新外部目录位置…", async operation => {
    const path = await open({ multiple: false, directory: true, title: `选择“${dependency.name}”的新位置` });
    if (!proceed(operation) || typeof path !== "string") return;
    const result = await command<{ location?: string; warning?: string | null }>("relocate_dependency", { id: dependency.id, path });
    if (!owns(operation)) return;
    setDirectoryPreview(null); setBackupPreview(null);
    setNotice(`“${dependency.name}”的位置已更新。${result.warning ? ` ${result.warning}` : ""}`);
    await refreshAfterSuccess(operation);
  });
  const cancel = async () => {
    const operation = active.current;
    if (!operation?.cancellable || operation.cancelRequested) return;
    operation.cancelRequested = true; setCancelling(true);
    try { await command("cancel", { operationId: operation.id }); }
    catch (reason) { if (owns(operation)) { operation.cancelRequested = false; setCancelling(false); setError(`停止请求未完成：${message(reason)}`); } }
  };
  const reveal = async (path: string) => {
    try { await openPath(path); } catch (reason) { if (mounted.current) setError(message(reason)); }
  };
  const reload = async () => {
    if (active.current) return;
    setError("");
    try { await refresh(); } catch (reason) { if (mounted.current) setError(message(reason)); }
  };
  return {
    status, directoryPreview, backupPreview, createdBackup, restoreResult, restoreDestination, openAfterRestore,
    includeExternalSources, schedule, busy, progress, error, notice, cancelling, restarting,
    locked: blocked || Boolean(busy) || restarting || Boolean(status?.activeOperation),
    cancellable: Boolean(busy && active.current?.cancellable),
    chooseExistingDirectory, openExistingDirectory, createBackup, chooseBackup, chooseRestoreDestination, restoreBackup,
    setOpenAfterRestore, setIncludeExternalSources, changeSchedule, chooseScheduleDestination, saveSchedule,
    relocateDependency, cancel, reveal, reload,
    clearPreview: () => { setDirectoryPreview(null); setBackupPreview(null); setRestoreDestination(""); },
  };
}
