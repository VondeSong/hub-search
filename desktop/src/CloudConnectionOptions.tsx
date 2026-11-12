import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, ChevronRight, Cloud, KeyRound, LoaderCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import "./CloudConnectionOptions.css";

type OssConfig = { bucket: string; region: string; prefix: string; accessKeyId: string };
type CloudSettings = {
  provider: "none" | "oss";
  configured?: boolean;
  name?: string;
  migrationBlocked?: boolean;
  legacyRetired?: boolean;
  oss?: OssConfig;
  hasSecret: boolean;
  mediaPolicy: "all" | "onDemand";
  migration?: { state: string; error?: string } | null;
};
type Flow = "location" | "credentials" | "verify" | "check" | null;
const empty: OssConfig = { bucket: "", region: "cn-hangzhou", prefix: "HubFlashcards", accessKeyId: "" };
const location = (c: OssConfig) => JSON.stringify([c.bucket.trim(), c.region.trim(), c.prefix.trim().replace(/^\/+|\/+$/g, "") || "HubFlashcards"]);

export function CloudConnectionOptions({ syncing, onChanged, onProviderChange, transfersAllowed = true, onBusyChange }: {
  syncing: boolean;
  onChanged: () => Promise<void>;
  onProviderChange?: (provider: CloudSettings["provider"]) => void;
  transfersAllowed?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [flow, setFlow] = useState<Flow>(null);
  const [draft, setDraft] = useState(empty);
  const [name, setName] = useState("我的 Hub");
  const [secret, setSecret] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const mounted = useRef(true);
  const loadSequence = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const connected = settings?.configured ?? (settings?.provider === "oss" && Boolean(settings.oss));
  const moving = Boolean(connected && settings?.oss && location(settings.oss) !== location(draft));
  const blocked = syncing || Boolean(busy) || !settings;
  const needsSecret = !settings?.hasSecret || draft.accessKeyId.trim() !== settings?.oss?.accessKeyId;

  const load = async () => {
    const request = ++loadSequence.current;
    setError("");
    try {
      const next = await invoke<CloudSettings>("get_flashcard_cloud_sync_settings");
      if (mounted.current && request === loadSequence.current) setSettings(next);
    } catch (e) { if (mounted.current && request === loadSequence.current) setError(String(e)); }
  };
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; ++loadSequence.current; };
  }, []);
  useEffect(() => { if (settings) onProviderChange?.(settings.provider); }, [settings?.provider, onProviderChange]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => { if (flow) heading.current?.focus(); }, [flow]);

  const begin = (next: Exclude<Flow, null>) => {
    setDraft(settings?.oss || empty); setName(settings?.name || "我的 Hub");
    setSecret(""); setAck(false); setError(""); setMessage(""); setFlow(next);
  };
  const cancel = () => { setFlow(null); setSecret(""); setError(""); setAck(false); };
  const update = (key: keyof OssConfig, value: string) => {
    setDraft(v => ({ ...v, [key]: value })); setAck(false); setError("");
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    if (flow === "location") { setError(""); setFlow("verify"); return; }
    if (moving && flow === "verify" && (!ack || !transfersAllowed || settings?.migrationBlocked)) return;
    const checkOnly = flow === "check";
    setBusy(checkOnly ? "正在检查连接…" : moving && flow === "verify" ? "正在迁移并核验…" : "正在检查并保存…");
    setError(""); setMessage("");
    try {
      if (checkOnly) {
        const result = await invoke<string>("test_flashcard_oss_connection");
        if (mounted.current) { setMessage(result); setFlow(null); }
      } else {
        const next = await invoke<CloudSettings>("save_cloud_connection", {
          oss: draft,
          secret: secret || null,
          change: flow === "credentials" ? "credentials" : connected ? "location" : "connect",
          name: flow === "credentials" ? null : name,
          otherDevicesReady: ack,
        });
        if (!mounted.current) return;
        setSettings(next); setFlow(null); setSecret(""); setAck(false);
        setMessage(flow === "credentials" ? "新凭据已检查并保存，云空间保持不变。" : moving ? "迁移与读回核验通过，已使用新云空间。" : "连接已检查并保存，内容同步结果请查看概览。");
        try { await onChanged(); }
        catch { if (mounted.current) setError("连接已保存，但同步状态刷新失败。可切回概览重新读取。"); }
      }
    } catch (e) {
      if (!mounted.current) return;
      setError(String(e));
      await invoke<CloudSettings>("get_flashcard_cloud_sync_settings").then(next => { if (mounted.current) setSettings(next); }).catch(() => undefined);
    } finally { if (mounted.current) setBusy(""); }
  };

  if (!settings) return <div className="cloud-connection-options" aria-busy={!error}>
    <p role={error ? "alert" : "status"}>{error || "正在读取云连接…"}</p>
    {error && <button onClick={() => void load()}>重新读取连接</button>}
  </div>;

  const credentials = <>
    <label><span>AccessKey ID</span><input required value={draft.accessKeyId} onChange={e => update("accessKeyId", e.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label><span>AccessKey Secret</span><input type="password" required={needsSecret} value={secret} onChange={e => setSecret(e.target.value)} placeholder={needsSecret ? "填写此密钥对应的 Secret" : "已安全保存；留空沿用"} autoComplete="new-password" /></label>
    <p>使用只允许访问同步目录的专用密钥，仅保存在本设备。检查失败会保留原连接与凭据。</p>
  </>;
  return <div className="cloud-connection-options" aria-busy={Boolean(busy)}>
    <h3>{connected ? "管理云空间" : "连接一个云空间"}</h3>
    <p>日常无需修改连接。更新凭据与更换云空间分别处理。</p>
    <div className="cloud-connection-summary">
      <span className="cloud-connection-icon"><Cloud size={22} aria-hidden="true" /></span>
      <div><strong>{connected ? settings.name || "我的 Hub" : "尚未连接"}</strong><p>{connected && settings.oss ? `${settings.oss.bucket} · ${settings.oss.region} · ${settings.oss.prefix}` : "电脑和手机使用同一个云空间"}</p></div>
      {connected && <span className="cloud-connection-tag">当前连接</span>}
    </div>
    {!flow && <div className="cloud-connection-actions">
      {connected && <><button disabled={blocked} onClick={() => begin("credentials")}><KeyRound size={15} aria-hidden="true" />更新凭据</button><button disabled={blocked || !settings.hasSecret} onClick={() => begin("check")}>检查连接</button></>}
      <button disabled={blocked} onClick={() => begin("location")}>{connected ? "更换云空间" : "连接阿里云 OSS"}<ChevronRight size={15} aria-hidden="true" /></button>
    </div>}
    {settings.legacyRetired && <p className="cloud-connection-warning">旧 WebDAV（含坚果云）同步已停用。本机内容与待同步记录保留；本版本不会访问或删除旧云端文件。仅存在旧云端的内容，请先用旧版取回，再连接 OSS。</p>}
    {flow && <form className="cloud-connection-form" aria-label="管理云连接" aria-describedby={error ? "cloud-connection-error" : undefined} onSubmit={event => void submit(event)}>
      <h3 ref={heading} tabIndex={-1}>{flow === "location" ? "云空间位置" : flow === "credentials" ? "更新连接凭据" : flow === "check" ? "检查连接" : moving ? "确认迁移范围" : connected ? "检查并保存" : "检查并连接"}</h3>
      <fieldset disabled={blocked}>
        {flow === "location" && <>
          <label><span>连接名称</span><input required maxLength={60} value={name} onChange={e => setName(e.target.value)} /></label>
          <label><span>Bucket 名称</span><input required minLength={3} maxLength={63} pattern="[a-z0-9][a-z0-9-]{1,61}[a-z0-9]" value={draft.bucket} onChange={e => update("bucket", e.target.value)} spellCheck={false} /></label>
          <label><span>地域</span><input required value={draft.region} onChange={e => update("region", e.target.value)} placeholder="cn-hangzhou" spellCheck={false} /></label>
          <label><span>目录前缀</span><input maxLength={180} pattern="[a-zA-Z0-9_/-]*" value={draft.prefix} onChange={e => update("prefix", e.target.value)} spellCheck={false} /></label>
          <p>位置变化才进入迁移；仅更新密钥请返回“更新凭据”。</p>
        </>}
        {flow === "credentials" && credentials}
        {flow === "check" && <p>检查当前 OSS 目录的列表、上传、下载与读回权限，不执行内容同步。检查成功不代表内容已同步。</p>}
        {flow === "verify" && <>
          <p className="cloud-connection-destination">{name} · {draft.bucket} · {draft.region} · {draft.prefix || "HubFlashcards"}</p>
          {moving && <>
            <ul className="cloud-connection-scope"><li><Check size={14} aria-hidden="true" />闪卡、复习记录与闪卡附件</li><li><Check size={14} aria-hidden="true" />阅读正文、记录与阅读附件</li></ul>
            <p className="cloud-connection-warning">速记尚未纳入统一迁移与恢复，不能随云空间迁移。</p>
            {settings.migrationBlocked ? <p role="alert">速记已绑定当前云空间，暂时不能切换。请保留原连接。</p> : <label className="cloud-connection-check"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>其它设备已同步并暂停编辑与自动同步</span></label>}
            {!transfersAllowed && <p>此设备已暂停，请先恢复云同步才能迁移内容。</p>}
            <p>读回核验通过后才切换；失败继续使用原连接，原云副本保留。</p>
          </>}
          {credentials}
          {!moving && <p>{transfersAllowed ? "连接检查不会开始内容同步；正文和附件仍按同步设置处理。" : "本设备已暂停，保存连接后仍不会开始内容同步。"}</p>}
        </>}
        <div className="cloud-connection-form-actions">
          {flow === "verify" && <button type="button" onClick={() => { setFlow("location"); setError(""); }}>上一步</button>}
          <button type="button" onClick={cancel}>取消</button>
          <button className="cloud-primary" disabled={flow === "verify" && moving && (!ack || !transfersAllowed || settings.migrationBlocked)} type="submit">{busy ? <><LoaderCircle size={15} className="spin" aria-hidden="true" />{busy}</> : flow === "location" ? "下一步" : flow === "credentials" ? "检查并保存凭据" : flow === "check" ? "开始检查" : moving ? "开始迁移并核验" : "检查并保存连接"}</button>
        </div>
      </fieldset>
      {settings.migration?.state === "partial" && moving && <p role="status">上次迁移未完成，仍使用原连接。保持相同目标，再次执行可继续。{settings.migration.error}</p>}
    </form>}
    {error && <p id="cloud-connection-error" role="alert">{error}</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}
