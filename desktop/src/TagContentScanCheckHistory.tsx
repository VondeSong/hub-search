import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";

type Entry = { checkpointId: number; checkedAt?: number; version: number; stale: boolean; reachedEndAtCheck: boolean;
  items: { ordinal: number; title: string; assessment?: { reason: string; canReopen: boolean } }[] };
type Page = { entries: Entry[]; nextCursor: string | null };
export function TagContentScanCheckHistory({ runId }: { runId: string }) {
  const [page, setPage] = useState<Page | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (cursor?: string) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); const n = generation.current;
    try {
      const result = await invoke<Page>("tag_assignment", { args: { action: "scan_check_history", runId, limit: 5, ...(cursor ? { cursor } : {}) } });
      if (n === generation.current) setPage(old => ({ ...result, entries: cursor && old ? [...old.entries, ...result.entries.filter(e => !old.entries.some(o => o.checkpointId === e.checkpointId))] : result.entries }));
    } catch (e) { if (n === generation.current) setError(String(e)); }
    finally { if (n === generation.current) { lock.current = false; setBusy(false); } }
  };
  return <details><summary>历史检查批次</summary>
    <p>只读查看已保存批次，不重新核对正文。每批结果仅代表当时状态，重复检查同一项不等于新增覆盖；需要继续时请恢复最新检查。</p>
    <button type="button" disabled={busy} onClick={() => void load()}>刷新检查历史</button>
    {page && !page.entries.length && <p>尚无保存的检查批次。</p>}
    {page?.entries.map(e => <details key={e.checkpointId}>
      <summary>批次 #{e.checkpointId} · {e.checkedAt ? new Date(e.checkedAt * 1000).toLocaleString("zh-CN") : "时间未知"} · {e.items.length} 项</summary>
      <p>检查时任务版本 {e.version} · {e.stale ? "任务或定义已变化" : "历史结果，未重新核验"} · {e.reachedEndAtCheck ? "当时检查至末尾" : "当时仍有未检查项"}</p>
      <ul>{e.items.map(i => <li key={i.ordinal}>{i.title} · #{i.ordinal}<p>{i.assessment?.reason ?? "未保存判断说明"}</p></li>)}</ul>
    </details>)}
    {page?.nextCursor && <button type="button" disabled={busy} onClick={() => void load(page.nextCursor!)}>加载更早检查批次</button>}
    {busy && <p role="status">正在读取检查历史…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}
