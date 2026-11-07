import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./ReadingAttachments.css";

export type ReadingRecoveryPlan = {
  token: string;
  postHash: string;
  total: number;
  downloadBytes: number;
  actionable: boolean;
  warnings: string[];
  items: { url: string; state: string; bytes: number; reason: string }[];
  previous: string;
  checkedAt: number;
};
export type ReadingRecoveryOutcome = {
  plan: ReadingRecoveryPlan;
  bodyVerified: boolean;
  verified: number;
  complete: boolean;
  checkedAt: number;
  failures: string[];
};
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
function filename(url: string) {
  try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "附件"); }
  catch { return "附件"; }
}
const previous: Record<string, string> = {
  interrupted: "上次检查被中断。请重新检查当前范围后继续。",
  running: "上次检查被中断。请重新检查当前范围后继续。",
  complete: "已有上次检查记录；本次仍需重新读取云端，确认当前内容。",
  partial: "上次检查未完整通过，请查看本次范围并重新验证。",
  failed: "上次检查失败，请查看本次范围并重新验证。",
  stale: "上次检查范围已变化，请重新验证当前内容。",
};

export function ReadingRecovery({ itemKey, revision = "" }: { itemKey: string; revision?: string }) {
  const [plan, setPlan] = useState<ReadingRecoveryPlan | null>(null);
  const [outcome, setOutcome] = useState<ReadingRecoveryOutcome | null>(null);
  const [extras, setExtras] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const invalidate = () => {
    generation.current++;
    setPlan(null); setOutcome(null); setBusy(false); setError("");
  };
  useEffect(() => {
    invalidate(); setExtras(false);
    const changed = (event: Event) => {
      if (event.type === "hub:reading-attachment-ready" && (event as CustomEvent).detail !== itemKey) return;
      invalidate();
    };
    window.addEventListener("hub:reading-data-changed", changed);
    window.addEventListener("hub:reading-attachment-ready", changed);
    return () => {
      generation.current++;
      window.removeEventListener("hub:reading-data-changed", changed);
      window.removeEventListener("hub:reading-attachment-ready", changed);
    };
  }, [itemKey, revision]);
  const preview = async () => {
    if (busy) return;
    const id = generation.current;
    setBusy(true); setError(""); setPlan(null); setOutcome(null);
    try {
      const next = await invoke<ReadingRecoveryPlan>("preview_reading_recovery", { key: itemKey, includeExtras: extras });
      if (generation.current === id) setPlan(next);
    } catch (e) { if (generation.current === id) setError(String(e)); }
    finally { if (generation.current === id) setBusy(false); }
  };
  const check = async () => {
    if (busy || !plan?.actionable) return;
    const id = generation.current;
    setBusy(true); setError(""); setOutcome(null);
    try {
      const next = await invoke<ReadingRecoveryOutcome>("check_reading_recovery", { key: itemKey, includeExtras: extras, token: plan.token });
      if (generation.current === id) { setPlan(next.plan); setOutcome(next); setError(next.failures.join("\n")); }
    } catch (e) {
      if (generation.current === id) { setPlan(null); setError(String(e)); }
    } finally { if (generation.current === id) setBusy(false); }
  };
  return <details className="reading-attachments reading-recovery"><summary>云端恢复检查</summary>
    <p>读取云端当前已同步版本的正文、清单和原附件并校验，不写入本机附件缓存。先预览范围，再开始验证。</p>
    <label className="reading-offline-option"><input type="checkbox" checked={extras} disabled={busy} onChange={e => { setExtras(e.target.checked); invalidate(); }} />同时检查音视频和 ZIP</label>
    <button disabled={busy} onClick={() => void preview()}>{busy ? "正在检查…" : "预览云端检查范围"}</button>
    {error && <p role="alert">{error}</p>}
    {outcome && <div role="status">
      <p>{outcome.complete ? "本次当前已同步版本的正文及全部登记原附件通过云端读取校验。" : `本次尚未完整通过：原附件已校验 ${outcome.verified} / ${outcome.plan.total} 个。${outcome.bodyVerified ? "正文已校验。" : "正文校验尚未通过。"}`}</p>
      {!!outcome.checkedAt && <p>检查时间：{new Date(outcome.checkedAt * 1000).toLocaleString()}</p>}
    </div>}
    {plan && <div className="reading-offline-plan">
      {!outcome && previous[plan.previous] && <p role="status">{previous[plan.previous]}</p>}
      {plan.warnings.map(warning => <p role="status" key={warning}>{warning}</p>)}
      <p>当前范围包含 {plan.total} 个登记原附件。预计读取不超过 {size(plan.downloadBytes)} 的文件载荷，包含正文、清单及可检查附件；请求开销另计，遵守阅读网络策略及每轮、每日额度。</p>
      <button disabled={busy || !plan.actionable} onClick={() => void check()}>检查云端恢复</button>
      <ul>{plan.items.map(item => <li key={item.url}><div><strong>{filename(item.url)}</strong><small>{item.reason}{item.bytes ? ` · ${size(item.bytes)}` : ""}</small></div></li>)}</ul>
    </div>}
    <p>缩略图、原文网站和链接页面不在完整检查范围内；排除或缺失的原附件不能算完整通过。检查只确认当时的云端内容；滴答来源清理还需要独立的来源恢复凭证和删除前复核。</p>
  </details>;
}
