import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ReadingCacheSettings } from "./ReadingCacheSettings";
import { ReadingLegacyReservation } from "./ReadingLegacyReservation";
import { useVisiblePolling } from "./useVisiblePolling";

export type ReadingMediaPolicy = { enabled: boolean; download: "onDemand" | "all"; imageMb: number; documentMb: number; batchMb: number; dailyMb: number; cacheMb: number };
type State = { policy: ReadingMediaPolicy; reservedBytes: number; day: string; uploadedBytes?: number; downloadedBytes?: number; attachmentDownloadedBytes?: number; metadataDownloadedBytes?: number; pendingBytes?: number; legacyReservedBytes?: number };
export function ReadingMediaSettings({ blocked, active = true }: { blocked: boolean; active?: boolean }) {
  const [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState<ReadingMediaPolicy | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    const load = (initial: boolean) => void invoke<State>("get_reading_media_policy").then(s => {
      if (!active || !s?.policy) return;
      if (initial) { setState(s); setDraft(s.policy); setError(""); }
      else setState(previous => previous ? { ...s, policy: previous.policy } : previous);
    }).catch(e => { if (active && initial) setError(String(e)); });
    load(true);
    return () => { active = false; };
  }, [reload]);
  useVisiblePolling(async () => {
    const next = await invoke<State>("get_reading_media_policy");
    if (next?.policy) setState(previous => previous ? { ...next, policy: previous.policy } : previous);
  }, active && Boolean(state), 5000, { initialDelayMs: 5000 });
  const save = async () => {
    if (!draft || busy) return; setBusy(true); setError(""); setNotice("");
    try { const saved = await invoke<ReadingMediaPolicy>("update_reading_media_policy", { settings: draft }); setDraft(saved); setState(previous => previous ? { ...previous, policy: saved } : null); setNotice("附件策略已保存，将用于下一次传输"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(state?.policy);
  return <section className="cloud-sync-card" aria-label="阅读附件策略">
    <h3>阅读附件</h3>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!draft && error && <button onClick={() => setReload(n => n + 1)}>重新读取附件策略</button>}
    {draft && <>
      <label className="cloud-sync-switch"><span><strong>同步阅读附件</strong><small>只上传已在本机保存并登记的附件与小缩略图；正文同步独立运行。</small></span><input aria-label="同步阅读附件" type="checkbox" checked={draft.enabled} disabled={busy || blocked} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /></label>
      <label>下载方式<select aria-label="阅读附件下载方式" value={draft.download} disabled={busy || !draft.enabled} onChange={e => setDraft({ ...draft, download: e.target.value as ReadingMediaPolicy["download"] })}><option value="onDemand">打开时下载</option><option value="all">自动下载图片和 PDF</option></select></label>
      <div className="reading-media-limits">{([
        ["imageMb", "单张图片上限", 1, 100], ["documentMb", "单个 PDF 上限", 1, 100], ["batchMb", "每轮云端传输额度", 4, 512], ["dailyMb", "每日云端传输额度", 4, 10240], ["cacheMb", "本机附件缓存上限", 100, 10240],
      ] as const).map(([field, label, min, max]) => <label key={field}>{label}（MB）<input type="number" aria-label={label} min={min} max={max} step={1} value={draft[field]} disabled={busy || !draft.enabled} onChange={e => setDraft({ ...draft, [field]: Number(e.target.value) })} /></label>)}</div>
      <p>音视频和 ZIP 默认跳过，可在文章右上角“更多阅读操作 → 附件云副本”中逐项上传或下载，单文件硬上限 100 MB。其他格式暂不上传。</p>
      <p>缩略图仅同步已有登记的 JPEG、PNG、GIF 或 WebP 小图片，最多 2 MB，并遵守单张图片上限及共享传输、缓存额度。缩略图可用不代表原视频完整；“本文离线”仍检查原附件。</p>
      <p>云端传输额度用于附件传输及恢复检查中的正文、清单读回。本机检查与缓存读取不计入；从云端读回文件属于下载。</p>
      <p>传输前临时预留，结束后释放未使用额度。下载中断只计已收到的文件数据；上传按交给网络发送的文件数据统计，服务器是否收到以同步结果为准。这是应用统计，不是阿里云账单；不包含请求费、存储费或网络协议开销；普通正文同步与云端目录请求不在此项统计中。</p>
      <p aria-label="今日云端传输用量">今日上传 {((state?.uploadedBytes || 0) / 1048576).toFixed(2)} MB · 下载 {((state?.downloadedBytes || 0) / 1048576).toFixed(2)} MB。下载中：附件 {((state?.attachmentDownloadedBytes || 0) / 1048576).toFixed(2)} MB · 正文与清单 {((state?.metadataDownloadedBytes || 0) / 1048576).toFixed(2)} MB。</p>
      {!!state?.pendingBytes && <p>传输中或中断待核对的预留：{(state.pendingBytes / 1048576).toFixed(2)} MB，不代表已经传输。</p>}
      <ReadingLegacyReservation usage={state ?? undefined} active={active} />
      <p>额度按 UTC 日期更新（北京时间每天 08:00）。网络限制在上方“阅读网络”中设置。达到缓存上限后停止新下载，已有文件保留。</p>
      <div className="cloud-sync-actions"><button disabled={!dirty || busy || blocked} onClick={() => void save()}>{busy ? "等待当前传输结束…" : "保存阅读附件策略"}</button></div>
    </>}
    <ReadingCacheSettings />
  </section>;
}
