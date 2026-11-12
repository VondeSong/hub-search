import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runtimeCapabilities } from "./RuntimePlatform";
import "./ReadingAttachments.css";

export type CloudMaintenancePlan = {
  token: string; purpose: "cleanup" | "restore"; state: string; phase: string;
  objects: number; read: number; checkpoints: number; verified: number; deleted: number;
  stagedBytes: number; createdAt: number; completedAt: number;
  canAdvance: boolean; canClean: boolean; canRestore: boolean; errors: string[];
  modules: { module: string; objects: number; read: number; checkpoints: number; verified: number }[];
};
export type CloudMaintenanceStatus = {
  supported: boolean; currentDevice: string; confirmedCheckpoint: string;
  devices: { device: string; label: string; platform: string; local: boolean; lastSeenAt: number; retired: boolean; longOffline: boolean; confirmedCheckpoint: string }[];
  plan: CloudMaintenancePlan | null;
};
const phases: Record<string, string> = {
  read: "读取历史", build: "归并并检查覆盖范围", publish: "发布检查点", verify: "核验云端检查点",
  ready: "检查点已核验", deleteVerify: "删除前再次校验", delete: "清理已覆盖记录", done: "本轮已结束",
  restoreReady: "恢复范围已检查", restoreSourceVerify: "恢复前再次校验", restoreVerify: "恢复前再次校验", restore: "合并恢复记录", released: "本机维护暂存已释放",
};
const moduleNames: Record<string, string> = { flashcards: "闪卡", webdavSnapshot: "旧版闪卡快照", reading: "阅读正文与状态", copies: "资料库副本记录", manifests: "附件清单", devices: "设备记录" };
const size = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const progress = (plan: CloudMaintenancePlan) => [plan.state, plan.phase, plan.read, plan.checkpoints, plan.verified, plan.deleted].join(":");

export function CloudMaintenance({ blocked = false, onBusyChange }: { blocked?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [status, setStatus] = useState<CloudMaintenanceStatus | null>(null);
  const [plan, setPlan] = useState<CloudMaintenancePlan | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const running = useRef(false), mounted = useRef(true), generation = useRef(0);
  const readStatus = async (id = generation.current) => {
    const next = await invoke<CloudMaintenanceStatus>("get_cloud_maintenance_status");
    if (mounted.current && generation.current === id) { setStatus(next); setPlan(next.plan); }
  };
  useEffect(() => {
    mounted.current = true;
    void readStatus().catch(reason => { if (mounted.current) setError(String(reason)); });
    const changed = (event: Event) => {
      if ((event as CustomEvent).detail === "cloud-maintenance-restored") {
        void readStatus().catch(reason => { if (mounted.current) setError(String(reason)); }); return;
      }
      generation.current++; setStatus(null); setPlan(null); setConfirmed(false); setNotice("");
      void readStatus().catch(reason => { if (mounted.current) setError(String(reason)); });
    };
    window.addEventListener("hub:cloud-data-changed", changed);
    return () => { mounted.current = false; generation.current++; window.removeEventListener("hub:cloud-data-changed", changed); };
  }, []);
  useEffect(() => { onBusyChange?.(Boolean(busy)); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const run = async (label: string, action: (id: number) => Promise<void>, local = false) => {
    if (running.current || (!local && blocked)) return;
    const id = generation.current; running.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(id); }
    catch (reason) { if (mounted.current && generation.current === id) setError(String(reason)); }
    finally { running.current = false; if (mounted.current) setBusy(""); }
  };
  const rounds = async (command: string, first: CloudMaintenancePlan, id: number, shouldContinue: (value: CloudMaintenancePlan) => boolean) => {
    let value = first;
    // Each backend request owns a bounded durable round. Closing the view stops the next
    // request; a completed in-flight round remains resumable after reopening the app.
    for (let count = 0; count < 100 && mounted.current && generation.current === id; count++) {
      const next = await invoke<CloudMaintenancePlan>(command, { token: value.token });
      if (!mounted.current || generation.current !== id) return;
      setPlan(next); value = next;
      if (next.errors.length || !shouldContinue(next)) break;
      if (progress(next) === progress(first)) throw new Error("本轮尚未取得新进展，已停止继续请求；可检查原因后重试。");
      first = next;
    }
    if (mounted.current && generation.current === id && !value.errors.length) {
      setNotice(shouldContinue(value) ? "本轮进度已保存，可继续剩余范围。" : command === "restore_cloud_history" ? "云端同步记录已合并到本机；附件仍按现有下载策略获取。" : "本轮进度已保存。");
    }
  };
  const preview = (restore: boolean) => void run(restore ? "正在预览恢复范围…" : "正在预览历史范围…", async id => {
    const next = await invoke<CloudMaintenancePlan>(restore ? "preview_cloud_restore" : "preview_cloud_history_cleanup");
    if (mounted.current && generation.current === id) { setPlan(next); setConfirmed(false); }
  });
  const prepare = () => plan && void run(plan.purpose === "restore" ? "正在检查恢复范围…" : "正在准备并核验检查点…", id => rounds(plan.purpose === "restore" ? "advance_cloud_restore" : "advance_cloud_history_cleanup", plan, id, value => value.canAdvance));
  const clean = () => plan && confirmed && void run("正在清理已覆盖历史…", id => rounds("clean_cloud_history", plan, id, value => value.canClean));
  const restore = () => plan && void run("正在恢复云端同步记录…", async id => {
    await rounds("restore_cloud_history", plan, id, value => ["restore", "restoreVerify", "restoreSourceVerify"].includes(value.phase));
    if (mounted.current && generation.current === id) {
      const next = await invoke<CloudMaintenanceStatus>("get_cloud_maintenance_status");
      if (mounted.current && generation.current === id) setStatus(next);
      window.dispatchEvent(new Event("hub:reading-data-changed"));
      window.dispatchEvent(new CustomEvent("hub:cloud-data-changed", { detail: "cloud-maintenance-restored" }));
    }
  });
  const refreshDevices = () => void run("正在刷新云设备记录…", async id => {
    const next = await invoke<CloudMaintenanceStatus>("refresh_cloud_devices");
    if (mounted.current && generation.current === id) { setStatus(next); setPlan(next.plan); }
  });
  const retired = (device: string, value: boolean) => void run("正在更新设备记录…", async id => {
    const next = await invoke<CloudMaintenanceStatus>("set_cloud_device_retired", { device, retired: value });
    if (mounted.current && generation.current === id) setStatus(next);
  });
  const release = () => void run("正在释放本机维护暂存…", async id => {
    const next = await invoke<CloudMaintenanceStatus>("release_cloud_maintenance");
    if (mounted.current && generation.current === id) { setStatus(next); setPlan(next.plan); setConfirmed(false); setNotice("本机维护暂存已释放；云记录、阅读内容和附件文件均保留。继续维护需重新预览。"); }
  }, true);
  const locked = blocked || Boolean(busy) || !status?.supported;
  return <section className="cloud-sync-card reading-attachments reading-recovery" aria-label="云端设备与维护">
    <h3>云端设备与维护</h3>
    <p>设备记录表示上次成功同步或主动确认，不是在线状态。旧版本设备可能尚未登记；长期离线设备应先从云端恢复并合并本机改动。</p>
    {busy && <p role="status">{busy}</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <button disabled={locked} onClick={refreshDevices}>刷新设备记录</button>
    <ul>{status?.devices.map(device => <li key={device.device}><div><strong>{device.local ? `本机 · ${device.label}` : device.label}</strong>
      <small>{device.retired ? "已标记退休" : "参与同步"}{device.lastSeenAt ? ` · 上次记录 ${new Date(device.lastSeenAt * 1000).toLocaleString()}` : " · 尚无云端活动记录"}</small>
      {device.longOffline && <small>已长期离线或尚未确认活动；重新使用前先恢复同步记录。</small>}
      {device.confirmedCheckpoint && <small>此设备已有检查点确认记录；不代表后续更新已同步。</small>}
    </div>{runtimeCapabilities.desktop && !device.local && <button disabled={locked} onClick={() => retired(device.device, !device.retired)}>{device.retired ? "重新纳入设备记录" : "标记退休"}</button>}</li>)}</ul>
    <p>退休标记只管理设备记录与确认范围，不会删除本机内容或撤销云服务密钥；失去设备时仍需在云服务管理授权。</p>
    <details><summary>本机维护暂存</summary><p>遇到暂存上限或不再继续旧批次时，可释放所有本机维护暂存。旧批次不能续跑，重新预览会再次读取云记录。此操作不清理云端、阅读内容或附件文件。</p><button disabled={Boolean(busy)} onClick={release}>释放本机维护暂存</button></details>
    <details><summary>从云端恢复同步记录</summary>
      <p>先读取并核验当前云端范围，再合并到本机，保留本机未同步修改。不覆盖数据库文件，不重新执行来源或资料库保存操作；附件文件继续由按需下载和离线入口获取。</p>
      <button disabled={locked} onClick={() => preview(true)}>预览恢复范围</button>
    </details>
    {runtimeCapabilities.desktop && <details><summary>检查点与历史清理</summary>
      <p>先归并并读回校验检查点，再单独确认清理。仅移除已被确切覆盖的不可变历史；保留删除记录、复习事实、并发新增对象及全部附件文件。</p>
      <p>维护会读取云内容并产生流量；每次请求最多处理 100 项，进度保存在本机。读取范围上限 200000 项、暂存上限 2 GB，达到限制停止并保留原历史。清理需要当前目录的删除权限。</p>
      <button disabled={locked} onClick={() => preview(false)}>预览历史清理范围</button>
    </details>}
    {plan && <div className="reading-offline-plan">
      <p>{plan.purpose === "restore" ? "恢复范围" : "维护范围"}：{phases[plan.phase] || "等待处理"} · 读取 {plan.read}/{plan.objects} 项 · 已验证检查点 {plan.verified}/{plan.checkpoints} 项 · 已清理 {plan.deleted} 项 · 暂存 {size(plan.stagedBytes)}</p>
      {plan.errors.map(reason => <p key={reason} role="alert">{reason}</p>)}
      <ul>{plan.modules.map(module => <li key={module.module}><div><strong>{moduleNames[module.module] || "同步记录"}</strong><small>读取 {module.read}/{module.objects} 项 · 检查点 {module.verified}/{module.checkpoints} 项</small></div></li>)}</ul>
      {plan.canAdvance && (plan.purpose === "restore" || runtimeCapabilities.desktop) && <button disabled={locked} onClick={prepare}>{plan.purpose === "restore" ? "检查恢复范围" : "准备并核验检查点"}</button>}
      {plan.canRestore && <button disabled={locked} onClick={restore}>恢复并确认本设备</button>}
      {runtimeCapabilities.desktop && plan.canClean && <div>
        <label className="reading-offline-option"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} />已确认设备状态，并同意由核验后的检查点替代这些旧历史</label>
        <button disabled={locked || !confirmed} onClick={clean}>清理已覆盖历史</button>
      </div>}
      {plan.phase === "done" && !plan.objects && <p>当前没有需要读取的云记录。</p>}
    </div>}
  </section>;
}
