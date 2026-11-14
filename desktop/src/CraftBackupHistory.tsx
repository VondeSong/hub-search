import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { formatDataPath } from "./DataManagementFormat";

type Snapshot = {
  id: string; libraryId: string; libraryName: string; startedAt: number;
  documents: unknown[]; attachments: unknown[]; limitations: string[];
  externalReferences?: unknown[];
};
type History = {
  backupRoot: string | null; snapshots: Snapshot[];
  warnings?: string[];
  reading?: {
    vaultPath: string | null; vaultExists: boolean; generatedAt: number | null;
    attempts: { id: string; libraryId: string; libraryName: string; startedAt: number; documents: number; issues: number }[];
  };
  config: { destination: string; vaultName: string; replicaDestination: string | null; intervalMinutes: number; lastError: string | null; lastSuccessAt: number | null; lastAttemptAt?: number } | null;
};
type Verification = { valid: boolean; checkedObjects: number; issues: { message: string }[] };

export function CraftBackupHistory({ libraryId, disabled = false }: { libraryId?: string; disabled?: boolean }) {
  const [history, setHistory] = useState<History | null>(null);
  const [snapshotId, setSnapshotId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [attemptId, setAttemptId] = useState("");
  const [copyPath, setCopyPath] = useState("");
  const refresh = useCallback(async () => {
    if (!libraryId) return;
    try {
      const value = await invoke<History>("craft_backup_history", { libraryId, root: null });
      setHistory(value);
      setSnapshotId(old => value.snapshots.some(s => s.id === old) ? old : value.snapshots[0]?.id || "");
    } catch (reason) { setError(String(reason)); }
  }, [libraryId]);
  useEffect(() => {
    setCopyPath(""); setAttemptId(""); setMessage(""); setError("");
    void refresh();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("craft-backup-updated", () => void refresh()).then(fn => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); };
  }, [refresh]);
  const selected = history?.snapshots.find(s => s.id === snapshotId);
  const attempt = history?.reading?.attempts.find(a => a.id === attemptId) ?? history?.reading?.attempts[0];
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setMessage(""); setError("");
    try { await action(); } catch (reason) { setError(String(reason)); } finally { setBusy(false); }
  };
  return <details className="craft-backup-history settings-category libraries">
    <summary>{libraryId ? "自动备份设置与本地恢复点" : "从已有备份生成 Obsidian 库（无需 Craft 连接）"}</summary>
    <div className="craft-backup-history-content">
      <p>只有全部原始数据和附件通过校验的备份才会成为恢复点。未完成的采集报告保存在备份目录的 attempts 文件夹中。</p>
      <div className="craft-backup-actions">
        {libraryId && <button disabled={busy || disabled} onClick={() => void run(refresh)}>刷新</button>}
        <button disabled={busy || disabled} onClick={() => void run(async () => {
          const root = await open({ directory: true, multiple: false, title: "选择含 archive.json 的 Craft 备份目录" });
          if (typeof root !== "string") return;
          const value = await invoke<History>("inspect_craft_backup", { root });
          setCopyPath(""); setAttemptId("");
          setHistory(value); setSnapshotId(value.snapshots[0]?.id || "");
          if (!value.snapshots.length) setMessage("该目录尚无完整恢复点，请查看采集报告。");
        })}>选择已有备份…</button>
      </div>
      {history?.backupRoot && <p className="library-location">原始备份目录：{formatDataPath(history.backupRoot)}</p>}
      {history?.warnings?.map((warning, index) => <p key={index} role="alert" className="vault-export-error">{warning}</p>)}
      {history?.config && <>
        <p className="library-location">自动与手动备份保存位置：{formatDataPath(history.config.destination)}</p>
        <p>原件随 Hub 数据目录保存。更改位置请使用“数据管理”中的“更改数据位置”。</p>
        <p>Obsidian 库：{history.config.vaultName}；原始备份另存于“{history.config.vaultName} - 备份”，用于核验和恢复。</p>
        <p>最近完整备份：{history.config.lastSuccessAt ? new Date(history.config.lastSuccessAt * 1000).toLocaleString() : "尚未完成"}</p>
        {!!history.config.lastAttemptAt && <p>最近采集尝试：{new Date(history.config.lastAttemptAt * 1000).toLocaleString()}（不表示已完成）</p>}
        {history.config.lastError && <p role="alert" className="vault-export-error">{history.config.lastError}</p>}
        <label>自动备份间隔 <select disabled={busy || disabled} value={history.config.intervalMinutes} onChange={e => void run(async () => {
          await invoke("set_craft_backup_interval", { libraryId, intervalMinutes: Number(e.target.value) }); await refresh();
        })}><option value={0}>仅手动</option><option value={60}>每小时</option><option value={360}>每 6 小时</option><option value={1440}>每天</option></select></label>
        <p>Hub 运行且连接可用时执行；每次核对全量内容，重复文件共用存储。旧恢复点保留，不随云端删除。</p>
        <p className="library-location">第二份备份：{history.config.replicaDestination || "尚未设置"}</p>
        <div className="craft-backup-actions"><button disabled={busy || disabled} onClick={() => void run(async () => {
          const destination = await open({ directory: true, multiple: false, title: "选择第二份备份位置" });
          if (typeof destination !== "string") return;
          await invoke("set_craft_backup_replica", { libraryId, destination });
          await refresh(); setMessage("第二份备份位置已设置，将在下次完整备份时生成并核验。");
        })}>设置第二份备份…</button>
        {history.config.replicaDestination && <button disabled={busy || disabled} onClick={() => void run(async () => {
          await invoke("set_craft_backup_replica", { libraryId, destination: null });
          await refresh(); setMessage("已停止更新第二份备份，原有文件保留。");
        })}>停止更新第二份备份</button>}</div>
      </>}
      {history?.reading?.vaultPath && <>
        <p className="library-location">正常阅读库实际路径：{formatDataPath(history.reading.vaultPath)}</p>
        <p>{history.reading.vaultExists ? `已找到阅读库；生成时间：${history.reading.generatedAt ? new Date(history.reading.generatedAt * 1000).toLocaleString() : "旧版本未记录"}。文件存在不等于完整性已核验。` : "当前配置路径未找到已生成的阅读库；不会将旧位置副本当作当前版本。"}</p>
        <button disabled={busy || disabled || !history.reading.vaultExists} onClick={() => void run(async () => {
          await invoke("open_craft_export_in_obsidian", { path: history.reading!.vaultPath });
        })}>打开正常阅读库</button>
      </>}
      {!!history?.reading?.attempts.length && <section aria-label="有缺项的独立阅读副本">
        <h4>阅读已保存内容（有缺项）</h4>
        <p>独立副本不是完整备份，不替换正常阅读库，不更改自动备份设置。仅输出通过校验的正文与可用原件；缺失附件会在正文附近提示，未解析链接保留并报告。</p>
        <label>选择未完成采集 <select disabled={busy || disabled} value={attempt?.id ?? ""} onChange={e => { setAttemptId(e.target.value); setCopyPath(""); setMessage(""); }}>
          {history.reading.attempts.map(a => <option key={a.id} value={a.id}>{a.libraryName} · {new Date(a.startedAt * 1000).toLocaleString()} · {a.documents} 页 / {a.issues} 条待核对记录</option>)}
        </select></label>
        <button disabled={busy || disabled || !attempt} onClick={() => void run(async () => {
          const destination = await open({ directory: true, multiple: false, title: "选择独立阅读副本的父目录（不覆盖正常库）" });
          if (typeof destination !== "string") return;
          const result = await invoke<{ destination: string; backupComplete: boolean; exportedDocuments: number; skippedDocuments: number; failedAttachments: number; conflicts: number }>("export_craft_reading_copy", {
            root: history.backupRoot, attemptId: attempt!.id, libraryId: attempt!.libraryId, destination,
          });
          if (result.backupComplete) throw new Error("阅读副本返回了不一致的完整性状态，请查看报告。");
          setCopyPath(result.destination);
          setMessage(`独立阅读副本已生成：${result.exportedDocuments + result.skippedDocuments} 页，${result.failedAttachments} 件附件不可用，${result.conflicts} 项本地修改已保护。缺项以副本说明和导出报告为准；这不是完整恢复点。`);
        })}>生成阅读副本（有缺项）…</button>
        {copyPath && <><p className="library-location">独立阅读副本：{formatDataPath(copyPath)}</p><button disabled={busy || disabled} onClick={() => void run(async () => { await invoke("open_craft_export_in_obsidian", { path: copyPath }); })}>打开阅读副本（有缺项）</button></>}
        <p>集合为静态内容与原始资料，白板需 Excalidraw；不能完整还原 Craft 布局与交互。重复生成保留本地修改，冲突内容另存为“Craft 更新”。</p>
      </section>}
      {!!history?.snapshots.length && <>
        {!!selected?.externalReferences?.length && <p role="status">该恢复点有 {selected.externalReferences.length} 项外部服务引用：保留原始地址，不含对应外部网页或服务资料。</p>}
        <label>选择恢复点 <select disabled={busy || disabled} value={snapshotId} onChange={e => { setSnapshotId(e.target.value); setMessage(""); }}>
          {history.snapshots.map(s => <option key={s.id} value={s.id}>{s.libraryName} · {new Date(s.startedAt * 1000).toLocaleString()} · {s.documents.length} 页 / {s.attachments.length} 附件</option>)}
        </select></label>
        <div className="craft-backup-actions">
          {history.config && <button disabled={busy || disabled || !selected} onClick={() => void run(async () => {
            const result = await invoke<{ destination: string; issues: { message: string }[] }>("restore_craft_backup", {
              root: history.backupRoot, snapshotId, useConfiguredDestination: true,
              options: { libraryId: selected!.libraryId, destination: history.config!.destination, vaultName: history.config!.vaultName },
            });
            if (result.issues.length) throw new Error(`Obsidian 库已生成，有项目待处理：${result.issues.map(i => i.message).join("；")}`);
            setMessage(`Obsidian 库已更新：${result.destination}。自动备份设置不变。`);
          })}>生成 Obsidian 库（原位置）</button>}
          <button disabled={busy || disabled || !selected} onClick={() => void run(async () => {
            const result = await invoke<Verification>("verify_craft_backup", { root: history.backupRoot, snapshotId, libraryId: selected!.libraryId });
            if (!result.valid) throw new Error(`核验失败：${result.issues.map(i => i.message).join("；")}`);
            setMessage(`核验通过，${result.checkedObjects} 个原始文件完整。`);
          })}>核验原始备份</button>
          <button disabled={busy || disabled || !selected} onClick={() => void run(async () => {
            const destination = await open({ directory: true, multiple: false, title: "选择 Obsidian 库副本的保存位置" });
            if (typeof destination !== "string") return;
            const result = await invoke<{ destination: string; issues: { message: string }[] }>("restore_craft_backup", {
              root: history.backupRoot, snapshotId, useConfiguredDestination: false,
              options: { libraryId: selected!.libraryId, destination, vaultName: `${selected!.libraryName} - Obsidian 副本 - ${snapshotId}`,
                includeImages: true, includeVideos: true, includeOtherAttachments: true, exportDailyNotes: true, createObsidianConfig: true },
            });
            if (result.issues.length) throw new Error(`副本已生成，有项目待处理：${result.issues.map(i => i.message).join("；")}`);
            setMessage(`Obsidian 库副本已生成：${result.destination}。自动备份位置不变。`);
          })}>生成 Obsidian 库（另存为）…</button>
        </div>
        <p>生成 Obsidian 库只读取已核验的本地恢复点，无需联网。原位置会保留本地修改；另存为生成额外副本，不更改自动备份设置。</p>
        {libraryId && <p>已校验的备份附件也供 Hub 本地预览使用，无需重复下载。文件附件打开时使用工作副本，保留备份原件。</p>}
      </>}
      {busy && <p role="status">正在处理，请保持 Hub 运行…</p>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="vault-export-error">{error}</p>}
    </div>
  </details>;
}
