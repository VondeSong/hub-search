import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { publishCodexNotice } from "./CodexSuite";
import type { LibrarySyncHealth } from "./IndexStatusTypes";
import type { LibrarySummary } from "./SearchTypes";
import { useVisiblePolling } from "./useVisiblePolling";

export type LibraryRuntime = {
  libraryId: string;
  state: "idle" | "running" | "pausing" | "paused" | "cancelled" | "removing" | "removed" | "failed";
  phase: string;
  detail: string;
  activeOperations: number;
  pending: number;
  updatedAt: number;
  lastError?: string;
};
export type LibraryContentPolicy = {
  imageDownload: boolean;
  imageOcr: boolean;
  pdfDownload: boolean;
  pdfText: boolean;
  pdfOcr: boolean;
  otherDownload: boolean;
  outgoingAttachments: boolean;
};
export type LibraryContentOverrides = { [K in keyof LibraryContentPolicy]: boolean | null };
export type LibraryPolicySnapshot = {
  libraryId: string | null;
  provider: "global" | "craft" | "obsidian" | "dida365" | "feishu";
  global: LibraryContentPolicy;
  overrides: LibraryContentOverrides;
  effective: LibraryContentPolicy;
  capabilities: LibraryContentPolicy;
};
export type LibraryAddOptions = { startNow: boolean; contentPolicy: LibraryContentOverrides };
export type CollectionStorageSnapshot = { config: { mode: "database" | "obsidian"; vaultPath: string } };
export function libraryRemovalPrompt(space: Pick<LibrarySummary, "name" | "provider" | "location">, storage?: CollectionStorageSnapshot): string {
  const base = `移除“${space.name}”及其本地索引？原资料库中的内容不会被删除。`;
  if (!storage?.config) return `${base}\n\n无法读取收藏保存配置；默认位置设置保持原样，移除资料库不会停止向默认位置保存新收藏。`;
  const normalize = (path: string) => path.trim().replace(/\\/g, "/").replace(/^\/\/\?\//, "").replace(/\/+$/, "").toLowerCase();
  if (space.provider === "obsidian" && storage.config.mode === "obsidian" && space.location && normalize(storage.config.vaultPath) && normalize(space.location) === normalize(storage.config.vaultPath)) {
    return `${base}\n\n此路径仍是收藏默认保存位置，移除后仍会保存新收藏；如需停止，请修改收藏保存设置。`;
  }
  return base;
}
export const INHERIT_LIBRARY_POLICY: LibraryContentOverrides = {
  imageDownload: null, imageOcr: null, pdfDownload: null, pdfText: null, pdfOcr: null, otherDownload: null, outgoingAttachments: null,
};
export function libraryPhaseLabel(phase: string): string {
  return ({ starting: "准备开始", queued: "等待处理", listing: "读取目录", fetching: "读取正文与附件", committing: "保存本地数据", indexing: "更新搜索索引", idle: "等待下次同步", stopping: "正在暂停", paused: "已暂停", removing: "清理本地索引", removed: "已移除", failed: "需要处理" } as Record<string, string>)[phase] || "处理中";
}
export function libraryRuntimeLabel(runtime?: LibraryRuntime): string {
  if (!runtime) return "正在读取状态";
  if (runtime.state === "removing") return "正在移除本地索引";
  if (runtime.state === "removed") return "已移除";
  if (runtime.state === "pausing") return "正在暂停 · 当前步骤完成后停止";
  if (runtime.state === "paused" || runtime.state === "cancelled") return "已暂停";
  if (runtime.state === "failed") return "需要处理";
  if (runtime.state === "running") return runtime.detail || libraryPhaseLabel(runtime.phase);
  return runtime.detail || "等待下次同步";
}
export function reconcileLibraryCounts(spaces: LibrarySummary[], health: LibrarySyncHealth[]): LibrarySummary[] {
  const byId = new Map(health.map(item => [item.libraryId, item]));
  let changed = false;
  const next = spaces.map(space => {
    const actual = byId.get(space.id);
    if (!actual) return space;
    const lastSync = actual.lastSync ?? space.lastSync;
    if (space.documentCount === actual.documentCount && space.lastSync === lastSync) return space;
    changed = true;
    return { ...space, documentCount: actual.documentCount, lastSync };
  });
  return changed ? next : spaces;
}

export function useLibraryManagement(enabled: boolean, onRemoved: () => void | Promise<unknown>) {
  const [libraries, setLibraries] = useState<Record<string, LibraryRuntime>>({});
  const [accepting, setAccepting] = useState<Record<string, boolean>>({});
  const previous = useRef<Record<string, LibraryRuntime>>({});
  const onRemovedRef = useRef(onRemoved);
  onRemovedRef.current = onRemoved;
  const apply = useCallback((snapshots: LibraryRuntime[]) => {
    const next = { ...previous.current };
    let removed = false;
    let changed = false;
    for (const snapshot of snapshots) {
      const old = next[snapshot.libraryId];
      if (old && snapshot.updatedAt < old.updatedAt) continue;
      if (old && JSON.stringify(old) === JSON.stringify(snapshot)) continue;
      changed = true;
      next[snapshot.libraryId] = snapshot;
      if (snapshot.lastError && snapshot.lastError !== old?.lastError && (snapshot.state === "failed" || snapshot.state === "removing")) {
        publishCodexNotice(snapshot.state === "removing" ? `移除失败：${snapshot.lastError}；可在“更多”中重试移除` : snapshot.lastError, "error", 10000);
      }
      if (old?.state !== snapshot.state) {
        if (snapshot.state === "failed" && !snapshot.lastError) publishCodexNotice(snapshot.detail || "资料库处理失败", "error", 10000);
        if (snapshot.state === "removed") { removed = true; publishCodexNotice("资料库本地索引已移除，原内容保留", "success"); }
      }
    }
    if (!changed) return;
    previous.current = next;
    setLibraries(next);
    if (removed) void Promise.resolve(onRemovedRef.current()).catch(reason => publishCodexNotice(String(reason), "error", 10000));
  }, []);
  const refresh = useCallback(async () => {
    const status = await invoke<{ libraries: LibraryRuntime[] }>("library_control", { args: { action: "status" } });
    apply(status.libraries);
  }, [apply]);
  useVisiblePolling(refresh, enabled, 2000);
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen<LibraryRuntime>("library-runtime-updated", event => { if (!stopped) apply([event.payload]); }).then(fn => { if (stopped) fn(); else unlisten = fn; }).catch(() => undefined);
    return () => { stopped = true; unlisten?.(); };
  }, [enabled, apply]);
  const act = useCallback(async (libraryId: string, action: "pause" | "resume" | "cancel" | "remove" | "sync") => {
    if (action === "sync" && ["paused", "pausing", "cancelled", "removing", "removed"].includes(previous.current[libraryId]?.state || "")) {
      const reason = new Error("此资料库已暂停或正在移除，请先继续后再同步");
      publishCodexNotice(reason.message, "warning", 6000);
      throw reason;
    }
    setAccepting(old => ({ ...old, [libraryId]: true }));
    try {
      const snapshot = action === "sync"
        ? await invoke<LibraryRuntime>("start_library_sync", { libraryId })
        : await invoke<LibraryRuntime>("library_control", { args: { action, libraryId } });
      apply([snapshot]);
      publishCodexNotice(action === "sync" ? "同步请求已提交，后台继续处理" : action === "remove" ? "移除已受理，正在清理本地索引；原内容保留" : action === "resume" ? "资料库已继续处理" : action === "cancel" ? "已取消当前处理，资料库保持暂停" : "暂停请求已提交", "success");
      return snapshot;
    } catch (reason) {
      publishCodexNotice(String(reason), "error", 10000);
      throw reason;
    } finally { setAccepting(old => ({ ...old, [libraryId]: false })); }
  }, [apply]);
  return { libraries, accepting, refresh, act };
}
