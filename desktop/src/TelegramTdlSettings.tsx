import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, LoaderCircle, Pause, RefreshCw } from "lucide-react";

export type TelegramTdlState = { installed: boolean; version: string; enabled: boolean; ready: boolean; running: boolean; phase: string; status: string; bytes: number; proxy: string; proxyInherited?: boolean; effectiveProxy?: string };
export function TelegramTdlSettings({state,paired,reload,onError}:{state?:TelegramTdlState;paired:boolean;reload:()=>Promise<void>;onError:(message:string)=>void}) {
  const [busy,setBusy]=useState(false),[proxy,setProxy]=useState<string|null>(null),[method,setMethod]=useState("qr");
  const run=async(command:string,args?:Record<string,unknown>)=>{
    if(busy)return;setBusy(true);onError("");
    try{await invoke(command,args);await reload();}catch(error){onError(String(error));}finally{setBusy(false);}
  };
  const running=busy||!!state?.running;
  return <details className="collection-tdl-settings">
    <summary>Telegram 历史与大附件</summary>
    <p>tdl 用你的 Telegram 账号补取发给机器人的历史消息，并下载超过 20 MB 的附件。内容仍收进当前数据库。</p>
    <small>{state?.installed?`tdl ${state.version} · ${state.ready?"账号已连接":"待登录 Telegram 账号"}`:"尚未安装 tdl"}</small>
    <div className="collection-tdl-actions">
      <button disabled={running} onClick={()=>void run("install_telegram_tdl")}><Download size={14}/>{busy?"正在处理…":state?.installed?"重新安装 tdl":"安装 tdl"}</button>
      {state?.installed&&<><select aria-label="tdl 登录方式" disabled={running} value={method} onChange={event=>setMethod(event.target.value)}><option value="qr">扫码登录</option><option value="code">验证码登录</option></select><button disabled={running||!paired} onClick={()=>void run("login_telegram_tdl",{method})}>{state.ready?"重新登录账号":"登录 Telegram 账号"}</button></>}
      <button disabled={running||!state?.installed||!paired} onClick={()=>void run("sync_telegram_tdl")}><RefreshCw size={14}/>补取历史与附件</button>
      {state?.running&&<button onClick={()=>void run("cancel_telegram_tdl")} disabled={busy}><Pause size={14}/>暂停 tdl</button>}
      <button disabled={running} onClick={()=>void run("discard_partial_media_downloads")}>取消未完成的附件下载</button>
    </div>
    {!paired&&<small>先在连接管理中连接机器人，并打开机器人确认你的账号。</small>}
    {state?.running&&state.phase==="login"&&<p>已打开 tdl 验证码登录窗口。请在该窗口中输入手机号、验证码和两步验证密码，完成后回到 Hub。</p>}
    {state?.running&&state.phase==="qrlogin"&&<p>扫码登录已在 Hub 中打开，二维码会自动更新。</p>}
    {state?.status&&<p className="collection-tdl-status" role="status">{state.running&&<LoaderCircle size={14} className="spin"/>}{state.status}{state.running&&state.bytes>0&&` · ${(state.bytes/1024/1024).toFixed(1)} MB`}</p>}
    {state?.installed&&<><label className="collection-tdl-enabled"><input type="checkbox" checked={state.enabled} disabled={running} onChange={event=>void run("save_telegram_tdl",{enabled:event.target.checked,proxy:proxy??state.proxy})}/>按同步频率自动补取 Telegram 历史</label>
      <label className="collection-tdl-proxy">代理（留空使用系统代理）<input aria-label="tdl 代理" disabled={running} placeholder="socks5://127.0.0.1:7890" value={proxy??state.proxy} onChange={event=>setProxy(event.target.value)}/><button disabled={running} onClick={()=>void run("save_telegram_tdl",{enabled:state.enabled,proxy:proxy??state.proxy})}>保存</button></label>{state.proxyInherited&&<small>当前使用系统代理：{state.effectiveProxy}</small>}</>}
    <small>暂停保留续传数据；未完成分片最多保留 7 天，每个附件目录最多 64 GB。取消未完成下载会清理分片，完整附件保留。请登录发送消息的同一账号。</small>
    <button onClick={()=>void run("open_external_url",{url:"https://github.com/iyear/tdl"})}>tdl 官方项目 · AGPL-3.0</button>
  </details>;
}
