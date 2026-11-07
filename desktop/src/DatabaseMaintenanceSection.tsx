import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Status = { phase: string; error: string; beforeBytes: number; afterBytes: number };
type Maintenance = { preview: { reclaimableBytes: number; requiredFreeBytes: number; availableFreeBytes: number | null }; status: Status | null };
const size = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;

export function DatabaseMaintenanceSection() {
  const [state, setState] = useState<Maintenance | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    void invoke<Maintenance>("get_local_database_maintenance").then(value => {
      if (alive.current) setState(value);
    }).catch(value => { if (alive.current) setError(String(value)); });
    return () => { alive.current = false; };
  }, []);
  const pending = state?.status?.phase === "requested";
  const terminal = !state?.status || ["complete", "failed", "cancelled"].includes(state.status.phase);
  const supported = state?.preview.availableFreeBytes != null;
  const spaceReady = supported && state!.preview.availableFreeBytes! >= state!.preview.requiredFreeBytes;
  const act = async (command: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const status = await invoke<Status>(command);
      if (alive.current) setState(value => value ? { ...value, status } : value);
    } catch (value) { if (alive.current) setError(String(value)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="settings-category index" aria-label="数据库空间整理">
    <div className="background-setting-row">
      <span><strong>释放闲置空间</strong><small>{state ? `预计可释放 ${size(state.preview.reclaimableBytes)}。` : "正在检查本机空间…"}安排后会在下次启动时整理，可能需要等待；将保留完整回退副本。</small></span>
      {pending ? <button className="maintenance-button" disabled={busy} onClick={() => void act("cancel_local_database_maintenance")}>{busy ? "正在处理…" : "取消安排"}</button>
        : <button className="maintenance-button" disabled={busy || !state || !terminal || !spaceReady || !state.preview.reclaimableBytes} onClick={() => void act("schedule_local_database_maintenance")}>{busy ? "正在安排…" : "安排下次启动整理"}</button>}
    </div>
    {pending && <p role="status">已安排，下次启动时整理。请先结束正在进行的同步或备份，再重新打开 Hub。</p>}
    {state?.status?.phase === "complete" && <p role="status">上次整理已完成，释放 {size(Math.max(0, state.status.beforeBytes - state.status.afterBytes))}。</p>}
    {state && !supported && <p>当前设备暂不支持空间整理。</p>}
    {state && supported && !spaceReady && <p>可用空间不足，需要至少 {size(state.preview.requiredFreeBytes)}来保存完整回退副本。</p>}
    {state?.status?.error && <p role="alert">{state.status.error}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
