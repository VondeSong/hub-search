import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type CacheState = { bytes: number; pinnedBytes: number; removableBytes: number; removableCount: number; otherCount: number; pins: { hash: string; label: string; available: boolean }[]; token: string };
type Cleanup = { removed: number; removedBytes: number; failures: string[]; status: CacheState };
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
function label(url: string) { try { return decodeURIComponent(new URL(url).pathname.split("/").pop() || "附件"); } catch { return "附件"; } }
export function ReadingCacheSettings() {
  const [state, setState] = useState<CacheState | null>(null), [preview, setPreview] = useState<CacheState | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  useEffect(() => { let active = true; void invoke<CacheState>("get_reading_cache_status").then(s => { if (active && s?.pins) setState(s); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
  const inspect = async () => {
    setBusy(true); setError(""); setNotice(""); setPreview(null);
    try { const s = await invoke<CacheState>("get_reading_cache_status"); setState(s); setPreview(s); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const clean = async () => {
    if (!preview || busy) return; setBusy(true); setError("");
    try { const result = await invoke<Cleanup>("clean_reading_cache", { token: preview.token });
      setState(result.status); setNotice(`已清理 ${result.removed} 个缓存文件（${size(result.removedBytes)}）`);
      if (result.failures.length) setError(`${result.failures.length} 个文件暂未清理，可稍后重试。`);
      window.dispatchEvent(new Event("hub:reading-cache-changed"));
    } catch (e) { setError(String(e)); } finally { setPreview(null); setBusy(false); }
  };
  const unpin = async (hash: string) => {
    setBusy(true); setError(""); setPreview(null); setNotice("");
    try { await invoke("unpin_reading_attachment", { hash }); setState(await invoke<CacheState>("get_reading_cache_status")); setNotice("已取消离线保留，文件仍在本机，可在预览后清理。"); window.dispatchEvent(new Event("hub:reading-cache-changed")); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <section className="reading-cache-settings" aria-label="本机阅读缓存">
    <h4>本机阅读缓存</h4>
    <p>离线保留的附件不会被清理；同一文件用于多篇文章时共用一份缓存。保留与清理只影响本设备。</p>
    {state && <p>缓存文件 {size(state.bytes)} · 离线保留 {size(state.pinnedBytes)} · 可清理 {size(state.removableBytes)}</p>}
    {state && state.otherCount > 0 && <p>另有 {state.otherCount} 项未纳入清理（未登记文件、临时文件、待上传附件或特殊目录）。</p>}
    {!!state?.pins.length && <details><summary>离线保留的附件 · {state.pins.length}</summary><ul>{state.pins.map(pin => <li key={pin.hash}><span>{label(pin.label)}{!pin.available && " · 本机文件缺失，请在原文章重新下载"}</span><button disabled={busy} onClick={() => void unpin(pin.hash)}>取消保留</button></li>)}</ul></details>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button disabled={busy} onClick={() => void inspect()}>{busy ? "正在处理…" : "预览可清理缓存"}</button>
    {preview && <div className="reading-cache-confirm" role="group" aria-label="缓存清理预览"><p>将清理 {preview.removableCount} 个文件，共 {size(preview.removableBytes)}。正文、原附件、资料库文件和云端副本保留。再次打开附件会按同步开关和额度重新下载；自动同步不会立即下载刚清理的文件。</p><button disabled={busy || !preview.removableCount} onClick={() => void clean()}>确认清理本机缓存</button><button disabled={busy} onClick={() => setPreview(null)}>取消</button></div>}
  </section>;
}
