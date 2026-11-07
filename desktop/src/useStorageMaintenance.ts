import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import type { LibrarySummary } from "./SearchTypes";
import type { ObsidianWatchStatus } from "./IndexStatusTypes";
import type { CraftVaultExportRequest } from "./ManagedSpacesSection";
import { runtimeCapabilities } from "./RuntimePlatform";
import { flushUserProfileStorage } from "./UserProfileStorage";
export type CraftVaultExportProgress = {
  libraryId: string;
  phase: "capture" | "preparing" | "documents" | "attachments" | "completed";
  completed: number;
  total: number;
  current: string;
};
type CraftVaultExportSummary = {
  destination: string;
  vaultName: string;
  exportedDocuments: number;
  skippedDocuments: number;
  exportedAttachments: number;
  skippedAttachments: number;
  conflicts: number;
  failedAttachments: number;
  backupRoot: string;
  snapshotId: string;
  backupComplete: boolean;
  issues: { category: string; message: string }[];
  replicaPath: string | null;
  externalReferences: number;
};
export type StorageInfo = {
  mode: "default" | "custom" | "portable";
  path: string;
  defaultPath: string;
  portablePath: string;
  sizeBytes: number;
  fileCount: number;
  lastError?: string;
};
type StorageChangeResult = { restartRequired: boolean };
type CleanupSummary = { removedBlobs: number; removedGenerations: number; removedTemporaryFiles: number; removedJobs: number };

export function useStorageMaintenance({ statusSpaceId, refreshStatus, settingsOpen }: {
  statusSpaceId: string | null;
  refreshStatus: () => Promise<unknown> | void;
  settingsOpen: boolean;
}) {
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [storageMode, setStorageMode] = useState<StorageInfo["mode"]>("default");
  const [storageCustomPath, setStorageCustomPath] = useState("");
  const [changingStorage, setChangingStorage] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [retryingOcr, setRetryingOcr] = useState(false);
  const [retryingFailedJobs, setRetryingFailedJobs] = useState(false);
  const [dismissingFailedJobs, setDismissingFailedJobs] = useState(false);
  const [restartingWatcher, setRestartingWatcher] = useState("");
  const [exportingLibraryId, setExportingLibraryId] = useState("");
  const [exportProgress, setExportProgress] = useState<CraftVaultExportProgress | null>(null);
  const [lastExportPath, setLastExportPath] = useState("");
  const [exportError, setExportError] = useState("");
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const refreshStorageInfo = useCallback(async () => {
    try {
      const info = await invoke<StorageInfo>("get_storage_info");
      setStorageInfo(info);
      setStorageMode(info.mode);
      if (info.mode === "custom") setStorageCustomPath(info.path);
      if (info.lastError) setMaintenanceMessage(`数据存储提示：${info.lastError}`);
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    }
  }, []);

  const chooseStorageFolder = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "选择 Hub 数据文件夹",
        defaultPath: storageCustomPath || storageInfo?.path,
      });
      if (typeof selected === "string") {
        setStorageMode("custom");
        setStorageCustomPath(selected);
      }
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    }
  }, [storageCustomPath, storageInfo?.path]);

  const applyStorageLocation = useCallback(async () => {
    const target = storageMode === "default"
      ? storageInfo?.defaultPath
      : storageMode === "portable"
        ? storageInfo?.portablePath
        : storageCustomPath.trim();
    if (!target) {
      setMaintenanceMessage("请先选择自定义数据文件夹。");
      return;
    }
    const confirmed = window.confirm(
      `将把当前数据复制到：\n${target}\n\n程序会自动重启并在启动前校验数据。原目录会保留，迁移期间请勿关闭程序。`,
    );
    if (!confirmed) return;
    setChangingStorage(true);
    setMaintenanceMessage("正在准备数据迁移，程序即将重启…");
    try {
      await flushUserProfileStorage();
      setMaintenanceMessage("程序将在新位置整理原件、校验软件数据并完成切换…");
      const result = await invoke<StorageChangeResult>("change_storage_location", {
        mode: storageMode,
        customPath: storageMode === "custom" ? storageCustomPath.trim() : null,
      });
      if (!result.restartRequired) {
        setMaintenanceMessage("当前已经使用这个数据目录。");
        await refreshStorageInfo();
        setChangingStorage(false);
      }
    } catch (reason) {
      setMaintenanceMessage(String(reason));
      setChangingStorage(false);
    }
  }, [refreshStorageInfo, storageCustomPath, storageInfo?.defaultPath, storageInfo?.portablePath, storageMode]);

  const revealStorageLocation = useCallback(async () => {
    await invoke<void>("open_storage_directory");
  }, []);

  const openExportPath = useCallback(async () => {
    if (lastExportPath) await openPath(lastExportPath);
  }, [lastExportPath]);

  const cleanupLocalData = useCallback(async () => {
    setCleaning(true);
    setMaintenanceMessage("");
    try {
      const summary = await invoke<CleanupSummary>("run_cleanup");
      setMaintenanceMessage(`已清理 ${summary.removedBlobs} 个无引用 Blob、${summary.removedGenerations} 个旧索引、${summary.removedTemporaryFiles} 个临时文件和 ${summary.removedJobs} 条已完成任务。`);
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    } finally {
      setCleaning(false);
    }
  }, []);

  const retryFailedOcr = useCallback(async () => {
    setRetryingOcr(true);
    setMaintenanceMessage("");
    try {
      const retried = await invoke<number>("retry_failed_ocr", { spaceId: statusSpaceId });
      setMaintenanceMessage(retried ? `已重新排队 ${retried} 个失败 OCR 页面。` : "当前没有可重试的 OCR 页面。");
      await refreshStatus();
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    } finally {
      setRetryingOcr(false);
    }
  }, [statusSpaceId, refreshStatus]);

  const retryFailedJobs = useCallback(async (options?: { excludeDownloads?: boolean }) => {
    setRetryingFailedJobs(true);
    setMaintenanceMessage("");
    try {
      const retried = await invoke<number>("retry_failed_index", { spaceId: statusSpaceId, ...(options?.excludeDownloads !== undefined ? { excludeDownloads:options.excludeDownloads } : {}) });
      setMaintenanceMessage(retried ? `已重新排队 ${retried} 个失败任务。` : "当前没有可重试的失败任务。");
      await refreshStatus();
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    } finally {
      setRetryingFailedJobs(false);
    }
  }, [statusSpaceId, refreshStatus]);

  const dismissFailedJobs = useCallback(async (options?: { excludeDownloads?: boolean }) => {
    if (!window.confirm("忽略后将不再显示这些失败任务，但不会删除原文档或附件。确定继续吗？")) return;
    setDismissingFailedJobs(true);
    setMaintenanceMessage("");
    try {
      const dismissed = await invoke<number>("dismiss_failed_index", { spaceId: statusSpaceId, ...(options?.excludeDownloads !== undefined ? { excludeDownloads:options.excludeDownloads } : {}) });
      setMaintenanceMessage(dismissed ? `已忽略 ${dismissed} 个失败任务；原始资料仍然保留。` : "当前没有可忽略的失败任务。");
      await refreshStatus();
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    } finally {
      setDismissingFailedJobs(false);
    }
  }, [statusSpaceId, refreshStatus]);

  const restartWatcher = useCallback(async (space: LibrarySummary) => {
    setRestartingWatcher(space.id);
    setMaintenanceMessage("");
    try {
      await invoke<ObsidianWatchStatus>("restart_obsidian_watcher", { libraryId: space.id });
      setMaintenanceMessage(`已重新建立“${space.name}”的文件监听。`);
      await refreshStatus();
    } catch (reason) {
      setMaintenanceMessage(String(reason));
    } finally {
      setRestartingWatcher("");
    }
  }, [refreshStatus]);

  const chooseExportDirectory = useCallback(async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Obsidian Vault 的保存位置",
    });
    return typeof selected === "string" ? selected : undefined;
  }, []);

  const exportCraftVault = useCallback(async (space: LibrarySummary, request: CraftVaultExportRequest): Promise<boolean> => {
    setMaintenanceMessage("");
    setExportError("");
    setLastExportPath("");
    setExportingLibraryId(space.id);
    setExportProgress({ libraryId: space.id, phase: "preparing", completed: 0, total: 0, current: "正在获取最新 Craft 内容…" });
    try {
      const summary = await invoke<CraftVaultExportSummary>("export_craft_vault", {
        options: {
          libraryId: space.id,
          destination: request.destination,
          vaultName: request.vaultName,
          includeImages: request.includeImages,
          includeVideos: request.includeVideos,
          includeOtherAttachments: request.includeOtherAttachments,
          exportDailyNotes: request.exportDailyNotes,
          createObsidianConfig: true,
          backupIntervalMinutes: request.backupIntervalMinutes,
          replicaDestination: request.replicaDestination || null,
        },
      });
      setLastExportPath(summary.destination);
      const conflictText = summary.conflicts ? `；保留 ${summary.conflicts} 个本地修改并生成 Craft 更新副本` : "";
      const failedText = summary.failedAttachments ? `；${summary.failedAttachments} 个附件下载失败` : "";
      let message = `原始备份已核验（${summary.snapshotId}）。“${summary.vaultName}”：${summary.exportedDocuments} 篇页面、${summary.exportedAttachments} 个附件；${summary.skippedDocuments + summary.skippedAttachments} 个项目未变化${conflictText}${failedText}。`;
      if (summary.issues.length) setExportError(summary.issues.map(issue => issue.message).join("；"));
      if (summary.replicaPath) message += " 第二份备份已核验。";
      if (summary.externalReferences) message += ` ${summary.externalReferences} 项外部服务引用仅保留地址，不含对应服务资料。`;
      if (request.openAfterExport && !summary.failedAttachments) {
        try {
          await invoke("open_craft_export_in_obsidian", { path: summary.destination });
        } catch (reason) {
          message += ` Vault 已创建，但未能自动打开 Obsidian：${String(reason)}`;
        }
      }
      setMaintenanceMessage(message);
      return summary.issues.length === 0;
    } catch (reason) {
      setExportError(String(reason));
      return false;
    } finally {
      setExportingLibraryId("");
      setExportProgress(null);
    }
  }, []);

  const openExportInObsidian = useCallback(async () => {
    if (!lastExportPath) return;
    setExportError("");
    try {
      await invoke("open_craft_export_in_obsidian", { path: lastExportPath });
    } catch (reason) {
      setExportError(String(reason));
    }
  }, [lastExportPath]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<CraftVaultExportProgress>("craft-vault-export-progress", (event) => {
      if (!disposed) setExportProgress(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);


  useEffect(() => {
    if (settingsOpen && runtimeCapabilities.customStorageLocation) void refreshStorageInfo();
  }, [refreshStorageInfo, settingsOpen]);
  return {
    storageInfo, storageMode, setStorageMode, storageCustomPath, setStorageCustomPath,
    changingStorage, refreshStorageInfo, chooseStorageFolder, applyStorageLocation,
    revealStorageLocation, cleaning, cleanupLocalData, retryingOcr, retryFailedOcr,
    retryingFailedJobs, retryFailedJobs, dismissingFailedJobs, dismissFailedJobs,
    restartingWatcher, restartWatcher, exportingLibraryId, exportProgress,
    lastExportPath, exportError, exportCraftVault, chooseExportDirectory, openExportInObsidian, openExportPath,
    maintenanceMessage, setMaintenanceMessage,
  };
}
