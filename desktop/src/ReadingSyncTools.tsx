import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { useCallback, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { CloudSyncPolicy, ReadingReport, ReadingSyncState } from "./CloudSyncSettingsSection";
import type { CollectionSource, CollectionSyncSource } from "./CollectionSyncPanel";
import type { ReadingNetworkState } from "./ReadingNetworkSettings";
import { openCloudSyncSettings } from "./CloudSyncEvents";
import { useDidaReadingLogin } from "./useDidaReadingLogin";
import { useVisiblePolling } from "./useVisiblePolling";
import "./ReadingTools.css";

function ReadingDialog({ title, description, kind, onClose, children }: {
  title: string; description: string; kind: "source" | "cloud"; onClose: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => {
    const panel = dialog.current;
    const opener = document.activeElement;
    panel?.showModal();
    return () => {
      panel?.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return <dialog ref={dialog} className={"reading-reference-dialog " + kind} aria-labelledby={titleId} aria-describedby={descriptionId}
    onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="reading-reference-dialog-frame">
      <header>
        <div><h2 id={titleId}>{title}</h2><p id={descriptionId}>{description}</p></div>
        <button type="button" autoFocus aria-label={"关闭" + title} onClick={onClose}><X size={15}/></button>
      </header>
      {children}
    </div>
  </dialog>;
}

const rows = [
  { id: "bookmarks", name: "X 书签", description: "采集正文、引用与附件；支持放弃回写" },
  { id: "likes", name: "X 喜欢", description: "独立连接与同步入口" },
  { id: "telegram", name: "Telegram + tdl 个人号", description: "接收 Telegram 内容，tdl 个人号可补全大附件" },
  { id: "dida", name: "滴答稍后读", description: "精确采集「稍后读」标签；附件会话独立检查" },
] as const;
const shortTime = (seconds: number) => new Date(seconds * 1000).toLocaleString("zh-CN", {
  month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
});
const timeLabel = (seconds?: number) => seconds ? "上次 " + shortTime(seconds) : "尚未同步";
function SourceRow({ name, state, tone, description, action, disabled, onAction, children }: {
  name: string; state: string; tone?: "ok" | "warning"; description: string;
  action: string; disabled?: boolean; onAction: () => void; children?: ReactNode;
}) {
  return <article className="reading-reference-source-row" aria-label={name}>
    <div className="reading-reference-source-info">
      <div><strong>{name}</strong><span className={tone}>{state}</span></div>
      <p>{description}</p>
    </div>
    <button className="reading-reference-outline" type="button" disabled={disabled}
      aria-label={action + name} onClick={onAction}>{action}</button>
    {children}
  </article>;
}

const openDidaLogin = () => invoke<void>("open_dida_attachment_login");
export function ReadingSourceConnections({ sources, loading, tdlReady, didaVerifiedAt, onDidaVerified, local, sourceBusy, sourceActive, onSync, onCheckLocal,
  onConnect, onStorage, onDetails, onClose, onNotice }: {
  sources: CollectionSyncSource[];
  loading: boolean;
  tdlReady: boolean;
  didaVerifiedAt: number;
  onDidaVerified: (checkedAt: number) => void;
  local: { path: string; running?: boolean; lastCheckedAt?: number; error?: string };
  sourceBusy: (source: CollectionSource) => boolean;
  sourceActive: (source: CollectionSource) => boolean;
  onSync: (source: CollectionSource, restart: boolean) => Promise<string | undefined>;
  onCheckLocal: () => Promise<string | undefined>;
  onConnect: (source: CollectionSource) => void;
  onStorage: () => void;
  onDetails: () => void;
  onClose: () => void;
  onNotice: (message: string) => void;
}) {
  const [pending, setPending] = useState<CollectionSource | "obsidian" | null>(null);
  const [failure, setFailure] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const active = useRef(false);
  useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const dida = sources.find(source => source.id === "dida");
  const login = useDidaReadingLogin(reconnecting && !!dida?.didaCleanup?.authRequired, dida?.lastCheckedAt,
    dida?.status || "", dida?.didaCleanup?.lastRun?.authenticationRequired === true, openDidaLogin);
  const verifiedAt = reconnecting && login.currentVerified && login.feedback.status?.accountMatched && !login.latestSyncFailure
    ? login.feedback.status.checkedAt : 0;
  useLayoutEffect(() => {
    if (!verifiedAt) return;
    onDidaVerified(verifiedAt);
    onNotice("滴答附件会话已核验，可以继续同步。");
    onClose();
  }, [verifiedAt, onDidaVerified, onClose, onNotice]);
  const run = async (source: CollectionSource | "obsidian", operation: () => Promise<string | undefined>) => {
    if (pending) return;
    setFailure("");
    setPending(source);
    const error = await operation().catch(String);
    if (!active.current) return;
    setPending(null);
    if (error) setFailure(error);
    else onClose();
  };
  return <ReadingDialog title="来源同步与连接" description="独立于跨设备云同步" kind="source" onClose={onClose}>
    <div className="reading-reference-dialog-body">
      {rows.map(({ id, name, description }) => {
        const source = sources.find(candidate => candidate.id === id);
        const running = pending === id || sourceActive(id);
        const waiting = !running && sourceBusy(id);
        const busy = running || waiting;
        const recentDidaVerification = didaVerifiedAt > 0 && didaVerifiedAt >= (source?.lastCheckedAt ?? 0);
        const didaLogin = id === "dida" && source?.connected && source.didaCleanup?.authRequired && !recentDidaVerification;
        const verifyOnSync = id === "dida" && login.currentVerified && login.feedback.status?.accountMatched === false;
        const connected = !!source?.connected;
        const blocked = id !== "dida" && !!source?.autoBlocked;
        const tdlMissing = id === "telegram" && connected && !tdlReady;
        const state = loading ? "正在读取" : running ? "同步中" : waiting ? "后台任务占用" : didaLogin ? "附件网页会话待核验" :
          blocked ? "连接待检查" : tdlMissing ? "Telegram 已连接 · tdl 未就绪" : connected ? "已连接" : "未连接";
        const action = running ? "同步中…" : waiting ? "请稍候" : verifyOnSync ? "同步并核验" : didaLogin ? "重连会话" :
          blocked ? "重新连接" : !connected ? "连接" : "立即同步";
        return <SourceRow key={id} name={name} state={state} tone={didaLogin || blocked ? "warning" : connected && !busy ? "ok" : undefined}
          description={description + " · " + timeLabel(source?.lastSuccess)} action={action} disabled={loading || busy || (id === "dida" && login.busy)}
          onAction={() => {
            if (verifyOnSync) void run(id, () => onSync(id, false));
            else if (didaLogin) { setFailure(""); setReconnecting(true); void login.openLogin(); }
            else if (blocked || !connected) onConnect(id);
            else void run(id, () => onSync(id, !source?.canResume));
          }}>
          {id === "dida" && reconnecting && <div className="reading-reference-inline-feedback" role="status">
            <span>{login.feedback.message}</span>
            <button type="button" className="reading-reference-outline" disabled={login.busy} onClick={login.check}>我已登录，立即检查</button>
          </div>}
        </SourceRow>;
      })}
      <SourceRow name="Obsidian 本地素材" state={loading ? "正在读取" : local.running ? "检查中" : local.error ? "待检查" : local.path ? "已连接" : "未配置"}
        tone={local.error ? "warning" : local.path && !local.running ? "ok" : undefined} description={(local.path || "可读取 Obsidian 保存库中的本地素材") + " · " + timeLabel(local.lastCheckedAt)}
        action={local.running ? "检查中…" : local.path ? "立即同步" : "选择目录"} disabled={loading || local.running || pending === "obsidian"}
        onAction={() => { if (local.path) void run("obsidian", onCheckLocal); else onStorage(); }}/>
      {failure && <p className="reading-reference-error" role="alert">{failure}</p>}
    </div>
    <footer><button className="reading-reference-link" type="button" onClick={onDetails}>同步详情</button></footer>
  </ReadingDialog>;
}

function remaining(report?: ReadingReport | null) {
  return (report?.pending ?? 0) + (report?.media?.pending ?? 0) + (report?.media?.failed ?? 0) + (report?.copies?.pending ?? 0);
}
export function ReadingCloudOverview({ onClose, onNotice }: { onClose: () => void; onNotice: (message: string) => void }) {
  const [policy, setPolicy] = useState<CloudSyncPolicy | null>(null);
  const [status, setStatus] = useState<ReadingSyncState | null>(null);
  const [network, setNetwork] = useState<ReadingNetworkState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [syncError, setSyncError] = useState("");
  const active = useRef(false);
  const syncing = useRef(false);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [nextPolicy, nextStatus, nextNetwork] = await Promise.all([
        invoke<CloudSyncPolicy>("get_cloud_sync_policy"),
        invoke<ReadingSyncState>("get_reading_sync_status"),
        invoke<ReadingNetworkState>("get_reading_network_policy"),
      ]);
      if (!active.current) return;
      if (!nextPolicy || !nextStatus || !nextNetwork?.network) throw new Error("暂未收到有效的云同步状态");
      setPolicy(nextPolicy);
      setStatus(nextStatus);
      setNetwork(nextNetwork);
      setLoadError("");
    } catch (error) {
      if (active.current) setLoadError(String(error));
    }
  }, []);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useVisiblePolling(load, true, 5000);
  const settings = () => { onClose(); openCloudSyncSettings(); };
  const enabled = !!policy?.enabled && policy.reading === true;
  const allowed = status?.supported && enabled && network?.allowed;
  const sync = async () => {
    if (!allowed || syncing.current || status.running || loadError) return;
    syncing.current = true;
    setBusy(true);
    setSyncError("");
    try {
      const report = await invoke<ReadingReport>("sync_reading");
      window.dispatchEvent(new Event("hub:reading-data-changed"));
      window.dispatchEvent(new Event("hub:cloud-data-changed"));
      if (!active.current) return;
      if (remaining(report)) {
        setSyncError("本轮同步结束，仍有内容待传输。");
        await load();
      } else {
        onNotice("阅读云同步已完成。");
        onClose();
      }
    } catch (error) {
      if (active.current) setSyncError(String(error));
    } finally {
      syncing.current = false;
      if (active.current) setBusy(false);
    }
  };
  const networkLabel = network && ({ wifi: "仅非计费 Wi-Fi", unmetered: "仅非计费网络", any: "不限制网络" }[network.mode]);
  const running = busy || status?.running;
  return <ReadingDialog title="云同步" description="已取消每轮/每日流量额度门禁，按网络与文件规则传输" kind="cloud" onClose={onClose}>
    <div className="reading-reference-dialog-body">
      <div className="reading-reference-cloud-card">
        <div><strong>阅读云同步 · {policy ? enabled ? status?.supported ? "已开启" : "未连接" : "未开启" : "正在读取"}</strong>
          <p>{status?.report?.completedAt ? "上次同步 " + shortTime(status.report.completedAt) : "尚未同步"}{networkLabel && " · " + networkLabel}</p></div>
        <button type="button" className="reading-reference-primary" disabled={!!running || (!loadError && !policy) || (enabled && status?.supported && !network?.allowed && !loadError)}
          onClick={() => { if (loadError) void load(); else if (!enabled || !status?.supported) settings(); else void sync(); }}>
          {running ? "同步中…" : loadError ? "重新读取" : policy && (!enabled || !status?.supported) ? "打开设置" : "立即同步"}
        </button>
      </div>
      {network && !network.allowed && <p className="reading-reference-error" role="status">{network.reason || "当前网络不符合阅读传输策略"}</p>}
      {(loadError || syncError || status?.lastError) && <p className="reading-reference-error" role="alert">{loadError || syncError || status?.lastError}</p>}
      {!syncError && remaining(status?.report) > 0 && <p className="reading-reference-error" role="status">上轮同步仍有内容待传输</p>}
      <p className="reading-reference-protection"><strong>滴答来源清理保护：</strong>云同步启用时默认关闭自动清理，需完整云恢复 + 原设备凭证 + 删除前复核全部通过。</p>
    </div>
    <footer><button type="button" className="reading-reference-link" onClick={settings}>云同步设置</button></footer>
  </ReadingDialog>;
}
