import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { useVisiblePolling } from "./useVisiblePolling";
import { SerialRefresh } from "./SerialRefresh";
import { useVisibleChange } from "./useVisibleChange";
import "./ReadingAttachments.css";
export type ReadingAttachmentState = { url: string; local: boolean; canUpload: boolean; state: string; size?: number; mime?: string; error: string; canPin?: boolean; pinned?: boolean; hash?: string; thumbnail?: boolean };
const states: Record<string, string> = { ready: "云端已校验", pending: "待上传", missing: "原设备尚未下载", skipped: "策略已跳过", unshared: "尚未上传" };
function name(url: string) { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "附件"); } catch { return "附件"; } }
export function ReadingAttachments({ itemKey }: { itemKey: string }) {
  const [items, setItems] = useState<ReadingAttachmentState[]>([]), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const generation = useRef(0);
  const refreshQueue = useRef(new SerialRefresh());
  const statusVersion = useRef(0);
  const [expanded, setExpanded] = useState(false);
  const load = useCallback((fresh = false) => {
    if (fresh) statusVersion.current++;
    const id = generation.current;
    const version = statusVersion.current;
    return refreshQueue.current.run(itemKey, async () => {
      if (generation.current !== id || statusVersion.current !== version) return;
      try {
        const rows = await invoke<ReadingAttachmentState[]>("reading_attachment_status", { key: itemKey });
        if (generation.current === id && statusVersion.current === version) { setItems(Array.isArray(rows) ? rows : []); setError(""); }
      } catch (e) { if (generation.current === id && statusVersion.current === version) setError(String(e)); }
    }, fresh);
  }, [itemKey]);
  useEffect(() => {
    generation.current++; setItems([]); setError(""); setBusy(""); setExpanded(false);
    void load(true);
    return () => { generation.current++; };
  }, [load]);
  useVisiblePolling(load, expanded, 5000);
  const refreshChanged = useCallback(() => load(true), [load]);
  useVisibleChange("hub:reading-cache-changed", refreshChanged);
  const transfer = async (item: ReadingAttachmentState, upload: boolean) => {
    if (busy) return; const id = generation.current; setBusy(item.url); setError("");
    try { await invoke("transfer_reading_attachment", { key: itemKey, url: item.url, upload });
      window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: itemKey }));
      if (generation.current === id) await load(true);
    } catch (e) { if (generation.current === id) setError(String(e)); } finally { if (generation.current === id) setBusy(""); }
  };
  const pin = async (item: ReadingAttachmentState) => {
    if (busy) return; const id = generation.current; setBusy(item.url); setError("");
    try {
      if (item.pinned) await invoke("unpin_reading_attachment", { hash: item.hash });
      else await invoke("pin_reading_attachment", { key: itemKey, url: item.url });
      if (!item.pinned) window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: itemKey }));
      window.dispatchEvent(new Event("hub:reading-cache-changed"));
    } catch (e) { if (generation.current === id) setError(String(e)); } finally { if (generation.current === id) setBusy(""); }
  };
  if (!items.length && !error) return null;
  return <details className="reading-attachments" open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}><summary>附件云副本{items.length ? ` · ${items.length}` : ""}</summary>
    <p>附件独立同步；缩略图可用不代表原视频完整，跳过、缺失或待上传不代表已完整保存。</p>
    {error && <p role="alert">{error}</p>}
    <ul>{items.map(item => <li key={item.url}><div><strong>{name(item.url)}</strong><small>{item.thumbnail ? "缩略图 · " : ""}{states[item.state] || "待检查"}{item.local ? " · 本机可用" : ""}{item.pinned ? " · 已离线保留" : ""}{item.size ? ` · ${(item.size / 1048576).toFixed(1)} MB` : ""}</small>{item.error && <small role="status">{item.error}</small>}</div><div className="reading-attachment-actions">
      {item.canUpload && <button disabled={!!busy} onClick={() => void transfer(item, true)}>{busy === item.url ? "处理中…" : item.state === "ready" ? "重新校验上传" : "上传附件"}</button>}
      {!item.canUpload && item.state === "ready" && <button disabled={!!busy} onClick={() => void transfer(item, false)}>{busy === item.url ? "处理中…" : item.local ? "校验本地附件" : "下载附件"}</button>}
      {(item.canPin || item.pinned) && <button disabled={!!busy} onClick={() => void pin(item)}>{busy === item.url ? "处理中…" : item.pinned ? "取消离线保留" : item.local ? "离线保留" : "下载并离线保留"}</button>}
    </div></li>)}</ul><button onClick={openCloudSyncSettings}>附件同步设置</button>
  </details>;
}
