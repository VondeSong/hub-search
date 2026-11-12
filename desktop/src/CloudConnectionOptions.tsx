import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./CloudConnectionOptions.css";

type OssConfig = { bucket: string; region: string; prefix: string; accessKeyId: string };
type CloudSettings = { provider: "none" | "oss"; legacyRetired?: boolean; oss?: OssConfig; hasSecret: boolean; deviceId: string; mediaPolicy: "all" | "onDemand"; migration?: { state: string; error?: string; updatedAt?: number } | null };
type Report = { uploadedBytes: number; downloadedBytes: number; pendingMedia: number; uploadedChanges: number; downloadedChanges: number; completedAt: number };
const empty: OssConfig = { bucket: "", region: "cn-hangzhou", prefix: "HubFlashcards", accessKeyId: "" };

export function CloudConnectionOptions({ syncing, onChanged, onProviderChange, transfersAllowed = true, onBusyChange, showDownloadPolicy = true }: { syncing: boolean; onChanged: () => Promise<void>; onProviderChange?: (provider: CloudSettings["provider"]) => void; transfersAllowed?: boolean; onBusyChange?: (busy: boolean) => void; showDownloadPolicy?: boolean }) {
  const [settings, setSettings] = useState<CloudSettings | null>(null);
  const [oss, setOss] = useState(empty);
  const [secret, setSecret] = useState("");
  const [policy, setPolicy] = useState<"all" | "onDemand">("all");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    void invoke<CloudSettings>("get_flashcard_cloud_sync_settings").then(s => {
      if (!active) return;
      setSettings(s); setOss(s.oss || empty); setPolicy(s.mediaPolicy); setLoaded(true);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (settings) onProviderChange?.(settings.provider);
  }, [settings?.provider, onProviderChange]);
  useEffect(() => {
    if (syncing) return;
    let active = true;
    void invoke<Report | null>("get_flashcard_cloud_sync_report").then(r => { if (active) setReport(r); }).catch(() => {});
    return () => { active = false; };
  }, [syncing, settings]);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const dirty = secret !== "" || JSON.stringify(oss) !== JSON.stringify(settings?.oss || empty) || policy !== (settings?.mediaPolicy || "all");
  const movingActiveOss = settings?.provider === "oss" && Boolean(settings.oss) && JSON.stringify(oss) !== JSON.stringify(settings.oss);
  const disabled = !!busy || syncing || !loaded;
  const run = async (action: "save" | "test" | "oss") => {
    setBusy(action); setError(""); setMessage("");
    try {
      if (action === "test") setMessage(await invoke<string>("test_flashcard_oss_connection"));
      else {
        const next = action === "save"
          ? await invoke<CloudSettings>("save_flashcard_oss_config", { oss, secret: secret || null, mediaPolicy: policy, otherDevicesReady: ready })
          : await invoke<CloudSettings>("activate_flashcard_cloud_sync", { target: action });
        setSettings(next); setOss(next.oss || empty); setPolicy(next.mediaPolicy); setSecret("");
        setReady(false);
        setMessage(action === "save" ? next.provider === "oss" ? "阿里云 OSS 配置已保存，后续同步使用此配置。" : "配置已保存，可测试连接并启用云空间。" : "OSS 连接已启用，内容同步结果请查看概览。");
        await onChanged();
      }
    } catch (e) {
      setError(String(e));
      await invoke<CloudSettings>("get_flashcard_cloud_sync_settings").then(setSettings).catch(() => undefined);
    } finally { setBusy(""); }
  };
  const update = (key: keyof OssConfig, value: string) => { setOss(v => ({ ...v, [key]: value })); setReady(false); };
  const size = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
  const targetReady = !dirty && !!settings?.oss && settings.hasSecret;
  return <div className="cloud-connection-options">
    <div className="cloud-sync-section-heading"><strong id="cloud-sync-connection-title">云服务</strong></div>
    <p className="cloud-connection-current">当前同步服务：<strong>{settings ? settings.provider === "oss" ? "阿里云 OSS" : "尚未连接" : "读取中…"}</strong></p>
    {settings?.legacyRetired && <p role="status">旧 WebDAV（含坚果云）同步已停用。本机内容、附件和待同步记录保留；本版本不会访问或删除旧云端文件。仅存在旧云端的内容，请先用旧版取回，再连接 OSS。</p>}
    <section aria-label="阿里云 OSS 配置">
      <div className="cloud-sync-section-heading"><strong>阿里云 OSS 配置</strong></div>
      <p>先创建私有 Bucket，使用只允许访问本同步目录的专用密钥。密钥仅保存在本设备安全存储中。</p>
      <fieldset disabled={disabled}>
        <label><span>Bucket 名称</span><input value={oss.bucket} onChange={e => update("bucket", e.target.value)} placeholder="你的私有 Bucket 名称" spellCheck={false} /></label>
        <label><span>地域</span><input value={oss.region} onChange={e => update("region", e.target.value)} placeholder="cn-hangzhou" spellCheck={false} /></label>
        <label><span>同步目录</span><input value={oss.prefix} onChange={e => update("prefix", e.target.value)} spellCheck={false} /></label>
        <label><span>AccessKey ID</span><input value={oss.accessKeyId} onChange={e => update("accessKeyId", e.target.value)} autoComplete="off" spellCheck={false} /></label>
        <label><span>AccessKey Secret</span><input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={settings?.hasSecret ? "已安全保存；留空保持" : "专用密钥，不要发到聊天里"} autoComplete="new-password" /></label>
        {showDownloadPolicy && <label><span>闪卡附件下载</span><select value={policy} onChange={e => setPolicy(e.target.value as typeof policy)}><option value="all">全部下载，供离线使用</option><option value="onDemand">打开时下载，减少占用</option></select></label>}
        {movingActiveOss && <><p>更改正在使用的云位置会迁移全部模块。分批传输未结束前继续使用原位置，再次保存可继续；原云数据保留。</p><label className="cloud-auto-sync"><input type="checkbox" checked={ready} onChange={e => setReady(e.target.checked)} /><span>其它设备已同步并暂停编辑和自动同步</span></label></>}
        <div className="cloud-sync-actions"><button disabled={!dirty || (movingActiveOss && (!ready || !transfersAllowed))} onClick={() => void run("save")}>{busy === "save" ? "保存中…" : movingActiveOss ? "迁移并保存 OSS 配置" : "保存 OSS 配置"}</button><button disabled={!settings?.oss || dirty} onClick={() => void run("test")}>{busy === "test" ? "校验中…" : "测试 OSS 连接"}</button></div>
      </fieldset>
    </section>
    {settings?.provider === "none" && <section className="cloud-connection-switch" aria-label="连接云空间">
      <p>电脑和手机使用同一 OSS 目录。启用连接只保存配置，内容按同步方式和附件策略处理。</p>
      <fieldset disabled={disabled}>
        {!transfersAllowed && <p>本设备已暂停，启用连接后仍不会开始同步。</p>}
        <div className="cloud-sync-actions"><button className="primary" disabled={!targetReady} onClick={() => void run("oss")}>{busy === "oss" ? "正在启用…" : "连接 OSS 云空间"}</button></div>
      </fieldset>
      <p>连接失败可重试，本机内容与云端文件保留。</p>
    </section>}
    {settings?.provider === "oss" && report && <details className="cloud-sync-help"><summary>最近一次 OSS 传输详情</summary><p>上传 {report.uploadedChanges} 项变更（{size(report.uploadedBytes)}），下载 {report.downloadedChanges} 项变更（{size(report.downloadedBytes)}）。<br />{report.pendingMedia ? `本次同步结束时有 ${report.pendingMedia} 个附件待下载，可打开附件或再次同步下载。` : "本次同步结束时，所需附件均已在本机。"}</p></details>}
    {(error || message) && <p role={error ? "alert" : "status"} className={error ? "cloud-sync-last-error" : ""}>{error || message}</p>}
    {settings?.migration?.state === "partial" && <p role="status">上次迁移未完成，当前仍使用原服务。{settings.migration.error} 保持目标配置和暂停状态，再次执行可继续。</p>}
  </div>;
}
