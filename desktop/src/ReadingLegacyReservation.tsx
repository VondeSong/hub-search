import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVisiblePolling } from "./useVisiblePolling";

type Usage = { day: string; legacyReservedBytes?: number; uploadedBytes?: number; downloadedBytes?: number };
export function ReadingLegacyReservation({ onRetry, usage: suppliedUsage, active = true }: { onRetry?: () => void; usage?: Usage; active?: boolean }) {
  const [usage, setUsage] = useState<Usage | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [released, setReleased] = useState(false);
  useEffect(() => {
    if (suppliedUsage) { setUsage(suppliedUsage); return; }
    let active = true;
    const load = () => void invoke<Usage>("get_reading_media_policy").then(value => { if(active)setUsage(value); }).catch(e=>{if(active)setError(String(e));});
    load();return()=>{active=false;};
  }, [suppliedUsage]);
  useVisiblePolling(async () => { setUsage(await invoke<Usage>("get_reading_media_policy")); }, active && !suppliedUsage && Boolean(usage), 5000, { initialDelayMs: 5000 });
  const release = async () => {
    if (!usage?.legacyReservedBytes || busy) return;
    setBusy(true);setError("");
    try {
      await invoke("release_reading_legacy_reservation", { day: usage.day, bytes: usage.legacyReservedBytes });
      setReleased(true);setUsage(await invoke<Usage>("get_reading_media_policy"));
    } catch(e) {setError(String(e));} finally {setBusy(false);}
  };
  if(!usage?.legacyReservedBytes&&!released&&!error)return null;
  return <div className="collection-dida-cleanup" aria-label="旧版额度预留">
    {!!usage?.legacyReservedBytes&&<><strong>旧版预留占用 {(usage.legacyReservedBytes/1048576).toFixed(2)} MB</strong>
      <p>这是旧版提前扣下的额度，无法换算成实际上传或下载量。释放后可继续传输，已记录的流量和正在传输的预留会保留。</p>
      <button disabled={busy} onClick={()=>void release()}>{busy?"等待当前传输结束…":"释放旧版预留"}</button></>}
    {released&&<p role="status">已释放旧版预留。请重新同步，继续检查原内容。</p>}
    {released&&onRetry&&<button disabled={busy} onClick={onRetry}>重新同步滴答稍后读</button>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
