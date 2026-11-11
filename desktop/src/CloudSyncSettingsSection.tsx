import { QuickJournal } from "./QuickJournal";
import { defaultJournalView } from "./JournalViews";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, LoaderCircle } from "lucide-react";
import { CloudConnectionOptions } from "./CloudConnectionOptions";
import { ReadingMediaSettings } from "./ReadingMediaSettings";
import { ReadingNetworkSettings } from "./ReadingNetworkSettings";
import { ReadingSourceCleanupSettings } from "./ReadingSourceRecovery";
import { runtimeCapabilities } from "./RuntimePlatform";
import { CloudMaintenance } from "./CloudMaintenance";
import { consumeCloudSyncSettingsSection } from "./CloudSyncEvents";
import { useVisiblePolling } from "./useVisiblePolling";
import "./ReadingAttachments.css";
import type { FlashcardSyncHistoryItem, FlashcardSyncSettings, FlashcardSyncSummary } from "./FlashcardTypes";
import "./CloudSyncSettingsSection.css";

export type CloudSyncPolicy = { enabled: boolean; autoSync: boolean; flashcards: boolean; reading: boolean };
type ReadingReport = { uploaded: number; downloaded: number; pending: number; completedAt: number; media?: { uploaded: number; downloaded: number; failed: number; pending: number }; copies?: { uploaded: number; downloaded: number; pending: number } };
type ReadingSyncState = { supported: boolean; running: boolean; lastError: string; report: ReadingReport | null };
const time = (value?: number) => value ? new Date(value * 1000).toLocaleString() : "尚未同步";

export function CloudSyncSettingsSection({ active = true }: { active?: boolean } = {}) {
  const [policy, setPolicy] = useState<CloudSyncPolicy | null>(null);
  const [connection, setConnection] = useState<FlashcardSyncSettings | null>(null);
  const [reading, setReading] = useState<ReadingSyncState | null>(null);
  const [history, setHistory] = useState<FlashcardSyncHistoryItem[]>([]);
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [provider, setProvider] = useState<"webdav" | "oss">("webdav");
  const [locationReady, setLocationReady] = useState(false);
  const [busy, setBusy] = useState("");
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const mounted = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!policy) return;
    if (consumeCloudSyncSettingsSection() === "dida-cleanup") {
      const target = sectionRef.current?.querySelector<HTMLElement>("#dida-reading-cleanup-settings");
      target?.scrollIntoView?.({ block: "center" });
      target?.focus({ preventScroll: true });
    }
  }, [policy]);
  const refresh = async () => {
    const [settings, status, recent, readingState] = await Promise.all([
      invoke<CloudSyncPolicy>("get_cloud_sync_policy"),
      invoke<FlashcardSyncSettings>("get_flashcard_sync_settings"),
      invoke<FlashcardSyncHistoryItem[]>("list_flashcard_sync_history", { limit: 20 }),
      invoke<ReadingSyncState>("get_reading_sync_status"),
    ]);
    if (!mounted.current) return;
    setPolicy(settings); setConnection(status); setHistory(recent); setReading(readingState);
    return status;
  };
  useEffect(() => {
    mounted.current = true;
    void refresh().then(status => {
      if (status) { setUrl(status.url); setUsername(status.username); }
    }).catch(e => { if (mounted.current) setError(String(e)); });
    return () => { mounted.current = false; };
  }, []);
  useVisiblePolling(async () => {
    if (running.current) return;
    const next = await invoke<ReadingSyncState>("get_reading_sync_status");
    if (mounted.current) setReading(next);
  }, active && Boolean(policy), 5000, { initialDelayMs: 5000 });
  const run = async (label: string, action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { running.current = false; if (mounted.current) setBusy(""); }
  };
  const updatePolicy = (change: Partial<CloudSyncPolicy>) => {
    if (!policy) return;
    void run("正在保存；如有传输，等待本次结束…", async () => {
      const next = await invoke<CloudSyncPolicy>("update_cloud_sync_policy", { settings: { ...policy, ...change } });
      if (mounted.current) { setPolicy(next); setNotice("本设备的同步设置已保存"); }
    });
  };
  const saveConnection = (clearPassword = false) => void run("正在保存连接…", async () => {
    const next = await invoke<FlashcardSyncSettings>("update_flashcard_sync_settings", {
      url, username, password: password || null, clearPassword, autoSync: null,
      otherDevicesReady: locationReady,
    });
    if (mounted.current) { setConnection(next); setUrl(next.url); setUsername(next.username); setPassword(""); setLocationReady(false); setNotice("WebDAV 配置已保存"); }
  });
  const changed = async () => {
    // Consumers refresh their lists, while their active review/editor session stays intact.
    window.dispatchEvent(new Event("hub:cloud-data-changed"));
    await refresh();
  };
  const sync = () => void run("正在同步闪卡和附件…", async () => {
    try {
      const result = await invoke<FlashcardSyncSummary>("sync_flashcards");
      if (mounted.current) setNotice(`闪卡同步完成：下载 ${result.downloadedCards} 张卡片，合并 ${result.mergedReviews} 条复习记录${result.cloudReport?.pendingMedia ? `，${result.cloudReport.pendingMedia} 个附件待下载` : ""}。`);
    } catch (reason) {
      // A partial transfer can already have committed remote records, even when media failed.
      await changed().catch(() => undefined);
      throw reason;
    }
    await changed();
  });
  const syncReading = () => void run("正在同步阅读内容…", async () => {
    try {
      const result = await invoke<ReadingReport>("sync_reading");
      if (mounted.current) setNotice(`阅读本轮同步结束：上传 ${result.uploaded} 条，接收 ${result.downloaded} 条${result.pending ? `，还有 ${result.pending} 条待同步` : ""}。`);
    } finally {
      window.dispatchEvent(new Event("hub:reading-data-changed"));
      await refresh().catch(() => undefined);
    }
  });
  const locked = Boolean(busy) || connectionBusy || maintenanceBusy || !policy || !connection;
  const dirty = url !== connection?.url || username !== connection?.username || Boolean(password);
  const movingActiveWebdav = provider === "webdav" && Boolean(connection?.url) && (url !== connection?.url || username !== connection?.username);
  return <section ref={sectionRef} className="settings-category cloud cloud-sync-center" aria-label="云同步设置">
    <header><Cloud size={22} /><div><h2>云同步</h2><p>管理本设备的云连接与同步范围。</p></div></header>
    {runtimeCapabilities.mobile && <QuickJournal libraries={[]} scope={null} view={defaultJournalView()} dataVersion="cloud-settings" mode="settings" />}
    <div className="cloud-sync-notice" aria-live="polite">
      {busy && <p role="status"><LoaderCircle size={15} className="spin" />{busy}</p>}
      {error && <p role="alert">{error}</p>}
      {!busy && notice && <p role="status">{notice}</p>}
      {!policy && !busy && <button onClick={() => void run("正在读取设置…", async () => { const next = await refresh(); if (next) { setUrl(next.url); setUsername(next.username); } })}>重新读取设置</button>}
    </div>
    <section className="cloud-sync-card" aria-label="本设备同步开关">
      <label className="cloud-sync-switch"><span><strong>启用云同步</strong><small>关闭后停止内容同步和云附件下载，已有内容与待同步改动保留。</small></span><input aria-label="启用云同步" type="checkbox" checked={policy?.enabled ?? false} disabled={locked} onChange={e => updatePolicy({ enabled: e.target.checked })} /></label>
      <label className="cloud-sync-switch"><span><strong>自动同步</strong><small>应用运行时自动上传改动并检查云端更新。关闭后仍可手动同步。</small></span><input aria-label="自动同步" type="checkbox" checked={policy?.autoSync ?? false} disabled={locked || !policy?.enabled} onChange={e => updatePolicy({ autoSync: e.target.checked })} /></label>
      <p>这些开关只影响本设备。{runtimeCapabilities.mobile ? "手机阅读会在打开或返回应用时自动补同步，后台不启动新的阅读自动同步。" : "手机后台同步可能受系统限制。"}</p>
    </section>
    <section className="cloud-sync-card" aria-label="同步内容">
      <h3>同步内容</h3>
      <label className="cloud-sync-switch"><span><strong>闪卡</strong><small>卡片、收件箱、复习记录、质量反馈和附件。</small></span><input aria-label="同步闪卡" type="checkbox" checked={policy?.flashcards ?? false} disabled={locked || !policy?.enabled} onChange={e => updatePolicy({ flashcards: e.target.checked })} /></label>
      <label className="cloud-sync-switch"><span><strong>阅读</strong><small>正文、阅读状态、标签、归档和删除记录。支持阿里云 OSS 和 WebDAV。</small></span><input aria-label="同步阅读" type="checkbox" checked={policy?.reading ?? false} disabled={locked || !policy?.enabled || (!reading?.supported && !policy?.reading)} onChange={e => updatePolicy({ reading: e.target.checked })} /></label>
      <p>正文单篇上限 2 MB，每轮最多上传 32 MB、接收约 32 MB，另有校验流量。附件使用下面的独立策略。</p>
      {policy?.reading && <p>同步到 Hub 后，默认保留滴答里的原内容。{runtimeCapabilities.mobile ? "需要自动删除时，请在电脑端的 设置→云同步→滴答来源清理 中开启。正文和全部附件检查完整后才会删除。" : "需要自动删除时，请在下面的“滴答来源清理”中开启；正文和全部附件检查完整后才会删除。"}</p>}
      <p>资料库更新和保存到 Obsidian 等位置仍由各自的资料库设置管理。</p>
    </section>
    {policy?.reading && <p>切换云服务会迁移闪卡、阅读、原附件和副本记录，目标云逐项读回通过后才切换；原云副本保留。</p>}
    <section className="cloud-sync-card cloud-sync-settings" aria-label="云连接">
      <CloudConnectionOptions syncing={Boolean(busy) || maintenanceBusy || !policy || !connection} onBusyChange={setConnectionBusy} onProviderChange={setProvider} transfersAllowed={Boolean(policy?.enabled)}
        webdavReady={Boolean(connection?.url)} webdavDirty={dirty} onChanged={changed}
        webdavSettings={<>
          <label><span>WebDAV 目录地址</span><input value={url} onChange={e => { setUrl(e.target.value); setLocationReady(false); }} placeholder="https://dav.example.com/HubFlashcards/" spellCheck={false} /></label>
          <label><span>用户名</span><input value={username} onChange={e => { setUsername(e.target.value); setLocationReady(false); }} autoComplete="username" /></label>
          <label><span>密码</span><input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={connection?.hasPassword ? "已安全保存；留空保持" : "WebDAV 密码"} autoComplete="new-password" /></label>
          {movingActiveWebdav && <><p>更改正在使用的目录或账号会迁移全部模块，读回核验完成后才保存。未结束时再次保存可继续，原位置数据保留。</p><label className="cloud-auto-sync"><input type="checkbox" checked={locationReady} onChange={e => setLocationReady(e.target.checked)} /><span>其它设备已同步并暂停编辑和自动同步</span></label></>}
          <div className="cloud-sync-actions">
            {connection?.hasPassword && <button onClick={() => saveConnection(true)}>清除 WebDAV 密码</button>}
            <button disabled={!connection?.url || dirty} onClick={() => void run("正在测试连接…", async () => { const message = await invoke<string>("test_flashcard_sync_connection"); if (mounted.current) setNotice(message); })}>测试 WebDAV 连接</button>
            <button disabled={!url.trim() || (movingActiveWebdav && (!locationReady || !policy?.enabled))} onClick={() => saveConnection()}>{movingActiveWebdav ? "迁移并保存 WebDAV 配置" : "保存 WebDAV 配置"}</button>
          </div>
          <p>原有目录继续使用，无需改名。配置保存在本设备；连接测试会访问所选服务。保存配置不会切换云服务。</p>
        </>} />
    </section>
    <ReadingNetworkSettings active={active} />
    {runtimeCapabilities.desktop && <ReadingSourceCleanupSettings blocked={locked || !policy?.enabled || !policy?.reading || !reading?.supported} unavailableReason={!policy?.enabled || !policy?.reading ? "请先开启本设备的云同步和阅读云同步，再开启同步后删除。" : !reading?.supported ? "当前云连接不支持阅读同步，暂时无法开启同步后删除。" : undefined} />}
    <ReadingMediaSettings blocked={locked || !policy?.enabled || !policy.reading || !reading?.supported} active={active} />
    <CloudMaintenance blocked={locked || !policy?.enabled || !connection?.configured} onBusyChange={setMaintenanceBusy} />
    <section className="cloud-sync-card" aria-label="阅读同步状态">
      <div className="cloud-sync-status-heading"><h3>阅读同步状态</h3><button disabled={locked || !policy?.enabled || !policy.reading || !reading?.supported || !connection?.configured || reading.running} onClick={syncReading}>同步阅读</button></div>
      <p>{reading?.running ? "正在同步阅读内容…" : `上次完成一轮：${time(reading?.report?.completedAt)}`}{reading?.report?.pending ? ` · 待同步 ${reading.report.pending} 条` : ""}</p>
      {reading?.lastError && <p className="cloud-sync-last-error">上次未完成：{reading.lastError}</p>}
      {reading?.report?.media && <p>附件清单已上传 {reading.report.media.uploaded} 项 · 下载文件 {reading.report.media.downloaded} 个 · 待同步 {reading.report.media.pending} 项 · 未完成 {reading.report.media.failed} 项。具体原因可在文章的“附件云副本”查看。</p>}
      {reading?.report?.copies && <p>副本记录上传 {reading.report.copies.uploaded} 份 · 接收 {reading.report.copies.downloaded} 份 · 待同步 {reading.report.copies.pending} 份。其他设备的资料库副本仅供查看。</p>}
      <p>手机可阅读、修改状态与标签、归档或恢复。资料库保存和删除清理由桌面端处理。</p>
    </section>
    <section className="cloud-sync-card" aria-label="闪卡同步状态">
      <div className="cloud-sync-status-heading"><h3>闪卡同步状态</h3><button disabled={locked || !policy?.enabled || !policy.flashcards || !connection?.configured} onClick={sync}>立即同步</button></div>
      <p>{connection?.configured ? `上次成功：${time(connection.lastSyncAt)}` : "尚未配置云连接"}</p>
      {connection?.lastError && <p className="cloud-sync-last-error">上次未完成：{connection.lastError}</p>}
      <details><summary>最近同步记录</summary>{history.length === 0 ? <p>尚无记录</p> : history.map(item => <article key={item.id}>
        <strong>{item.status === "success" ? "同步成功" : "同步未完成"}</strong> · {time(item.completedAt)}
        <p>下载 {item.downloadedCards} 卡 · 合并 {item.mergedReviews} 条复习 · 附件 ↑{item.uploadedMedia}/↓{item.downloadedMedia}</p>
        {item.error && <p className="cloud-sync-last-error">{item.error}</p>}
      </article>)}</details>
    </section>
  </section>;
}
