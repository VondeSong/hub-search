import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, LoaderCircle, RefreshCw } from "lucide-react";
import { CloudConnectionOptions } from "./CloudConnectionOptions";
import {
  CloudAttachmentPolicies,
  ModuleIcon,
  moduleNames,
  type Transfers,
  type Module,
  type Selection,
} from "./CloudAttachmentPolicies";
import { ReadingCacheSettings } from "./ReadingCacheSettings";
import type { LibrarySummary } from "./SearchTypes";
import { ReadingNetworkSettings } from "./ReadingNetworkSettings";
import { ReadingSourceCleanupSettings } from "./ReadingSourceRecovery";
import { runtimeCapabilities } from "./RuntimePlatform";
import { CloudMaintenance } from "./CloudMaintenance";
import { consumeCloudSyncSettingsSection } from "./CloudSyncEvents";
import { useVisiblePolling } from "./useVisiblePolling";
import "./ReadingAttachments.css";
import type {
  FlashcardSyncHistoryItem,
  FlashcardSyncSettings,
} from "./FlashcardTypes";
import "./CloudSyncSettingsSection.css";

export type CloudSyncPolicy = {
  enabled: boolean;
  autoSync: boolean;
  flashcards: boolean;
  reading: boolean;
};
type ReadingReport = {
  uploaded: number;
  downloaded: number;
  pending: number;
  completedAt: number;
  media?: {
    uploaded: number;
    downloaded: number;
    failed: number;
    pending: number;
  };
  copies?: { uploaded: number; downloaded: number; pending: number };
};
type ReadingSyncState = {
  supported: boolean;
  running: boolean;
  lastError: string;
  report: ReadingReport | null;
};
const time = (value?: number) =>
  value ? new Date(value * 1000).toLocaleString() : "尚未同步";

type QuickSettings = {
  libraryId: string;
  folder: string;
  dateFolders: boolean;
  sync: boolean;
};
type QuickState = {
  settings: QuickSettings;
  supported: boolean;
  error: string;
  report?: { pendingUpload: number; awaitingOs: number; written: number };
};
export function CloudSyncSettingsSection({
  active = true,
}: { active?: boolean } = {}) {
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [page, setPage] = useState<
    "overview" | "preferences" | "connection" | "advanced"
  >("overview");
  const [transfers, setTransfers] = useState<Transfers | null>(null),
    [quick, setQuick] = useState<QuickState | null>(null);
  const [libraries, setLibraries] = useState<LibrarySummary[]>([]),
    [quickDraft, setQuickDraft] = useState<QuickSettings | null>(null);
  const [policy, setPolicy] = useState<CloudSyncPolicy | null>(null);
  const [connection, setConnection] = useState<FlashcardSyncSettings | null>(
    null,
  );
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
  const [syncError, setSyncError] = useState("");
  const [notice, setNotice] = useState("");
  const running = useRef(false);
  const operation = useRef(0);
  const mounted = useRef(true);
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!policy) return;
    if (consumeCloudSyncSettingsSection() === "dida-cleanup") {
      setPage("preferences");
      setCleanupOpen(true);
      const target = sectionRef.current?.querySelector<HTMLElement>(
        "#dida-reading-cleanup-settings",
      );
      target?.scrollIntoView?.({ block: "center" });
      target?.focus({ preventScroll: true });
    }
  }, [policy]);
  const refresh = async () => {
    const [
      settings,
      status,
      recent,
      readingState,
      attachmentPolicies,
      quickState,
      cloudState,
    ] = await Promise.all([
      invoke<CloudSyncPolicy>("get_cloud_sync_policy"),
      invoke<FlashcardSyncSettings>("get_flashcard_sync_settings"),
      invoke<FlashcardSyncHistoryItem[]>("list_flashcard_sync_history", {
        limit: 20,
      }),
      invoke<ReadingSyncState>("get_reading_sync_status"),
      invoke<Transfers>("get_cloud_attachment_policies"),
      invoke<QuickState>("get_quick_journal_settings"),
      invoke<{ provider: "webdav" | "oss" }>(
        "get_flashcard_cloud_sync_settings",
      ),
    ]);
    if (!mounted.current) return;
    setPolicy(settings);
    setConnection(status);
    setHistory(recent);
    setReading(readingState);
    setTransfers(attachmentPolicies);
    setQuick(quickState);
    setQuickDraft(quickState?.settings ?? null);
    setProvider(cloudState.provider);
    return status;
  };
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .then((status) => {
        if (status) {
          setUrl(status.url);
          setUsername(status.username);
        }
        void invoke<LibrarySummary[]>("list_libraries")
          .then(setLibraries)
          .catch(() => {});
      })
      .catch((e) => {
        if (mounted.current) setError(String(e));
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  useVisiblePolling(
    async () => {
      if (running.current) return;
      const version = operation.current;
      const [nextConnection, nextReading, nextQuick] = await Promise.all([
        invoke<FlashcardSyncSettings>("get_flashcard_sync_settings"),
        invoke<ReadingSyncState>("get_reading_sync_status"),
        invoke<QuickState>("get_quick_journal_settings"),
      ]);
      if (!mounted.current || running.current || version !== operation.current)
        return;
      setConnection(nextConnection);
      setReading(nextReading);
      setQuick(nextQuick);
      if (
        !(policy?.flashcards && nextConnection.lastError) &&
        !(policy?.reading &&
          (nextReading.running ||
            nextReading.lastError ||
            nextReading.report?.media?.failed)) &&
        !(nextQuick.settings.sync && nextQuick.supported && nextQuick.error)
      ) {
        setSyncError("");
      }
    },
    active && Boolean(policy),
    5000,
    { initialDelayMs: 5000 },
  );
  const run = async (label: string, action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    operation.current += 1;
    setBusy(label);
    setError("");
    setSyncError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(String(e));
    } finally {
      running.current = false;
      if (mounted.current) setBusy("");
    }
  };
  const updatePolicy = (change: Partial<CloudSyncPolicy>) => {
    if (!policy) return;
    void run("正在保存；如有传输，等待本次结束…", async () => {
      const next = await invoke<CloudSyncPolicy>("update_cloud_sync_policy", {
        settings: { ...policy, ...change },
      });
      if (mounted.current) {
        setPolicy(next);
        setNotice("本设备的同步设置已保存");
      }
    });
  };
  const saveConnection = (clearPassword = false) =>
    void run("正在保存连接…", async () => {
      const next = await invoke<FlashcardSyncSettings>(
        "update_flashcard_sync_settings",
        {
          url,
          username,
          password: password || null,
          clearPassword,
          autoSync: null,
          otherDevicesReady: locationReady,
        },
      );
      if (mounted.current) {
        setConnection(next);
        setUrl(next.url);
        setUsername(next.username);
        setPassword("");
        setLocationReady(false);
        setNotice("WebDAV 配置已保存");
      }
    });
  const changed = async () => {
    // Consumers refresh their lists, while their active review/editor session stays intact.
    window.dispatchEvent(new Event("hub:cloud-data-changed"));
    await refresh();
  };
  const sync = () =>
    void run("正在同步…", async () => {
      const failures: string[] = [];
      for (const [enabled, name, command] of [
        [policy?.flashcards, "闪卡", "sync_flashcards"],
        [policy?.reading, "阅读", "sync_reading"],
        [quick?.settings.sync && quick.supported, "速记", "sync_quick_journal"],
      ] as const) {
        if (!enabled) continue;
        setBusy(`正在同步${name}…`);
        try {
          await invoke(command);
        } catch (e) {
          failures.push(`${name}：${String(e)}`);
        }
      }
      window.dispatchEvent(new Event("hub:reading-data-changed"));
      await changed();
      if (failures.length) setSyncError(failures.join("；"));
      else setNotice("本轮同步结束，结果见各模块状态。");
    });
  const updateQuick = (value: QuickSettings) =>
    void run("正在保存速记设置…", async () => {
      await invoke("save_quick_journal_settings", { value });
      await refresh();
      setNotice("速记设置已保存");
    });
  const updateAttachments = (
    id: Module,
    direction: "upload" | "download",
    selection: Selection,
  ) => {
    if (!transfers) return;
    void run("正在保存附件策略…", async () => {
      const next = await invoke<Transfers[Module]>(
        "update_cloud_attachment_policy",
        { module: id, settings: { ...transfers[id], [direction]: selection } },
      );
      setTransfers((p) => (p ? { ...p, [id]: next } : p));
      setNotice("附件策略已保存，下次传输生效");
    });
  };
  const locked =
    Boolean(busy) ||
    connectionBusy ||
    maintenanceBusy ||
    !policy ||
    !connection;
  const dirty =
    url !== connection?.url ||
    username !== connection?.username ||
    Boolean(password);
  const movingActiveWebdav =
    provider === "webdav" &&
    Boolean(connection?.url) &&
    (url !== connection?.url || username !== connection?.username);
  const needsAttention = Boolean(
    (policy?.flashcards && connection?.lastError) ||
      (policy?.reading &&
        (reading?.lastError || reading?.report?.media?.failed)) ||
      (quick?.settings.sync && quick.error),
  );
  const moduleStatus = (id: Module) => {
    const enabled = id === "quick" ? quick?.settings.sync : policy?.[id];
    if (!enabled) return "未开启";
    if (!policy?.enabled) return "已暂停";
    if (id === "quick") {
      if (!quick?.supported) return "当前连接不支持";
      if (quick.error) return quick.error;
      const report = quick.report;
      if (report?.pendingUpload) return `${report.pendingUpload} 条待上传`;
      if (report?.awaitingOs) return `${report.awaitingOs} 条等待电脑写入`;
      return `已写入 ${report?.written ?? 0} 条日记`;
    }
    if (id === "reading") {
      if (reading?.running) return "正在同步";
      if (reading?.lastError) return reading.lastError;
      if (reading?.report?.media?.failed)
        return `${reading.report.media.failed} 个附件未完成`;
      if (reading?.report?.pending) return `${reading.report.pending} 条待同步`;
      return reading?.report
        ? `最近一轮 ${time(reading.report.completedAt)}`
        : "尚未同步";
    }
    return connection?.lastError || `最近成功 ${time(connection?.lastSyncAt)}`;
  };
  const downloadCaption = (id: Module) => {
    const selection = transfers?.[id].download;
    if (!selection) return "";
    const names = (
      [
        ["image", "图片"],
        ["video", "视频"],
        ["pdf", "PDF"],
        ["other", "其他"],
      ] as const
    )
      .filter(([key]) => selection[key])
      .map(([, name]) => name);
    return names.length
      ? `${names.join("、")} · 单个 ≤ ${selection.maxMb} MB`
      : "附件仅手动下载";
  };
  return (
    <section
      ref={sectionRef}
      className="settings-category cloud cloud-sync-center"
      aria-label="云同步设置"
    >
      <header>
        <Cloud size={22} />
        <div>
          <h2>云同步</h2>
          <p>管理本设备的云连接与同步范围。</p>
        </div>
      </header>
      <div className="cloud-sync-notice" aria-live="polite">
        {busy && (
          <p role="status">
            <LoaderCircle size={15} className="spin" />
            {busy}
          </p>
        )}
        {(error || syncError) && <p role="alert">{error || syncError}</p>}
        {!busy && notice && <p role="status">{notice}</p>}
        {!policy && !busy && (
          <button
            onClick={() =>
              void run("正在读取设置…", async () => {
                const next = await refresh();
                if (next) {
                  setUrl(next.url);
                  setUsername(next.username);
                }
              })
            }
          >
            重新读取设置
          </button>
        )}
      </div>
      <nav className="cloud-page-nav" aria-label="云同步导航">
        {(
          [
            ["overview", "概览"],
            ["preferences", "同步设置"],
            ["connection", "云连接"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            aria-current={page === id ? "page" : undefined}
            disabled={Boolean(busy) || connectionBusy || maintenanceBusy}
            onClick={() => setPage(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {page === "overview" && (
        <>
          <section className="cloud-overview-status">
            <Cloud size={26} />
            <div>
              <h3>
                {busy ||
                  (!policy
                    ? "正在读取云同步设置…"
                    : !policy.enabled
                      ? "这台设备已暂停同步"
                      : !connection?.configured
                        ? "连接云空间，开始同步"
                        : needsAttention
                          ? "有项目需要处理"
                          : "云同步")}
              </h3>
              <p>
                {connection?.configured
                  ? provider === "oss"
                    ? "阿里云 OSS"
                    : "原有 WebDAV 连接"
                  : "尚未连接"}
              </p>
            </div>
            <button
              className="cloud-primary"
              disabled={
                locked ||
                !policy?.enabled ||
                !connection?.configured ||
                reading?.running ||
                !(
                  policy?.flashcards ||
                  policy?.reading ||
                  (quick?.settings.sync && quick.supported)
                )
              }
              onClick={sync}
            >
              <RefreshCw size={14} />
              立即同步
            </button>
          </section>
          <div className="cloud-module-results">
            {(["flashcards", "reading", "quick"] as Module[]).map((id) => {
              return (
                <div key={id}>
                  <ModuleIcon id={id} />
                  <strong>{moduleNames[id]}</strong>
                  <span>
                    {moduleStatus(id)}
                    <small className="cloud-result-detail">
                      {downloadCaption(id)}
                    </small>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="cloud-overview-footer">
            <span>{policy?.autoSync ? "自动同步" : "手动同步"} · 本设备</span>
            <button
              disabled={locked}
              onClick={() => updatePolicy({ enabled: !policy?.enabled })}
            >
              {policy?.enabled ? "暂停此设备" : "恢复此设备"}
            </button>
          </div>
          <details>
            <summary>最近同步记录</summary>
            {history.length ? (
              history.map((item) => (
                <p key={item.id}>
                  {time(item.completedAt)} ·{" "}
                  {item.status === "success"
                    ? "闪卡同步完成"
                    : item.error || "闪卡未完成"}
                </p>
              ))
            ) : (
              <p>尚无闪卡同步记录。</p>
            )}
            {reading?.report && (
              <p>
                阅读最近一轮：{time(reading.report.completedAt)} · 附件未完成{" "}
                {reading.report.media?.failed ?? 0} 项
              </p>
            )}
            {quick?.error && <p role="alert">速记：{quick.error}</p>}
          </details>
        </>
      )}
      {page === "preferences" && (
        <>
          <section className="cloud-general">
            <label className="cloud-sync-switch">
              <span>
                <strong>同步方式</strong>
                <small>管理这台设备的同步</small>
              </span>
              <select
                aria-label="同步方式"
                value={
                  !policy?.enabled
                    ? "paused"
                    : policy.autoSync
                      ? "auto"
                      : "manual"
                }
                disabled={locked}
                onChange={(e) =>
                  updatePolicy({
                    enabled: e.target.value !== "paused",
                    autoSync:
                      e.target.value === "paused"
                        ? policy?.autoSync
                        : e.target.value === "auto",
                  })
                }
              >
                <option value="auto">自动同步</option>
                <option value="manual">仅手动同步</option>
                <option value="paused">暂停此设备</option>
              </select>
            </label>
            <div className="cloud-scope">
              <span>同步内容</span>
              {(["flashcards", "reading", "quick"] as Module[]).map((id) => (
                <label key={id}>
                  {moduleNames[id]}
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`同步${moduleNames[id]}`}
                    checked={Boolean(
                      id === "quick" ? quick?.settings.sync : policy?.[id],
                    )}
                    disabled={
                      locked ||
                      (id === "quick" &&
                        !quick?.supported &&
                        !quick?.settings.sync)
                    }
                    onChange={(e) =>
                      id === "quick"
                        ? quick &&
                          updateQuick({
                            ...quick.settings,
                            sync: e.target.checked,
                          })
                        : updatePolicy({ [id]: e.target.checked })
                    }
                  />
                </label>
              ))}
            </div>
          </section>
          {transfers && (
            <CloudAttachmentPolicies
              value={transfers}
              modules={{
                flashcards: Boolean(policy?.flashcards),
                reading: Boolean(policy?.reading),
                quick: Boolean(quick?.settings.sync && quick.supported),
              }}
              disabled={locked}
              onChange={updateAttachments}
            />
          )}
          <details>
            <summary>更多设置与同步说明</summary>
            <p>
              其他附件包含音频及已支持的其他格式。速记通过 OSS
              上传，由电脑写入日记。附件未下载不影响正文写入，可从速记记录手动下载并补全。
            </p>
            <ReadingNetworkSettings active={active} />
          </details>
          <details>
            <summary>管理本机附件缓存与固定离线</summary>
            <ReadingCacheSettings />
          </details>
          <details>
            <summary>速记保存位置与电脑写入</summary>
            {quickDraft && (
              <>
                <p>速记仅支持 OSS，一处云空间由一台电脑写入日记。</p>
                {!runtimeCapabilities.mobile && (
                  <>
                    <label>
                      目标 Obsidian 资料库
                      <select
                        aria-label="速记 OS 资料库"
                        disabled={locked}
                        value={quickDraft.libraryId}
                        onChange={(e) =>
                          setQuickDraft({
                            ...quickDraft,
                            libraryId: e.target.value,
                          })
                        }
                      >
                        <option value="">请选择</option>
                        {libraries
                          .filter((l) => l.provider === "obsidian")
                          .map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label>
                      日记目录
                      <input
                        aria-label="速记日记目录"
                        disabled={locked}
                        value={quickDraft.folder}
                        onChange={(e) =>
                          setQuickDraft({
                            ...quickDraft,
                            folder: e.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        disabled={locked}
                        checked={quickDraft.dateFolders}
                        onChange={(e) =>
                          setQuickDraft({
                            ...quickDraft,
                            dateFolders: e.target.checked,
                          })
                        }
                      />
                      按日期分年/月目录
                    </label>
                  </>
                )}
                <button
                  disabled={locked}
                  onClick={() => updateQuick(quickDraft)}
                >
                  保存速记位置
                </button>
              </>
            )}
          </details>
          {runtimeCapabilities.desktop && (
            <details
              open={cleanupOpen}
              onToggle={(e) => setCleanupOpen(e.currentTarget.open)}
            >
              <summary>来源采集与清理</summary>
              <ReadingSourceCleanupSettings
                blocked={locked || !policy?.enabled || !policy?.reading}
              />
            </details>
          )}
          <button
            className="cloud-related-link"
            onClick={() => setPage("connection")}
          >
            云连接 · {provider === "oss" ? "阿里云 OSS" : "WebDAV"}
          </button>
          <button
            className="cloud-related-link"
            onClick={() => setPage("advanced")}
          >
            同步诊断与修复
          </button>
        </>
      )}
      <div hidden={page !== "connection"}>
        <section
          className="cloud-sync-card cloud-sync-settings"
          aria-label="云连接"
        >
          <CloudConnectionOptions
            showDownloadPolicy={false}
            syncing={Boolean(busy) || maintenanceBusy || !policy || !connection}
            onBusyChange={setConnectionBusy}
            onProviderChange={setProvider}
            transfersAllowed={Boolean(policy?.enabled)}
            webdavReady={Boolean(connection?.url)}
            webdavDirty={dirty}
            onChanged={changed}
            webdavSettings={
              <>
                <label>
                  <span>WebDAV 目录地址</span>
                  <input
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setLocationReady(false);
                    }}
                    placeholder="https://dav.example.com/HubFlashcards/"
                    spellCheck={false}
                  />
                </label>
                <label>
                  <span>用户名</span>
                  <input
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      setLocationReady(false);
                    }}
                    autoComplete="username"
                  />
                </label>
                <label>
                  <span>密码</span>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      connection?.hasPassword
                        ? "已安全保存；留空保持"
                        : "WebDAV 密码"
                    }
                    autoComplete="new-password"
                  />
                </label>
                {movingActiveWebdav && (
                  <>
                    <p>
                      更改正在使用的目录或账号会迁移全部模块，读回核验完成后才保存。未结束时再次保存可继续，原位置数据保留。
                    </p>
                    <label className="cloud-auto-sync">
                      <input
                        type="checkbox"
                        checked={locationReady}
                        onChange={(e) => setLocationReady(e.target.checked)}
                      />
                      <span>其它设备已同步并暂停编辑和自动同步</span>
                    </label>
                  </>
                )}
                <div className="cloud-sync-actions">
                  {connection?.hasPassword && (
                    <button onClick={() => saveConnection(true)}>
                      清除 WebDAV 密码
                    </button>
                  )}
                  <button
                    disabled={!connection?.url || dirty}
                    onClick={() =>
                      void run("正在测试连接…", async () => {
                        const message = await invoke<string>(
                          "test_flashcard_sync_connection",
                        );
                        if (mounted.current) setNotice(message);
                      })
                    }
                  >
                    测试 WebDAV 连接
                  </button>
                  <button
                    disabled={
                      !url.trim() ||
                      (movingActiveWebdav &&
                        (!locationReady || !policy?.enabled))
                    }
                    onClick={() => saveConnection()}
                  >
                    {movingActiveWebdav
                      ? "迁移并保存 WebDAV 配置"
                      : "保存 WebDAV 配置"}
                  </button>
                </div>
                <p>
                  原有目录继续使用，无需改名。配置保存在本设备；连接测试会访问所选服务。保存配置不会切换云服务。
                </p>
              </>
            }
          />
        </section>
      </div>
      {page === "advanced" && (
        <>
          <button onClick={() => setPage("preferences")}>返回同步设置</button>
          <CloudMaintenance
            blocked={locked || !policy?.enabled || !connection?.configured}
            onBusyChange={setMaintenanceBusy}
          />
        </>
      )}
    </section>
  );
}
