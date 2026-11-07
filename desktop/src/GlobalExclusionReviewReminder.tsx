import { Bell, ChevronRight } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import { useExclusionReviewReminder } from "./TagAssignmentExclusionReminder";

const ReminderContext = createContext<ReturnType<typeof useExclusionReviewReminder> | null>(null);

export function GlobalExclusionReviewProvider({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const reminder = useExclusionReviewReminder({ global: true, days: 90, revision: 0, active });
  return <ReminderContext.Provider value={reminder}>{children}</ReminderContext.Provider>;
}

export function GlobalExclusionReviewNotice({ onOpen }: { onOpen: () => void }) {
  const reminder = useContext(ReminderContext);
  if (!reminder?.enabled) return null;
  const { due, error, retry } = reminder;
  if (error) return <button type="button" className="sidebar-review-notice" onClick={retry} title="复核提醒检查失败，点击重试">
    <Bell size={15} aria-hidden="true" /><span>复核提醒暂不可用</span><small>重试</small>
  </button>;
  if (!due || due.count === 0) return null;
  return <button type="button" className="sidebar-review-notice" onClick={onOpen} title="前往标签治理，查看排除清单中的待复核内容">
    <Bell size={15} aria-hidden="true" /><span>排除待复核</span>
    <small>{due.count}{due.hasMore ? "+" : ""}</small><ChevronRight size={13} aria-hidden="true" />
  </button>;
}

export function GlobalExclusionReviewSettings() {
  const reminder = useContext(ReminderContext);
  if (!reminder) return null;
  const { enabled, changeEnabled, storageError, error, retry } = reminder;
  return <section className="settings-category behavior review-reminder-settings" aria-label="复核提醒">
    <div className="background-setting-row">
      <span><strong>跨页面复核提醒</strong><small>有排除内容待复核时，在侧栏显示提醒入口。</small></span>
      <button type="button" className={`ocr-toggle settings-toggle ${enabled ? "enabled" : ""}`} role="switch"
        aria-label="跨页面复核提醒" aria-checked={enabled} onClick={() => changeEnabled(!enabled)}>
        <span>{enabled ? "开启" : "关闭"}</span><i aria-hidden="true" />
      </button>
    </div>
    <details>
      <summary>提醒范围与运行说明</summary>
      <dl>
        <div><dt>提醒范围</dt><dd>全部标签中，未复核且启用至少 90 天，或已到下次复核日期的排除记录。其他时长可在标签治理的排除清单中筛选。</dd></div>
        <div><dt>检查时机</dt><dd>应用窗口显示时每 5 分钟检查一次，切换页面或收起侧栏不影响检查。返回窗口时最多每分钟补查一次。</dd></div>
        <div><dt>生效设备</dt><dd>开关仅保存在此设备，不随资料库同步。隐藏或退出应用后暂停提醒。</dd></div>
      </dl>
      <p>提醒仅在应用内显示，不读取正文、不运行模型，也不会自动取消排除。</p>
    </details>
    {enabled && error && <p role="alert">复核提醒暂不可用。<button type="button" onClick={retry}>重试</button></p>}
    {storageError && <p role="alert">{storageError}</p>}
  </section>;
}
