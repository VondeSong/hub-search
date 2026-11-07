import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runtimeCapabilities } from "./RuntimePlatform";

type Plan = { token: string; downloadBytes: number; sourceBytes: number; cleanupEnabled: boolean; recovery: { total: number; actionable: boolean; warnings: string[] } };
type Report = { complete: boolean; checkedAt: number; verified: number; total: number; failures: string[] };
export function ReadingSourceRecovery({ itemKey, revision }: { itemKey: string; revision: string }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const reset = () => { generation.current++; setPlan(null); setResult(null); setError(""); setBusy(false); };
    const attachment = (event: Event) => { if ((event as CustomEvent).detail === itemKey) reset(); };
    reset(); window.addEventListener("hub:reading-data-changed", reset); window.addEventListener("hub:reading-attachment-ready", attachment);
    return () => { generation.current++; window.removeEventListener("hub:reading-data-changed", reset); window.removeEventListener("hub:reading-attachment-ready", attachment); };
  }, [itemKey, revision]);
  if (!runtimeCapabilities.desktop || !itemKey.startsWith("dida:")) return null;
  const run = async (check: boolean) => {
    if (busy || (check && !plan?.recovery.actionable)) return;
    const stamp = generation.current;
    setBusy(true); setError(""); setResult(null);
    try {
      if (check) {
        const report = await invoke<Report>("check_reading_source_recovery", { key: itemKey, token: plan!.token });
        if (generation.current === stamp) setResult(report);
      } else {
        setPlan(null);
        const next = await invoke<Plan>("preview_reading_source_recovery", { key: itemKey });
        if (generation.current === stamp) setPlan(next);
      }
    } catch (reason) { if (generation.current === stamp) { setError(String(reason)); setPlan(null); } }
    finally { if (generation.current === stamp) setBusy(false); }
  };
  return <details className="reading-attachments reading-recovery"><summary>检查滴答内容与附件备份</summary>
    <p>检查这条滴答内容的正文和全部附件是否能从云端完整取回。检查会保存滴答原始内容和附件列表，方便以后恢复。</p>
    <button disabled={busy} onClick={() => void run(false)}>{busy ? "正在检查…" : "查看要检查的内容"}</button>
    {plan && <div><p>需要检查正文和 {plan.recovery.total} 个附件，预计传输不超过 {(plan.downloadBytes / 1048576).toFixed(1)} MB，计入阅读附件额度。</p>
      {plan.recovery.warnings.map(w => <p key={w}>{w}</p>)}
      <button disabled={busy || !plan.recovery.actionable} onClick={() => void run(true)}>检查云端备份</button>
    </div>}
    {result && <p role="status">{result.complete ? "正文和全部附件都已确认可以从云端完整取回。" : `云端备份还没全部检查通过，已确认附件 ${result.verified} / ${result.total} 个。滴答原内容继续保留。`}{result.checkedAt ? ` 检查于 ${new Date(result.checkedAt * 1000).toLocaleString()}` : ""}</p>}
    {(error || result?.failures.length) && <p role="alert">{error || result?.failures.join("\n")}</p>}
    <p>这次检查不会删除滴答里的原内容。只有开启“保存完整后，删除滴答里的原内容”，并在删除前再次确认账号、正文和全部附件都完整，才会删除。</p>
  </details>;
}

export function ReadingSourceCleanupSettings({ blocked, unavailableReason }: { blocked: boolean; unavailableReason?: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void invoke<boolean>("get_reading_source_cleanup").then(v => { if (active) setEnabled(v); }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  const save = async (next: boolean) => {
    setBusy(true); setError("");
    try { setEnabled(await invoke<boolean>("set_reading_source_cleanup", { enabled: next })); window.dispatchEvent(new Event("hub:reading-data-changed")); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  return <section id="dida-reading-cleanup-settings" tabIndex={-1} className="cloud-sync-card" aria-label="滴答来源清理"><h3>滴答来源清理</h3>
    <label className="cloud-sync-switch"><span><strong>保存完整后，删除滴答里的原内容</strong><small>仅处理标有“稍后读”的滴答内容。默认关闭；开启后，正文和全部附件在本机与云端都检查通过，才会删除滴答里的原内容。</small></span><input type="checkbox" aria-label="保存完整后，删除滴答里的原内容" checked={enabled === true} disabled={busy || enabled === null || (blocked && enabled !== true)} onChange={e => void save(e.target.checked)} /></label>
    {unavailableReason&&<p>{unavailableReason}</p>}
    <p>附件列表读不到、文件没保存完整、云同步暂停，或滴答内容发生变化时，都保留原内容。关闭此开关即可停止本设备的自动删除。</p>
    <details><summary>为什么还要检查附件？</summary><p>任务正文里的链接不一定包含全部附件。Hub 还需要读取滴答返回的附件列表，下载原文件，再确认本机和云端副本都能完整读取。</p><p>没有返回附件列表，不等于没有附件，也不代表附件丢失。Hub 会补查；仍无法确认就保留滴答原内容，避免误删。</p></details>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">正在保存；等待当前阅读传输结束…</p>}
  </section>;
}
