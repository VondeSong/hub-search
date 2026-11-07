import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Download, History, LoaderCircle, Upload } from "lucide-react";

type Backup = {
  path: string; checksum: string; createdAt: number; cards: number;
  reviews: number; attachments: number; profiles: number; externalLinks: number; bytes: number;
};
type BackupHistory = { items: Backup[]; issues: { path: string; error: string }[] };
type BackupOperation = { id: string; cancelled: boolean; nativeRunning: boolean };
const cancelledMessage = "BACKUP_CANCELLED:本次操作已停止；已经完成的本机备份仍会保留。";
const newOperation = (): BackupOperation => ({ id: crypto.randomUUID(), cancelled: false, nativeRunning: false });

export function FlashcardBackup({ disabled, onRestored }: { disabled: boolean; onRestored: () => Promise<void> }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Backup | null>(null);
  const [history, setHistory] = useState<Backup[]>([]);
  const [historyIssues, setHistoryIssues] = useState<BackupHistory["issues"]>([]);
  const [cancelling, setCancelling] = useState(false);
  const running = useRef<BackupOperation | null>(null);
  const mounted = useRef(false);
  const call = async <T,>(operation: BackupOperation, command: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (operation.cancelled) throw new Error(cancelledMessage);
    operation.nativeRunning = true;
    try { return await invoke<T>(command, { ...args, operationId: operation.id }); }
    finally { operation.nativeRunning = false; }
  };
  const checkpoint = (operation: BackupOperation) => {
    if (operation.cancelled || !mounted.current) throw new Error(cancelledMessage);
  };
  const cancel = async (operation: BackupOperation) => {
    operation.cancelled = true;
    // A cancellation arriving before native admission may return false. Retry
    // only while this exact request remains pending; its result owns completion.
    for (let attempt = 0; operation.nativeRunning && attempt < 3; attempt += 1) {
      const accepted = await invoke<boolean>("cancel_flashcard_backup", { operationId: operation.id });
      if (accepted || !operation.nativeRunning) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const refresh = async (operation: BackupOperation) => {
    const result = await call<BackupHistory>(operation, "list_flashcard_backups");
    checkpoint(operation);
    setHistory(result.items); setHistoryIssues(result.issues);
  };
  useEffect(() => {
    mounted.current = true;
    const historyOperation = newOperation();
    void refresh(historyOperation).catch(e => {
      if (mounted.current && !historyOperation.cancelled) setError(String(e));
    });
    return () => {
      mounted.current = false;
      void cancel(historyOperation).catch(() => {});
      if (running.current) void cancel(running.current).catch(() => {});
    };
  }, []);
  const run = async (label: string, action: (operation: BackupOperation) => Promise<void>) => {
    if (running.current) return;
    const operation = newOperation();
    running.current = operation; setBusy(label); setCancelling(false); setError(""); setNotice("");
    try { await action(operation); }
    catch (e) {
      if (mounted.current) {
        if (String(e).includes("BACKUP_CANCELLED:")) setNotice("本次操作已停止；已经完成的本机备份仍会保留。");
        else setError(String(e));
      }
    }
    finally {
      if (mounted.current) { setBusy(""); setCancelling(false); }
      running.current = null;
    }
  };
  const exportFile = async (backup: Backup, operation: BackupOperation) => {
    checkpoint(operation);
    const android = document.documentElement.dataset.runtimePlatform === "android";
    const destination = android ? "" : await save({
      defaultPath: `Hub闪卡备份-${backup.createdAt}.hubfc`, filters: [{ name: "Hub 闪卡备份", extensions: ["hubfc"] }],
    });
    checkpoint(operation);
    if (destination === null) { setNotice("备份已保存在本机，可从下方再次导出。"); return; }
    await call(operation, "save_flashcard_backup", { path: backup.path, destination });
    if (!mounted.current) return;
    setNotice(android ? "本机备份已完成，请在系统对话框中完成另存。" : "完整备份已导出并通过校验。");
  };
  const locked = disabled || Boolean(busy);
  return <section className="flashcards-sync-status-card" aria-label="闪卡备份与恢复">
    <div className="flashcards-sync-section-heading"><strong><History size={16} /> 备份与恢复</strong></div>
    <p>将卡片、收件箱、附件、完整复习历史和算法参数保存为独立文件。备份不包含云端密码。</p>
    <div className="flashcards-sync-actions">
      <button disabled={locked} onClick={() => void run("正在生成完整备份…", async operation => {
        const backup = await call<Backup>(operation, "create_flashcard_backup");
        await exportFile(backup, operation);
        if (!operation.cancelled && mounted.current) await refresh(operation).catch(e => { checkpoint(operation); setError(`备份已生成；历史记录暂时无法读取：${String(e)}`); });
      })}><Download size={16} />备份到文件</button>
      <button disabled={locked} onClick={() => void run("正在校验备份…", async operation => {
        const path = await open({ multiple: false, directory: false, filters: [{ name: "Hub 闪卡备份", extensions: ["hubfc"] }] });
        checkpoint(operation);
        if (!path) return;
        const inspected = await call<Backup>(operation, "inspect_flashcard_backup", { path });
        checkpoint(operation); setPreview(inspected);
        await refresh(operation);
      })}><Upload size={16} />从文件恢复</button>
    </div>
    {busy && <div><p role="status"><LoaderCircle className="spin" size={16} />{cancelling ? "正在停止操作…如果系统文件对话框仍打开，请关闭它。" : busy}</p>
      <button disabled={cancelling} onClick={() => {
        const operation = running.current; if (!operation) return;
        setCancelling(true);
        void cancel(operation).catch(e => { if (mounted.current) setError(`停止请求未完成：${String(e)}`); });
      }}>停止操作</button></div>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {preview && <div className="flashcards-sync-feedback">
      <strong>确认合并恢复</strong>
      <p>{new Date(preview.createdAt * 1000).toLocaleString()} · {preview.cards} 张卡片 · {preview.reviews} 次复习 · {preview.attachments} 个附件 · {preview.profiles} 组算法参数</p>
      <p>恢复前会自动备份本机。较新的内容、复习记录、删除和撤销标记会保留；不会回退到旧时间点。当前暂停轮次将结束，已保存的评分保留。恢复后可正常同步。</p>
      {preview.externalLinks > 0 && <p>另有 {preview.externalLinks} 个外部附件链接，仅保存地址，离线时可能无法打开。</p>}
      <div className="flashcards-sync-actions">
        <button disabled={locked} onClick={() => setPreview(null)}>取消恢复</button>
        <button className="primary" disabled={locked} onClick={() => void run("正在恢复并重算学习状态…", async operation => {
          await call(operation, "restore_flashcard_backup", { path: preview.path, checksum: preview.checksum });
          // Native success means its terminal transaction won the cancellation
          // barrier. Always refresh that committed state, even after a stop click.
          if (!mounted.current) return;
          setPreview(null);
          setNotice("恢复已完成；恢复前备份已保留在本机。");
          await onRestored();
          if (!operation.cancelled) { checkpoint(operation); await refresh(operation); }
        })}>确认恢复</button>
      </div>
    </div>}
    <details className="flashcards-sync-help"><summary>本机备份与恢复前备份（最近 10 份）</summary>
      <p>本机文件仍可能随设备损坏丢失，请另存到其他设备或备份位置。文件未加密，请妥善保管。较早文件仍保留在本机。</p>
      {history.length === 0 ? <p>尚无备份。</p> : history.map(item => <div key={item.path}>
        <p>{item.path.split(/[\\/]/).pop()?.startsWith("before-restore-") ? "恢复前备份 · " : "备份 · "}{new Date(item.createdAt * 1000).toLocaleString()} · {item.cards} 卡 · {(item.bytes / 1048576).toFixed(1)} MB</p>
        {item.externalLinks > 0 && <p>{item.externalLinks} 个外部链接未下载，仅保留地址。</p>}
        <div className="flashcards-sync-actions"><button disabled={locked} onClick={() => void run("正在导出备份…", operation => exportFile(item, operation))}>另存为</button><button disabled={locked} onClick={() => { setPreview(item); setError(""); setNotice(""); }}>恢复此备份</button></div>
      </div>)}
      {historyIssues.map(item => <p key={item.path} role="alert">{item.path.split(/[\\/]/).pop()}：无法使用此备份（{item.error}）。其他完整备份仍可导出和恢复，原文件已保留。</p>)}
    </details>
  </section>;
}
