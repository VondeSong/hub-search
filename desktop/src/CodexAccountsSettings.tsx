import { useRef, useState } from "react";
import { ChevronRight, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { authorizeCodexConversation, cancelCodexLogin, dismissCodexAccountNotice, refreshCodexAccounts, removeCodexAccount, selectCodexAccount, startCodexLogin, useCodexAccounts } from "./CodexAccounts";
import { openCodexSuiteSettings } from "./CodexSuite";
import { useModalFocus } from "./useModalFocus";
import "./CodexAccountsSettings.css";

export function CodexAccountContext({onOpen}:{onOpen:()=>void}) {
  const {current,loading}=useCodexAccounts();
  const status=current ? [current.workspaceLabel || current.label, current.plan].filter(Boolean).join(" · ") : loading ? "正在读取" : "未连接";
  return <button type="button" className="agent-detail-link agent-inspector-account" aria-haspopup="dialog" onClick={onOpen}>
    <span className="agent-detail-title">Codex 账号</span><small><i data-connected={!!current} aria-hidden="true"/>{status}</small><ChevronRight size={12} aria-hidden="true"/>
  </button>;
}

export function CodexAccountDialog({onClose}:{onClose:()=>void}) {
  const panel=useRef<HTMLElement>(null);
  useModalFocus({active:true,containerRef:panel,onDismiss:onClose});
  return <div className="agent-reference-overlay" onClick={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section ref={panel} className="agent-reference-modal" role="dialog" aria-modal="true" aria-label="Codex 账号管理" tabIndex={-1}>
      <header><strong>Codex 账号管理</strong><button type="button" aria-label="关闭 Codex 账号管理" onClick={onClose}><X size={16}/></button></header>
      <div className="agent-reference-modal-body"><CodexAccountsSettings/></div>
    </section>
  </div>;
}

export function CodexAccountBadge({workId,boundScopeId,needsAuthorization=false,disabled=false,onAuthorized}:{workId?:string;boundScopeId?:string;needsAuthorization?:boolean;disabled?:boolean;onAuthorized?:()=>void}) {
  const value = useCodexAccounts();
  const [error,setError]=useState("");
  const [authorizing,setAuthorizing]=useState(false);
  const authorize=async()=>{
    if(!workId||!value.current)return;
    setError("");setAuthorizing(true);
    try{await authorizeCodexConversation(workId,value.current.scopeId);onAuthorized?.();}catch(reason){setError(String(reason));}finally{setAuthorizing(false);}
  };
  const needsConsent=needsAuthorization&&!!workId&&boundScopeId!==value.current?.scopeId;
  if(!value.accountNotice&&!needsConsent&&!error)return null;
  return <div className="agent-account-status">
    {value.accountNotice&&<><span role="status">已切换账号：{[value.accountNotice.label,value.accountNotice.workspaceLabel].filter(Boolean).join(" · ")}</span><div className="agent-account-notice-actions"><button type="button" onClick={openCodexSuiteSettings}>管理账号</button><button type="button" aria-label="隐藏账号切换提示" onClick={event=>{const input=event.currentTarget.closest(".agent-composer")?.querySelector<HTMLTextAreaElement>("textarea");dismissCodexAccountNotice();input?.focus({preventScroll:true});}}>隐藏</button></div></>}
    {needsConsent&&<><span>继续当前对话会将必要历史提供给此账号。</span><button type="button" disabled={disabled||authorizing||!value.current} onClick={()=>void authorize()}>允许当前账号读取本对话历史</button></>}
    {error&&<span role="alert">{error}</span>}
  </div>;
}

export function CodexAccountsSettings() {
  const value = useCodexAccounts();
  const [selection, setSelection] = useState<string | null>(null);
  const [newConversation, setNewConversation] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState(false);
  const target = selection ?? value.selected;
  const pending = value.login?.state === "pending" ? value.login : null;
  const act = async (operation: () => Promise<unknown>) => {
    setError("");
    try { await operation(); } catch (reason) { setError(String(reason)); }
  };
  const openLogin = async (url: string | undefined) => {
    if (!url) throw new Error("登录地址不可用，请重新添加账号");
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(parsed.hostname) || parsed.username || parsed.password) throw new Error("登录地址不是受支持的官方地址");
    await openUrl(url);
  };
  const add = async () => {
    setOpening(true);
    try { const login = await startCodexLogin(); await openLogin(login.authUrl); }
    finally { setOpening(false); }
  };
  return <fieldset className="codex-accounts-settings">
    <legend>助手 Codex 账号</legend>
    <label>使用账号<select aria-label="助手 Codex 账号" value={target} disabled={!value.loaded || value.busy} onChange={event => setSelection(event.target.value)}>
      <option value="desktop">跟随 Codex 桌面登录</option>
      {value.accounts.map(account => <option key={account.id} value={account.id}>{account.label}{account.plan ? ` · ${account.plan}` : ""} · {account.workspaceLabel || account.id.slice(-4)}</option>)}
    </select></label>
    <p role="status">当前识别：{value.current ? [value.current.label,value.current.plan,value.current.workspaceLabel].filter(Boolean).join(" · ") : value.loading ? "正在读取账号…" : "未登录或账号不可用"}</p>
    {target !== value.selected && <div className="codex-account-switch">
      <label><input type="radio" name="codexAccountContext" checked={newConversation} onChange={() => setNewConversation(true)}/>新建独立对话</label>
      <label><input type="radio" name="codexAccountContext" checked={!newConversation} onChange={() => setNewConversation(false)}/>继续当前对话，将必要历史提供给新账号</label>
      <button type="button" className="maintenance-button" disabled={value.busy || value.loading} onClick={() => void act(async () => { await selectCodexAccount(target, newConversation); setSelection(null); })}>切换账号</button>
    </div>}
    <div className="codex-account-actions">
      <button type="button" className="maintenance-button" disabled={value.busy || !!pending || opening} onClick={() => void act(add)}>{opening ? "正在打开登录…" : "添加账号"}</button>
      <button type="button" className="maintenance-button" disabled={value.busy || value.loading} onClick={() => void refreshCodexAccounts()}>{value.loading ? "读取中…" : "刷新账号"}</button>
    </div>
    {pending && <div className="codex-account-login" role="status"><p>在浏览器中选择要添加的 ChatGPT 账号并完成授权。完成后会出现在列表中，不会自动切换。</p><div className="codex-account-actions"><button type="button" className="maintenance-button" disabled={value.busy} onClick={() => void act(() => openLogin(pending.authUrl))}>重新打开登录页</button><button type="button" className="maintenance-button" disabled={value.busy} onClick={() => void act(() => cancelCodexLogin(pending.id))}>取消登录</button></div></div>}
    {value.login?.state === "completed" && <p role="status">账号已添加，请在列表中选择后切换。</p>}
    {value.accounts.length > 0 && <details><summary>已添加的账号</summary><ul>{value.accounts.map(account => <li key={account.id}><span>{account.label} · {account.id.slice(-4)}</span><button type="button" className="maintenance-button" disabled={value.busy || account.id === value.selected} title={account.id === value.selected ? "请先切换到其他账号" : "退出此账号在 Hub 中的登录并移除"} onClick={() => void act(() => removeCodexAccount(account.id))}>移除</button></li>)}</ul></details>}
    {(error || value.requestError || value.error || value.login?.error) && <p role="alert">{error || value.requestError || value.error || value.login?.error}</p>}
    <p>选择只影响 Hub 助手，不会切换桌面应用的账号。已经启动的生成使用原账号；后续请求使用新选择。账号失效时会提示重新登录，不会改用其他账号。</p>
  </fieldset>;
}
