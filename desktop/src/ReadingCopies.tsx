import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SerialRefresh } from "./SerialRefresh";
import { useVisiblePolling } from "./useVisiblePolling";
import { useVisibleChange } from "./useVisibleChange";
import "./ReadingAttachments.css";
export type ReadingCopyDevice = { device: string; deviceLabel: string; local: boolean; observedAt: number | null; copies: { id: string; provider: string; name: string; state: string }[] };
const states: Record<string, string> = { saved: "已有保存记录", partial: "正文已保存，附件待补齐", missing: "来源设备未找到文件", unknown: "来源设备暂无法确认文件" };
const providers: Record<string, string> = { obsidian: "Obsidian", craft: "Craft", dida365: "滴答清单" };
export function ReadingCopies({ itemKey }: { itemKey: string }) {
  const [rows, setRows] = useState<ReadingCopyDevice[]>([]), [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const generation = useRef(0), refreshQueue = useRef(new SerialRefresh());
  const statusVersion = useRef(0);
  const load = useCallback((fresh = false) => {
    if (fresh) statusVersion.current++;
    const current = generation.current;
    const version = statusVersion.current;
    return refreshQueue.current.run(itemKey, async () => {
      if (current !== generation.current || version !== statusVersion.current) return;
      try {
        const value = await invoke<ReadingCopyDevice[]>("reading_copy_status", { key: itemKey });
        if (current === generation.current && version === statusVersion.current) { setRows(Array.isArray(value) ? value : []); setError(""); }
      } catch (e) { if (current === generation.current && version === statusVersion.current) setError(String(e)); }
    }, fresh);
  }, [itemKey]);
  useEffect(() => {
    generation.current++; setRows([]); setError(""); setExpanded(false); void load(true);
    return () => { generation.current++; };
  }, [load]);
  useVisiblePolling(load, expanded, 5000);
  const refreshChanged = useCallback(() => load(true), [load]);
  useVisibleChange("hub:reading-data-changed", refreshChanged);
  if (!rows.length && !error) return null;
  return <details className="reading-attachments reading-copies" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>资料库副本记录</summary>
    <p>其他设备的记录仅供查看，不代表已在本机保存，也不保证副本包含最新正文或全部附件。</p>
    {error && <p role="status">副本记录暂不可用：{error}</p>}
    {rows.map(row => <section key={row.device}><strong>{row.local ? "本机" : row.deviceLabel}</strong>{!row.local && row.observedAt && <small>记录更新于 {new Date(row.observedAt * 1000).toLocaleString()}</small>}
      <ul>{row.copies.map(copy => <li key={copy.id}><div><strong>{copy.name}</strong><small>{providers[copy.provider] || "资料库"} · {states[copy.state] || "待确认"}</small></div></li>)}</ul>
    </section>)}
    <p>在保存副本的设备上管理。此处不提供远程打开、迁移或删除操作。</p>
  </details>;
}
