import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useVisiblePolling } from "./useVisiblePolling";
type Mode = "any" | "unmetered" | "wifi";
type NetworkState = { mode: Mode; network: { supported: boolean; connected: boolean | null; kind: string; metered: boolean | null; restricted: boolean }; allowed: boolean; reason: string };
const kind: Record<string, string> = { wifi: "Wi-Fi", cellular: "移动网络", ethernet: "有线网络", other: "其他网络", vpn: "VPN", unknown: "暂无法确认" };
export function ReadingNetworkSettings({ active = true }: { active?: boolean } = {}) {
  const [state, setState] = useState<NetworkState | null>(null), [draft, setDraft] = useState<Mode>("any");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  useEffect(() => {
    let active = true;
    const load = (initial: boolean) => {
      const observed = version.current;
      void invoke<NetworkState>("get_reading_network_policy").then(next => {
        if (!active || observed !== version.current || !next?.network) return;
        setState(next); if (initial) { setDraft(next.mode); setError(""); }
      }).catch(e => { if (active && observed === version.current && initial) setError(String(e)); });
    };
    load(true);
    return () => { active = false; };
  }, [reload]);
  useVisiblePolling(async () => {
    const observed = version.current;
    const next = await invoke<NetworkState>("get_reading_network_policy");
    if (observed === version.current && next?.network) setState(next);
  }, active && Boolean(state), 5000, { initialDelayMs: 5000 });
  const save = async () => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { const next = await invoke<NetworkState>("update_reading_network_policy", { mode: draft }); version.current++; setState(next); setDraft(next.mode); setNotice("阅读网络策略已保存"); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };
  return <section className="cloud-sync-card" aria-label="阅读网络策略"><h3>阅读网络</h3>
    <p>约束本设备的阅读正文、附件和副本记录传输，手动下载也遵守此设置。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {!state && <button disabled={busy} onClick={() => setReload(n => n + 1)}>重新读取网络状态</button>}
    {(state || error) && <>
      <label>允许使用的网络<select aria-label="阅读允许使用的网络" value={draft} disabled={busy} onChange={e => { setDraft(e.target.value as Mode); setNotice(""); }}><option value="any">不限制网络</option><option value="unmetered">仅非计费网络</option><option value="wifi">仅非计费 Wi-Fi</option></select></label>
      {!state && <p>尚未确认已保存的策略；可重新读取，或选择策略后明确保存以修复本机设置。</p>}
      {state && <>
      <p>当前：{state.network.connected === false ? "无可用互联网连接" : kind[state.network.kind] || "暂无法确认"}{state.network.connected !== false ? state.network.metered === true ? " · 计费网络" : state.network.metered === false ? " · 非计费网络" : " · 计费状态未知" : ""}</p>
      {!state.allowed && <p role="status">{state.reason}</p>}
      {!state.network.supported && <p>当前平台暂不能识别网络类型；选择限制模式后会暂停阅读传输。</p>}
      </>}
      <p>计费状态以系统设置为准，手机热点也可能被标为计费网络。VPN 无法确认为 Wi-Fi 时，可选择“仅非计费网络”。</p>
      <p>每个新请求前重新检查；已开始的请求仍可能完成。已有本机内容继续可用。此设置保存在本设备，闪卡使用现有同步策略。</p>
      <button disabled={busy || (state !== null && draft === state.mode)} onClick={() => void save()}>{busy ? "等待当前阅读传输结束…" : "保存阅读网络策略"}</button>
    </>}
  </section>;
}
