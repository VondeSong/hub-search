import { ChevronLeft, Cloud, SlidersHorizontal } from "lucide-react";
import { JournalCaptureButton } from "./JournalVoice";
import { useState, type ReactNode } from "react";
import { MobileSpaceMenu, type MobileSpaceActions } from "./MobileSpaceMenu";

export type MobileLinkStatus = { oss: boolean; vps: boolean; pendingUpload?: number; vpsLabel?: string };

export function mobileConnectionSummary(connection?: MobileLinkStatus) {
  const ossState: "ok" | "warn" | "idle" = connection?.pendingUpload
    ? "warn"
    : connection?.oss
      ? "ok"
      : "idle";
  const vpsState: "ok" | "warn" | "idle" = connection?.vps
    ? "ok"
    : connection?.vpsLabel === "离线缓存" || connection?.vpsLabel === "连接异常" || connection?.vpsLabel === "访问受限"
      ? "warn"
      : "idle";
  const label = connection?.pendingUpload
    ? `待上传 ${connection.pendingUpload}`
    : connection?.vpsLabel === "离线缓存" || connection?.vpsLabel === "连接异常" || connection?.vpsLabel === "访问受限"
      ? "助手离线"
      : "连接";
  return { ossState, vpsState, label };
}

export function MobileHeaderControls({
  connection,
  onSettings,
  spaceActions,
}: {
  connection?: MobileLinkStatus;
  onSettings: () => void;
  spaceActions?: MobileSpaceActions;
}) {
  const [spaceOpen, setSpaceOpen] = useState(false);
  const { ossState, vpsState, label } = mobileConnectionSummary(connection);
  return <>
    {spaceActions && <button type="button" className="bw-connection" aria-label={`连接状态：${label}`} onClick={spaceActions.onConnections}>
      <i data-ready={connection?.oss} data-state={ossState} />
      <i data-ready={connection?.vps} data-state={vpsState} />
      <span>{label}</span>
    </button>}
    <button
      type="button"
      className="bw-space-trigger"
      aria-label={spaceActions ? "空间与设置" : "设置"}
      aria-haspopup={spaceActions ? "dialog" : undefined}
      aria-expanded={spaceActions ? spaceOpen : undefined}
      onClick={spaceActions ? () => setSpaceOpen(true) : onSettings}
    >
      <SlidersHorizontal size={17} />
    </button>
    {spaceOpen && spaceActions && <MobileSpaceMenu {...spaceActions} onSettings={onSettings} onClose={() => setSpaceOpen(false)} />}
  </>;
}

export function MobileHeader({ title, connection, onBack, onSettings, onAgents, children, spaceActions }: { title?: string; connection?: MobileLinkStatus; onBack?: () => void; onSettings: () => void; onAgents?: () => void; children?: ReactNode; spaceActions?: MobileSpaceActions }) {
  return <header className={`mobile-hub-header${onBack ? " is-secondary" : ""}`}>
    {onBack && <button type="button" aria-label="返回浏览" onClick={onBack}><ChevronLeft size={22} /></button>}
    <h1 className="mobile-hub-page-title">{title || "Hub"}</h1>
    <div className="mobile-hub-actions">
      {!onBack && <MobileHeaderControls connection={connection} onSettings={onSettings} spaceActions={spaceActions} />}
      {onAgents && <button type="button" aria-label="助手" onClick={onAgents}><Cloud size={21} /></button>}
      {children}
      {!onBack && title !== "复习" && title !== "云端助手" && <span className="bw-fab"><JournalCaptureButton label="快速记录" size={14} /></span>}
    </div>
  </header>;
}
