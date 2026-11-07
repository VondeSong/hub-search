import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ReadingAttachments.css";
export type ReadingOfflinePlan = {
  token: string; postHash: string; total: number; available: number; retained: number;
  downloadBytes: number; actionable: number; complete: boolean; warnings: string[]; previous: string;
  items: { url: string; state: string; bytes: number; reason: string }[];
};
type Outcome = { succeeded: number; failures: string[]; plan: ReadingOfflinePlan };
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
function filename(url: string) { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "附件"); } catch { return "附件"; } }
export function ReadingOffline({ itemKey }: { itemKey: string }) {
  const [plan, setPlan] = useState<ReadingOfflinePlan | null>(null);
  const [extras, setExtras] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++; setPlan(null); setExtras(false); setBusy(false); setError(""); setNotice("");
    return () => { generation.current++; };
  }, [itemKey]);
  const check = async () => {
    if (busy) return; const id = generation.current; setBusy(true); setError(""); setNotice(""); setPlan(null);
    try { const value = await invoke<ReadingOfflinePlan>("preview_reading_offline", { key: itemKey, includeExtras: extras }); if (generation.current === id) setPlan(value); }
    catch (e) { if (generation.current === id) setError(String(e)); }
    finally { if (generation.current === id) setBusy(false); }
  };
  const download = async () => {
    if (busy || !plan) return; const id = generation.current; setBusy(true); setError(""); setNotice("");
    try {
      const result = await invoke<Outcome>("download_reading_offline", { key: itemKey, includeExtras: extras, token: plan.token });
      if (generation.current === id) { setPlan(result.plan); setNotice(`本轮完成 ${result.succeeded} 个附件。${result.plan.complete ? "当前已同步内容已通过离线检查。" : "仍有未完成内容，请查看下方原因。"}`); setError(result.failures.join("\n")); }
      window.dispatchEvent(new CustomEvent("hub:reading-attachment-ready", { detail: itemKey }));
      window.dispatchEvent(new Event("hub:reading-cache-changed"));
    } catch (e) { if (generation.current === id) { setPlan(null); setError(String(e)); } }
    finally { if (generation.current === id) setBusy(false); }
  };
  return <details className="reading-attachments reading-offline"><summary>本文离线</summary>
    <p>检查当前已同步的正文和登记附件。已下载的缓存会离线保留，可在云同步设置中取消保留。</p>
    <label className="reading-offline-option"><input type="checkbox" checked={extras} disabled={busy} onChange={e => { setExtras(e.target.checked); setPlan(null); setError(""); setNotice(""); }} />同时下载音视频和 ZIP</label>
    <button disabled={busy} onClick={() => void check()}>{busy ? "正在检查或下载…" : "检查离线范围"}</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    {plan && <div className="reading-offline-plan">
      <p>{plan.complete ? "本次检查：当前已同步正文及登记附件可离线使用。" : `本次检查：${plan.total} 个附件中，${plan.available} 个已在本机校验，${plan.retained} 个已保留或为原设备文件。`}</p>
      {plan.previous === "interrupted" && <p role="status">上次下载被中断。已完成的附件会复用，可继续下载剩余内容。</p>}
      {plan.warnings.map(w => <p role="status" key={w}>{w}</p>)}
      {!!plan.actionable && <><p>预计需下载不超过 {size(plan.downloadBytes)} 的文件载荷；共享缓存可能减少用量，请求开销另计。仍受每轮、每日和本机缓存额度限制。</p><button disabled={busy} onClick={() => void download()}>下载并保留可用附件</button></>}
      <ul>{plan.items.map(item => <li key={item.url}><div><strong>{filename(item.url)}</strong><small>{item.reason}{item.bytes ? ` · ${size(item.bytes)}` : ""}</small></div></li>)}</ul>
    </div>}
    <p>离线范围不含缩略图、原文网站及链接页面；正文更新后需重新检查。下载遵守设置中的阅读网络策略，未限制网络时可能使用移动流量。此检查不用于删除来源内容。</p>
  </details>;
}
