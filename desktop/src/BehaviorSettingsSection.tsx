import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { AppSettings, CraftOpenMode } from "./AppSettings";
import type { RuntimeCapabilities } from "./RuntimePlatform";
import { GlobalExclusionReviewSettings } from "./GlobalExclusionReviewReminder";

type BehaviorSettingsSectionProps = {
  runtimeCapabilities: RuntimeCapabilities;
  appSettings: AppSettings;
  updatingShortcut: boolean;
  shortcutMessage?: string;
  saveSettings: (settings: AppSettings) => void | Promise<void>;
  changeToggleShortcut: (shortcut: string) => void | Promise<void>;
  clearSearchHistory: () => void;
  changeCraftOpenMode: (source: "result" | "preview", mode: CraftOpenMode) => void | Promise<void>;
  shortcutFromKeyboardEvent: (event: ReactKeyboardEvent<HTMLInputElement>) => string | null;
};

type CraftBridgeStatus = {
  available: boolean;
  version?: string;
  message: string;
};

function ToggleButton({
  enabled,
  label,
  onClick,
}: {
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`ocr-toggle settings-toggle ${enabled ? "enabled" : ""}`}
      role="switch"
      aria-checked={enabled}
      onClick={onClick}
    >
      <span>{label}</span><i aria-hidden="true" />
    </button>
  );
}

export function BehaviorSettingsSection({
  runtimeCapabilities,
  appSettings,
  updatingShortcut,
  shortcutMessage,
  saveSettings,
  changeToggleShortcut,
  clearSearchHistory,
  changeCraftOpenMode,
  shortcutFromKeyboardEvent,
}: BehaviorSettingsSectionProps) {
  const [craftBridgeStatus, setCraftBridgeStatus] = useState<CraftBridgeStatus | null>(null);
  const [checkingCraftBridge, setCheckingCraftBridge] = useState(false);
  const checkCraftBridge = useCallback(async () => {
    setCheckingCraftBridge(true);
    try {
      setCraftBridgeStatus(await invoke<CraftBridgeStatus>("get_craft_bridge_status"));
    } catch (reason) {
      setCraftBridgeStatus({ available: false, message: `无法检测 CraftBridge：${String(reason)}` });
    } finally {
      setCheckingCraftBridge(false);
    }
  }, []);

  useEffect(() => {
    if (runtimeCapabilities.desktop) void checkCraftBridge();
  }, [checkCraftBridge, runtimeCapabilities.desktop]);

  return (
    <>
      {runtimeCapabilities.desktop && <>
      <GlobalExclusionReviewSettings />
      <div className="background-setting-row settings-category behavior">
        <span><strong>显示/隐藏 Hub 快捷键</strong><small>控制完整 Hub 主窗口；支持组合键或 F1–F24 单键</small></span>
        <span className="shortcut-setting-control">
          <input
            className="shortcut-recorder"
            value={updatingShortcut ? "注册中…" : appSettings.toggleShortcut}
            readOnly
            disabled={updatingShortcut}
            aria-label="显示或隐藏 Hub 快捷键"
            onKeyDown={(event) => {
              if (event.key === "Tab") return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                event.currentTarget.blur();
                return;
              }
              const shortcut = shortcutFromKeyboardEvent(event);
              if (shortcut) void changeToggleShortcut(shortcut);
            }}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button disabled={updatingShortcut || appSettings.toggleShortcut.toLowerCase() === "ctrl+shift+k"} onClick={() => void changeToggleShortcut("Ctrl+Shift+K")}>默认</button>
        </span>
      </div>
      {shortcutMessage && <div className="maintenance-message settings-category behavior" role="status" aria-live="polite">{shortcutMessage}</div>}
      <div className="background-setting-row settings-category behavior">
        <span><strong>开机自启动</strong><small>登录 Windows 后自动启动 Hub；使用当前免安装程序所在路径</small></span>
        <ToggleButton
          enabled={appSettings.startOnBoot}
          label={appSettings.startOnBoot ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, startOnBoot: !appSettings.startOnBoot })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>开机启动后隐藏</strong><small>由开机启动项运行时不显示主窗口，程序留在系统托盘，可用全局快捷键唤醒</small></span>
        <ToggleButton
          enabled={appSettings.startHidden}
          label={appSettings.startHidden ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, startHidden: !appSettings.startHidden })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>记住窗口状态</strong><small>重启后恢复窗口大小、屏幕位置，以及左侧结果与右侧预览的宽度比例</small></span>
        <ToggleButton
          enabled={appSettings.rememberWindowPosition}
          label={appSettings.rememberWindowPosition ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, rememberWindowPosition: !appSettings.rememberWindowPosition })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>失去焦点时隐藏</strong><small>切换到其他应用后，将搜索窗口自动隐藏到系统托盘</small></span>
        <ToggleButton
          enabled={appSettings.hideOnFocusLost}
          label={appSettings.hideOnFocusLost ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, hideOnFocusLost: !appSettings.hideOnFocusLost })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>打开结果后隐藏</strong><small>双击搜索结果或点击预览中的打开按钮，成功发起打开后自动隐藏 Hub</small></span>
        <ToggleButton
          enabled={appSettings.hideAfterOpen}
          label={appSettings.hideAfterOpen ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, hideAfterOpen: !appSettings.hideAfterOpen })}
        />
      </div>
      </>}
      <div className="background-setting-row settings-category behavior">
        <span><strong>动态分面统计</strong><small>在类型、资料库、文件夹和标签旁显示当前查询的命中数量；大型结果集最多统计前 2000 项</small></span>
        <ToggleButton
          enabled={appSettings.dynamicFacetCountsEnabled}
          label={appSettings.dynamicFacetCountsEnabled ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, dynamicFacetCountsEnabled: !appSettings.dynamicFacetCountsEnabled })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>搜索建议与语法提示</strong><small>聚焦搜索框时显示筛选范围、最近搜索、匹配的标题/标签/文件夹，以及短语、拼音和模糊匹配提示</small></span>
        <ToggleButton
          enabled={appSettings.searchSuggestionsEnabled}
          label={appSettings.searchSuggestionsEnabled ? "开启" : "关闭"}
          onClick={() => void saveSettings({ ...appSettings, searchSuggestionsEnabled: !appSettings.searchSuggestionsEnabled })}
        />
      </div>
      <div className="background-setting-row settings-category behavior">
        <span><strong>记录最近搜索</strong><small>在本机保存最近 12 条搜索词，聚焦空搜索框时显示；关闭后会清除已有记录</small></span>
        <ToggleButton
          enabled={appSettings.searchHistoryEnabled}
          label={appSettings.searchHistoryEnabled ? "开启" : "关闭"}
          onClick={() => {
            const enabled = !appSettings.searchHistoryEnabled;
            if (!enabled) clearSearchHistory();
            void saveSettings({ ...appSettings, searchHistoryEnabled: enabled });
          }}
        />
      </div>
      {runtimeCapabilities.desktop && <>
      <div className="background-setting-row settings-category behavior">
        <span>
          <strong>Craft 搜索结果打开方式</strong>
          <small>{appSettings.craftResultOpenMode === "bridge"
            ? "通过本机 CraftBridge 把完整 HTTPS 链接直接交给 Craft，可复用标签并精准定位页面或正文块"
            : appSettings.craftResultOpenMode === "web"
              ? "双击结果或按 Enter 时使用可见网页精准块链接"
              : "使用旧版 craftdocs 链接唤醒客户端；通常只能打开页面，可能不会定位正文块"}</small>
        </span>
        <select
          value={appSettings.craftResultOpenMode}
          onChange={(event) => changeCraftOpenMode("result", event.target.value as CraftOpenMode)}
        >
          <option value="bridge">CraftBridge 直接唤醒（推荐）</option>
          <option value="web">网页精准定位</option>
          <option value="client">旧版客户端链接</option>
        </select>
      </div>
      <div className="background-setting-row settings-category behavior">
        <span>
          <strong>Craft 预览按钮打开方式</strong>
          <small>{appSettings.craftPreviewOpenMode === "bridge"
            ? "通过本机 CraftBridge 直接唤醒 Craft，并保留页面路径、查询参数和正文块锚点"
            : appSettings.craftPreviewOpenMode === "web"
              ? "预览右上角打开按钮使用可见网页精准块链接"
              : "预览右上角打开按钮使用旧版 craftdocs 链接唤醒客户端"}</small>
        </span>
        <select
          value={appSettings.craftPreviewOpenMode}
          onChange={(event) => changeCraftOpenMode("preview", event.target.value as CraftOpenMode)}
        >
          <option value="bridge">CraftBridge 直接唤醒（推荐）</option>
          <option value="web">网页精准定位</option>
          <option value="client">旧版客户端链接</option>
        </select>
      </div>
      <div
        className={`craft-bridge-status ${checkingCraftBridge ? "checking" : craftBridgeStatus?.available ? "available" : "unavailable"}`}
        role="status"
        aria-live="polite"
      >
        <span><i aria-hidden="true" />{checkingCraftBridge ? "正在检测 CraftBridge…" : craftBridgeStatus?.message ?? "尚未检测 CraftBridge"}</span>
        <button type="button" onClick={() => void checkCraftBridge()} disabled={checkingCraftBridge}>
          {checkingCraftBridge ? "检测中" : "重新检测"}
        </button>
      </div>
      </>}
      <div className="background-setting-row settings-category behavior">
        <span><strong>滴答清单任务打开</strong><small>{runtimeCapabilities.mobile ? "在任务详情中点击打开按钮，可前往对应的滴答任务。" : "双击任务、按 Enter 或点击预览按钮时，通过精确的 HTTPS 任务链接打开。"}</small></span>
      </div>
    </>
  );
}
