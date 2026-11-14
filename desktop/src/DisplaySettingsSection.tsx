import type { AppSettings } from "./AppSettings";
import { CompletedStatusIcon } from "./CompletedStatusIcon";
import { MobileAppearanceSettings } from "./MobileAppearance";

type DisplaySettingsSectionProps = {
  mobile?: boolean;
  appSettings: AppSettings;
  saveSettings: (settings: AppSettings) => void | Promise<void>;
  changeRecentGroupingSetting: (enabled: boolean) => void | Promise<void>;
  desktopSidebarEnabled: boolean;
  changeDesktopSidebarSetting: (enabled: boolean) => void;
};

function ToggleButton({
  enabled,
  label,
  accessibleLabel,
  onClick,
}: {
  enabled: boolean;
  label: string;
  accessibleLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`ocr-toggle settings-toggle ${enabled ? "enabled" : ""}`}
      role="switch"
      aria-checked={enabled}
      aria-label={accessibleLabel}
      onClick={onClick}
    >
      <span>{label}</span><i aria-hidden="true" />
    </button>
  );
}

export function DisplaySettingsSection({
  mobile = false,
  appSettings,
  saveSettings,
  changeRecentGroupingSetting,
  desktopSidebarEnabled,
  changeDesktopSidebarSetting,
}: DisplaySettingsSectionProps) {
  return (
    <>
      {mobile && <MobileAppearanceSettings />}
      {!mobile && <div className="background-setting-row settings-category display desktop-only-setting">
        <span><strong>桌面左侧边栏</strong><small>在桌面端显示收藏、最近浏览、标签和资料库多选；关闭后保留当前顶部资料库菜单</small></span>
        <ToggleButton
          accessibleLabel="桌面左侧边栏"
          enabled={desktopSidebarEnabled}
          label={desktopSidebarEnabled ? "开启" : "关闭"}
          onClick={() => changeDesktopSidebarSetting(!desktopSidebarEnabled)}
        />
      </div>}
      <div className="background-setting-row settings-category display">
        <span><strong>任务状态样式</strong><small>完成图标颜色跟随当前主题</small></span>
        <div className="task-status-style-choice">
          <span className="task-status-style-preview" aria-hidden="true"><CompletedStatusIcon size={22} variant={appSettings.taskStatusStyle}/></span>
          <select aria-label="任务状态样式" value={appSettings.taskStatusStyle}
            onChange={event => void saveSettings({ ...appSettings, taskStatusStyle: event.target.value === "outline" ? "outline" : "filled" })}>
            <option value="filled">实心圆勾（默认）</option>
            <option value="outline">圆圈勾</option>
          </select>
        </div>
      </div>
      <div className="settings-section-label settings-category display">字号与列表</div>
      {!mobile && <div className="background-setting-row settings-category display">
        <span><strong>界面文字</strong><small>搜索框、资料库菜单、筛选栏和设置界面的文字大小</small></span>
        <select aria-label="界面文字" value={appSettings.interfaceFontSize} onChange={(event) => void saveSettings({ ...appSettings, interfaceFontSize: Number(event.target.value) })}>
          <option value={12}>紧凑 · 12 px</option>
          <option value={13}>标准 · 13 px</option>
          <option value={14}>较大 · 14 px</option>
          <option value={15}>大 · 15 px</option>
          <option value={16}>特大 · 16 px</option>
        </select>
      </div>}
      <div className="background-setting-row settings-category display">
        <span><strong>列表文字大小</strong><small>调整首页最近文档和搜索结果中的页面名称；路径、元数据与正文摘要按比例联动</small></span>
        <select aria-label="列表文字大小" value={mobile ? Math.max(14, appSettings.resultFontSize) : appSettings.resultFontSize} onChange={(event) => void saveSettings({ ...appSettings, resultFontSize: Number(event.target.value) })}>
          {mobile ? [14, 15, 16, 17, 18, 20, 22].map((size) => <option key={size} value={size}>{size} px</option>) : <>
          <option value={12}>12 px</option>
          <option value={13}>13 px</option>
          <option value={14}>14 px</option>
          <option value={15}>15 px</option>
          <option value={16}>16 px</option>
          <option value={17}>17 px</option>
          <option value={18}>18 px</option>
          <option value={20}>20 px</option>
          <option value={22}>22 px</option>
          </>}
        </select>
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>列表页面名称加粗</strong><small>控制首页最近文档和搜索结果中的页面名称字重</small></span>
        <ToggleButton
          accessibleLabel="列表页面名称加粗"
          enabled={appSettings.listTitleBold}
          label={appSettings.listTitleBold ? "加粗" : "常规"}
          onClick={() => void saveSettings({ ...appSettings, listTitleBold: !appSettings.listTitleBold })}
        />
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>预览正文</strong><small>调整预览正文及其中标题的整体阅读比例</small></span>
        <select aria-label="预览正文" value={mobile ? Math.max(16, appSettings.previewFontSize) : appSettings.previewFontSize} onChange={(event) => void saveSettings({ ...appSettings, previewFontSize: Number(event.target.value) })}>
          {mobile ? [16, 17, 18, 20, 22].map((size) => <option key={size} value={size}>{size} px</option>) : <>
          <option value={13}>13 px</option>
          <option value={14}>14 px</option>
          <option value={15}>15 px</option>
          <option value={16}>16 px</option>
          <option value={17}>17 px</option>
          <option value={18}>18 px</option>
          <option value={20}>20 px</option>
          <option value={22}>22 px</option>
          </>}
        </select>
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>预览页面标题</strong><small>仅调整预览顶部的页面名称，不影响正文标题</small></span>
        <select aria-label="预览页面标题" value={mobile ? Math.max(19, appSettings.previewTitleFontSize) : appSettings.previewTitleFontSize} onChange={(event) => void saveSettings({ ...appSettings, previewTitleFontSize: Number(event.target.value) })}>
          {mobile ? [19, 20, 22, 24, 26].map((size) => <option key={size} value={size}>{size} px</option>) : <>
          <option value={12}>12 px</option>
          <option value={13}>13 px</option>
          <option value={14}>14 px</option>
          <option value={15}>15 px</option>
          <option value={16}>16 px</option>
          <option value={18}>18 px</option>
          <option value={20}>20 px</option>
          <option value={22}>22 px</option>
          <option value={24}>24 px</option>
          <option value={26}>26 px</option>
          </>}
        </select>
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>预览页面名称加粗</strong><small>控制预览顶部页面名称的字重，不影响正文</small></span>
        <ToggleButton
          accessibleLabel="预览页面名称加粗"
          enabled={appSettings.previewTitleBold}
          label={appSettings.previewTitleBold ? "加粗" : "常规"}
          onClick={() => void saveSettings({ ...appSettings, previewTitleBold: !appSettings.previewTitleBold })}
        />
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>不限时间时按日期分组</strong><small>搜索框为空且修改时间为“不限”时，仍按今天、昨天、本周等日期类别整理首页文档</small></span>
        <ToggleButton
          accessibleLabel="不限时间时按日期分组"
          enabled={appSettings.groupRecentByDateWhenUnlimited}
          label={appSettings.groupRecentByDateWhenUnlimited ? "开启" : "关闭"}
          onClick={() => void changeRecentGroupingSetting(!appSettings.groupRecentByDateWhenUnlimited)}
        />
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>首页语义化修改日期</strong><small>{mobile ? "以今天、昨天、3 天前等相对时间显示文档日期" : "将首页的完整日期显示为“今天”“昨天”“3 天前”等相对时间；悬停仍可查看完整日期"}</small></span>
        <ToggleButton
          accessibleLabel="首页语义化修改日期"
          enabled={appSettings.semanticRecentDates}
          label={appSettings.semanticRecentDates ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, semanticRecentDates: !appSettings.semanticRecentDates })}
        />
      </div>
      <div className="background-setting-row settings-category display">
        <span><strong>首页最近内容配额</strong><small>页面与滴答任务分别取最近记录，避免任务挤掉页面；设为 0 可隐藏该类内容</small></span>
        <div className="recent-limit-controls">
          <label><span>页面</span><select aria-label="首页最近页面数量" value={appSettings.recentPageLimit} onChange={(event) => void saveSettings({ ...appSettings, recentPageLimit: Number(event.target.value) })}>
            {[0, 10, 20, 30, 50, 100, 200, 300, 500].map((count) => <option key={count} value={count}>{count === 0 ? "隐藏" : `${count} 条`}</option>)}
          </select></label>
          <label><span>任务</span><select aria-label="首页最近任务数量" value={appSettings.recentTaskLimit} onChange={(event) => void saveSettings({ ...appSettings, recentTaskLimit: Number(event.target.value) })}>
            {[0, 5, 10, 20, 30, 50, 100, 200, 300, 500].map((count) => <option key={count} value={count}>{count === 0 ? "隐藏" : `${count} 条`}</option>)}
          </select></label>
        </div>
      </div>
    </>
  );
}
