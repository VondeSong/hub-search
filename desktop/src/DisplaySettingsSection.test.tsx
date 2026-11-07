// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "./AppSettings";
import { DisplaySettingsSection } from "./DisplaySettingsSection";

it("shows effective Android font sizes and saves the larger reading preference", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const saveSettings = vi.fn();
  try {
    await act(async () => root.render(<DisplaySettingsSection mobile appSettings={DEFAULT_APP_SETTINGS}
      saveSettings={saveSettings} changeRecentGroupingSetting={vi.fn()} desktopSidebarEnabled
      changeDesktopSidebarSetting={vi.fn()} />));
    const selects = [...container.querySelectorAll("select")];
    expect(selects.map((select) => select.value)).toEqual(["filled", "14", "16", "19", "30", "10"]);
    expect([...selects[1].options].map(option => option.value)).toContain("15");
    expect(selects.map((select) => select.getAttribute("aria-label"))).toEqual(["任务状态样式", "列表文字大小", "预览正文", "预览页面标题", "首页最近页面数量", "首页最近任务数量"]);
    expect([...container.querySelectorAll('[role="switch"]')].every((toggle) => toggle.getAttribute("aria-label"))).toBe(true);
    expect(container.textContent).not.toContain("桌面左侧边栏");
    await act(async () => {
      selects[1].value = "22";
      selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveSettings).toHaveBeenCalledWith({ ...DEFAULT_APP_SETTINGS, resultFontSize: 22 });
    await act(async () => {
      selects[4].value = "500";
      selects[4].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveSettings).toHaveBeenCalledWith({ ...DEFAULT_APP_SETTINGS, recentPageLimit: 500 });
    await act(async () => {
      selects[0].value = "outline";
      selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(saveSettings).toHaveBeenCalledWith({ ...DEFAULT_APP_SETTINGS, taskStatusStyle: "outline" });
  } finally {
    await act(async () => root.unmount());
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  }
});
