import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { publishCodexNotice } from "./CodexSuite";
import type { LibraryRuntime } from "./LibraryManagement";

type Plan = { libraryId: string; minutes: number | null; globalMinutes: number; effectiveMinutes: number; nextSyncAt?: number; stoppedAfterFailures: boolean };
const intervals = [5, 15, 30, 60, 180, 360, 720, 1440];
export function LibrarySyncSchedule({ libraryId, name, disabled = false }: { libraryId: string; name: string; disabled?: boolean }) {
  const [plan, setPlan] = useState<Plan>();
  const [custom, setCustom] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  const read = useCallback(async (background = false) => {
    const token = ++generation.current;
    if (!background) setBusy(true);
    try {
      const value = await invoke<Plan>("library_sync_schedule", { args: { action: "get", libraryId } });
      if (token === generation.current) { setPlan(value); if (!background) setMinutes((value.minutes ?? value.globalMinutes) || 15); setError(""); }
    } catch (reason) { if (token === generation.current) setError(String(reason)); }
    finally { if (token === generation.current) setBusy(false); }
  }, [libraryId]);
  useEffect(() => {
    setPlan(undefined); setCustom(false); void read();
    let stopped = false;
    let unlisten: (() => void) | undefined;
    void listen<LibraryRuntime>("library-runtime-updated", event => {
      if (!stopped && event.payload.libraryId === libraryId && event.payload.activeOperations === 0 && !inFlight.current) void read(true);
    }).then(stop => { if (stopped) stop(); else unlisten = stop; }).catch(() => undefined);
    return () => { stopped = true; ++generation.current; unlisten?.(); };
  }, [libraryId, read]);
  const save = async (value: number | null) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    const token = ++generation.current;
    try {
      const result = await invoke<Plan>("library_sync_schedule", { args: { action: "save", libraryId, minutes: value } });
      if (token !== generation.current) return;
      setPlan(result); setCustom(false);
      publishCodexNotice(`“${name}”的同步频率已保存`, "success");
    } catch (reason) { if (token === generation.current) setError(String(reason)); }
    finally { inFlight.current = false; if (token === generation.current) setBusy(false); }
  };
  const value = custom ? "custom" : plan?.minutes == null ? "inherit" : String(plan.minutes);
  return <div className="library-sync-schedule">
    <label><span>同步频率</span><select aria-label={`同步频率 · ${name}`} value={value} disabled={!plan || busy || disabled} onChange={event => {
      const v = event.target.value;
      if (v === "custom") { setCustom(true); return; }
      void save(v === "inherit" ? null : Number(v));
    }}>
      <option value="inherit">沿用全局{plan ? `（${plan.globalMinutes ? `${plan.globalMinutes} 分钟` : "仅手动"}）` : ""}</option>
      <option value="0">仅手动同步</option>
      {intervals.map(n => <option key={n} value={n}>{n < 60 ? `${n} 分钟` : `${n / 60} 小时`}</option>)}
      {plan?.minutes != null && plan.minutes > 0 && !intervals.includes(plan.minutes) && <option value={plan.minutes}>{plan.minutes} 分钟</option>}
      <option value="custom">自定义…</option>
    </select></label>
    {custom && <span className="library-sync-custom"><input aria-label={`自定义同步分钟数 · ${name}`} type="number" min="1" max="1440" step="1" value={minutes} disabled={busy || disabled} onChange={e => setMinutes(Number(e.target.value))} /><span>分钟</span><button type="button" disabled={busy || disabled || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440} onClick={() => void save(minutes)}>保存</button><button type="button" disabled={busy} onClick={() => setCustom(false)}>取消</button></span>}
    {busy && <small role="status">正在保存…</small>}
    {plan?.stoppedAfterFailures && <small>连续失败三次，已停止自动重试；可点击“同步一次”。</small>}
    {error && <small role="alert">同步频率读取或保存失败。<button type="button" onClick={() => void read()}>重新读取</button></small>}
  </div>;
}
