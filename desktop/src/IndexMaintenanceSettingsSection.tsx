import { RotateCcw } from "lucide-react";
import type { RuntimeCapabilities } from "./RuntimePlatform";
import { LibraryContentPolicyEditor } from "./LibraryContentPolicyEditor";

type IndexStatus = {
  pendingLexicalJobs?: number;
  rateLimitEvents?: number;
  rateLimitedUntil?: number;
  syncPhase?: string;
  failedOcrPages?: number;
};

type IndexMaintenanceSettingsSectionProps = {
  runtimeCapabilities: RuntimeCapabilities;
  indexStatus: IndexStatus | null;
  cleaning: boolean;
  retryingOcr: boolean;
  syncPhaseLabel: (phase?: string) => string;
  reloadAppSettings: () => void | Promise<unknown>;
  cleanupLocalData: () => void | Promise<void>;
  retryFailedOcr: () => void | Promise<void>;
};

export function IndexMaintenanceSettingsSection({
  runtimeCapabilities,
  indexStatus,
  cleaning,
  retryingOcr,
  syncPhaseLabel,
  reloadAppSettings,
  cleanupLocalData,
  retryFailedOcr,
}: IndexMaintenanceSettingsSectionProps) {
  return (
    <>
      <div className="settings-category index"><LibraryContentPolicyEditor onSaved={reloadAppSettings} /></div>
      <div className="background-setting-row settings-category index">
        <span><strong>后台诊断</strong><small>{syncPhaseLabel(indexStatus?.syncPhase)} · 待提交索引 {indexStatus?.pendingLexicalJobs ?? 0}{indexStatus?.rateLimitEvents ? ` · Craft 限流 ${indexStatus.rateLimitEvents} 次` : ""}{indexStatus?.rateLimitedUntil ? ` · 冷却至 ${new Date(indexStatus.rateLimitedUntil * 1000).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}</small></span>
      </div>
      <div className="background-setting-row settings-category index">
        <span><strong>孤立缓存与旧索引</strong><small>保留两个可回退索引；仅清理已满 7 天且无引用的附件缓存。</small></span>
        <button className="maintenance-button" disabled={cleaning} onClick={() => {
          if (window.confirm("清理孤立缓存与旧索引？\n\n将移除后台判定无引用且已满 7 天的附件缓存、过期索引与临时文件。正文和仍被引用的附件保留。此操作不能撤销。")) void cleanupLocalData();
        }}>{cleaning ? "清理中…" : "清理孤立缓存…"}</button>
      </div>
      {runtimeCapabilities.nativeOcr && <div className="background-setting-row settings-category index">
        <span><strong>失败 OCR</strong><small>{indexStatus?.failedOcrPages ? `${indexStatus.failedOcrPages} 个页面已停止自动重试` : "当前没有失败的 OCR 页面"}</small></span>
        <button className="maintenance-button retry-button" disabled={retryingOcr || !indexStatus?.failedOcrPages} onClick={() => void retryFailedOcr()}><RotateCcw size={14} />{retryingOcr ? "重试中…" : "重新排队"}</button>
      </div>}
    </>
  );
}
