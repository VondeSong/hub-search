import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatDataPath } from "./DataManagementFormat";

type Entry = { id: string; label: string; available?: boolean; supported?: boolean; conflict?: boolean; error?: string };
type Preview = { token: string; targetRoot: string; entries: Entry[] };
type Result = { results: { label: string; status: "imported" | "skipped" | "failed"; message?: string }[]; warnings: string[] };
const call = <T,>(action: string, args: Record<string, unknown> = {}) => invoke<T>("data_portability", { args: { action, ...args } });

export function AccountMigrationSettings({ blocked, hasAccountCopy = false, onBusyChange, onPrepared }: {
  blocked: boolean; hasAccountCopy?: boolean; onBusyChange: (busy: boolean) => void; onPrepared: () => void;
}) {
  const [include, setInclude] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [overwrite, setOverwrite] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [notice, setNotice] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const disabled = blocked || Boolean(busy);
  useEffect(() => { onBusyChange(Boolean(busy)); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const run = async (label: string, action: () => Promise<void>) => {
    if (disabled) return;
    setBusy(label); setError(""); setNotice(""); setResult(null); setWarnings([]);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(""); }
  };
  const select = (id: string, checked: boolean) => setSelected(previous => checked ? [...previous, id] : previous.filter(item => item !== id));
  const toggleAccounts = (checked: boolean) => {
    setInclude(checked); setSelected([]); setPassword(""); setConfirmation(""); setPreview(null);
    if (checked) void run("正在读取可迁移授权…", async () => {
      const response = await call<{ entries: Entry[] }>("account_catalog");
      setEntries(response.entries); setSelected(response.entries.filter(entry => entry.available).map(entry => entry.id));
    });
  };
  const prepare = () => {
    if (include && ([...password].length < 12 || password !== confirmation || !selected.length)) {
      setError("请选择授权，并设置至少 12 个字符的迁移密码，两次输入需一致。"); return;
    }
    if (!include) return;
    void run("正在保存加密授权副本…", async () => {
      try {
        const response = await call<{ root: string; ready: boolean; warnings: string[]; hasAccountCopy: boolean }>("prepare_accounts", {
          ids: selected, password,
        });
        setWarnings(response.warnings);
        setNotice(`账号授权已加密放在同一目录中：${formatDataPath(response.root)}。复制整个目录到新电脑后，用迁移密码解锁。`);
        onPrepared();
      } finally { setPassword(""); setConfirmation(""); }
    });
  };
  const inspect = () => void run("正在解锁本目录的授权副本…", async () => {
    setPreview(null); setSelected([]); setOverwrite(false);
    const response = await call<Preview>("inspect_accounts", { password });
    setPreview(response); setSelected(response.entries.filter(entry => entry.supported && !entry.conflict).map(entry => entry.id));
  });
  const apply = () => void run("正在恢复所选账号授权…", async () => {
    if (!preview) return;
    try {
      const response = await call<Result>("import_accounts", { token: preview.token, targetRoot: preview.targetRoot, password, ids: selected, overwrite });
      setResult(response); setPreview(null); setSelected([]); setNotice("恢复结果如下。重启 Hub 后使用新授权；自动同步保持当前设置。");
    } finally { setPassword(""); }
  });
  return <div className="data-portability-options account-migration">
    <h4>直接复制数据文件夹</h4>
    <p className="data-portability-note">Craft、滴答的正文与已下载附件自动保存在当前数据目录。完全退出 Hub 后，直接复制整个文件夹到新电脑，再选择“打开已有数据目录”。</p>
    <p className="data-portability-note">无需额外准备。Obsidian 原始库单独移动并重新加载；尚未下载成功的附件需先完成下载。</p>
    <label className="data-portability-checkbox"><input type="checkbox" checked={include} disabled={disabled} onChange={event => toggleAccounts(event.target.checked)} />同时保存账号授权与服务密码的加密副本（可选）</label>
    {include && <>
      <details><summary>选择账号与密码（默认包含本机已有授权）</summary><fieldset className="account-migration-entries"><legend>随整个数据目录一起迁移</legend>
        {entries.map(entry => <label key={entry.id} className="data-portability-checkbox"><input type="checkbox" checked={selected.includes(entry.id)} disabled={disabled || !entry.available} onChange={event => select(entry.id, event.target.checked)} /><span>{entry.label}{!entry.available && <small>{entry.error || "本机没有已保存授权"}</small>}</span></label>)}
      </fieldset></details>
      <label className="data-portability-field">迁移密码（至少 12 个字符）<input type="password" autoComplete="new-password" value={password} disabled={disabled} onChange={event => setPassword(event.target.value)} /></label>
      <label className="data-portability-field">再次输入迁移密码<input type="password" autoComplete="new-password" value={confirmation} disabled={disabled} onChange={event => setConfirmation(event.target.value)} /></label>
      <small className="data-portability-note">加密副本直接存入当前数据目录，并随整库备份携带。密码由你保管；搬家前更新一次可取得最新授权。没有外网时，已恢复的正文和附件仍可使用，过期授权和未下载内容需要网络。</small>
    </>}
    {include && <button className="maintenance-button primary" disabled={disabled || !entries.length} onClick={prepare}>更新加密授权副本</button>}
    {hasAccountCopy && <details><summary>本目录已包含加密授权副本</summary><div className="data-portability-options">
      <p className="data-portability-note">在新电脑输入迁移密码恢复账号授权。普通 Windows/浏览器配置目录受系统绑定，实际迁移的是 Hub 保存的授权、服务密码和已保存的网页登录连接。</p>
      {!include && <label className="data-portability-field">迁移密码<input type="password" autoComplete="off" value={password} disabled={disabled} onChange={event => { setPassword(event.target.value); setPreview(null); }} /></label>}
      <button className="maintenance-button" disabled={disabled || !password} onClick={inspect}>解锁并检查授权</button>
      {preview && <><fieldset className="account-migration-entries"><legend>选择需要恢复的授权</legend>{preview.entries.map(entry => <label key={entry.id} className="data-portability-checkbox"><input type="checkbox" checked={selected.includes(entry.id)} disabled={disabled || !entry.supported} onChange={event => select(entry.id, event.target.checked)} /><span>{entry.label}{entry.conflict && <small>本机已有授权，默认保留</small>}</span></label>)}</fieldset>
        <label className="data-portability-checkbox"><input type="checkbox" checked={overwrite} disabled={disabled} onChange={event => setOverwrite(event.target.checked)} />替换所选账号在本机已有的授权</label>
        <div className="data-portability-actions"><button className="maintenance-button" disabled={disabled} onClick={() => { setPassword(""); setPreview(null); setSelected([]); }}>取消恢复授权</button><button className="maintenance-button" disabled={disabled || !selected.length} onClick={apply}>恢复所选授权</button></div></>}
      <button className="maintenance-button" disabled={disabled} onClick={() => {
        if (window.confirm("移除当前数据目录中的加密授权迁移副本？本机当前登录不受影响。")) void run("正在移除授权迁移副本…", async () => { await call("remove_accounts_copy"); setPassword(""); setPreview(null); onPrepared(); });
      }}>移除迁移用授权副本</button>
    </div></details>}
    {busy && <p role="status">{busy}</p>}{error && <p role="alert" className="data-portability-error">{error}</p>}{notice && <p role="status" className="data-portability-notice">{notice}</p>}
    {!!warnings.length && <ul className="data-portability-warnings">{warnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul>}
    {result && <><ul>{result.results.map((item,index) => <li key={index}>{item.label}：{item.status === "imported" ? "已恢复" : item.status === "skipped" ? "已跳过" : "未成功"}{item.message && `（${item.message}）`}</li>)}</ul><ul className="data-portability-warnings">{result.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></>}
  </div>;
}
