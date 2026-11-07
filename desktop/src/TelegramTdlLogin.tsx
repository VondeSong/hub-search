import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useVisiblePolling } from "./useVisiblePolling";

type Login = { sessionId: number; active: boolean; qr: string[]; qrAt: number; needsPassword: boolean; status: string };
export function TelegramTdlLogin({ running, reload }: { running: boolean; reload: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false), [login, setLogin] = useState<Login | null>(null);
  const [password, setPassword] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0);
  useEffect(() => { if (running) setOpen(true); }, [running]);
  useEffect(() => {
    if (open) dialog.current?.showModal(); else dialog.current?.close();
  }, [open]);
  const poll = useCallback(async () => {
    const request = generation.current;
    try {
      const view = await invoke<Login>("get_telegram_tdl_login");
      if (request === generation.current) { setLogin(view); setNow(Date.now()); }
    } catch { if (request === generation.current) setError("无法读取登录状态，请关闭后重新登录"); }
  }, []);
  useVisiblePolling(poll, open, 500);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { setPassword(""); }, [login?.sessionId, login?.needsPassword, open]);
  const close = async () => {
    if (busy) return;
    setBusy(true); setPassword(""); setLogin(null); generation.current++;
    try { if (running || login?.active) await invoke("cancel_telegram_tdl"); setOpen(false); await reload(); }
    catch { setError("正在结束登录，请稍后关闭"); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    if (busy) return;
    setBusy(true); setError(""); setPassword(""); generation.current++;
    const replace = login?.active ? login.sessionId : undefined;
    setLogin(null);
    try { await invoke("login_telegram_tdl", { method: "qr", ...(replace ? { replace } : {}) }); await reload(); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !password || !login?.needsPassword) return;
    const secret = password; setPassword(""); setBusy(true); setError("");
    try { await invoke("submit_telegram_tdl_password", { sessionId: login.sessionId, password: secret }); setLogin(old => old && { ...old, needsPassword: false, status: "正在验证 Telegram 账号…" }); }
    catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  const qr = login?.active && now - login.qrAt < 25_000 && !busy ? login.qr : [];
  const size = qr.length;
  return <dialog ref={dialog} className="collections-dialog collection-tdl-login" aria-labelledby="tdl-login-title" onCancel={event => { event.preventDefault(); void close(); }}>
    <header><h2 id="tdl-login-title">登录 Telegram 账号</h2><button type="button" aria-label="关闭 Telegram 扫码登录" disabled={busy} onClick={() => void close()}><X size={18}/></button></header>
    <p>在手机 Telegram 中打开「设置 → 设备 → 连接桌面设备」，扫描下方二维码。请使用发送消息给机器人的同一账号。</p>
    <div className="collection-tdl-qr-frame">
      {size > 0 ? <svg role="img" aria-label="Telegram 登录二维码" width={size * 6} height={size * 6} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges"><rect width={size} height={size} fill="#fff"/>{qr.flatMap((row,y) => [...row].flatMap((bit,x) => bit === "1" ? [<rect key={`${x}-${y}`} x={x} y={y} width="1" height="1" fill="#000"/>] : []))}</svg>
        : login?.needsPassword ? <span>扫码已确认，请完成两步验证</span>
        : login?.active || busy || !login ? <span><LoaderCircle size={20} className="spin"/>正在获取最新二维码…</span>
        : <span>登录已结束</span>}
    </div>
    <p className="collection-tdl-login-status" role="status">{login?.status}</p>
    {login?.active && !login.needsPassword && <small>二维码会自动更新。手机提示“二维码错误”时，点击“重新获取二维码”，扫描新图。</small>}
    {login?.needsPassword && <form onSubmit={event => void submit(event)}>
      <label htmlFor="tdl-password">Telegram 两步验证密码</label>
      <input id="tdl-password" type="password" autoComplete="off" value={password} disabled={busy} onChange={event => setPassword(event.target.value)} autoFocus/>
      <small>密码仅发送给本次本机登录进程，提交后清空。</small>
      <button className="collections-primary" type="submit" disabled={busy || !password}>验证账号</button>
    </form>}
    {error && <p className="collections-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy || !!login?.needsPassword} onClick={() => void refresh()}><RefreshCw size={14}/>{login?.active ? "重新获取二维码" : "重新扫码登录"}</button><button type="button" disabled={busy} onClick={() => void close()}>{login?.active || running ? "取消登录" : "完成"}</button></footer>
  </dialog>;
}
