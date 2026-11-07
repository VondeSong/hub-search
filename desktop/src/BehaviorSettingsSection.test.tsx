// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS } from "./AppSettings";
import { BehaviorSettingsSection } from "./BehaviorSettingsSection";
import { shortcutFromKeyboardEvent } from "./KeyboardShortcut";
import type { RuntimeCapabilities } from "./RuntimePlatform";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const desktopCapabilities: RuntimeCapabilities = {
  platform: "windows",
  mobile: false,
  desktop: true,
  globalShortcut: true,
  autostart: true,
  windowState: true,
  tray: true,
  nativeOcr: true,
  customStorageLocation: true,
  localVault: true,
  craftBackgroundOpen: true,
};

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  invoke.mockReset();
});

describe("BehaviorSettingsSection CraftBridge status", () => {
  it("records F9 for showing Hub and displays conflicts beside its shortcut setting", async () => {
    invoke.mockResolvedValue({ available: false, message: "未连接" });
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const changeToggleShortcut = vi.fn();
    const props = {
      runtimeCapabilities: desktopCapabilities,
      appSettings: { ...DEFAULT_APP_SETTINGS },
      updatingShortcut: false,
      saveSettings: vi.fn(), changeToggleShortcut,
      clearSearchHistory: vi.fn(), changeCraftOpenMode: vi.fn(), shortcutFromKeyboardEvent,
    };
    await act(async () => root.render(<BehaviorSettingsSection {...props} />));
    const inputs = container.querySelectorAll<HTMLInputElement>(".shortcut-recorder");
    expect(inputs).toHaveLength(1);
    expect(container.textContent).not.toContain("快速搜索快捷键");
    await act(async () => inputs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "F9", code: "F9", bubbles: true, cancelable: true })));
    expect(changeToggleShortcut).toHaveBeenCalledExactlyOnceWith("F9");
    const message = "快捷键 F9 已被其他程序占用；原快捷键仍然有效";
    await act(async () => root.render(<BehaviorSettingsSection {...props} shortcutMessage={message} />));
    expect(container.querySelector(".maintenance-message.behavior")?.textContent).toBe(message);
    expect(inputs[0].value).toBe(DEFAULT_APP_SETTINGS.toggleShortcut);
    await act(async () => root.unmount());
  });

  it("shows the detected version and supports an accessible manual refresh", async () => {
    invoke.mockResolvedValue({
      available: true,
      version: "0.12.0",
      message: "CraftBridge 0.12.0 已连接",
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    await act(async () => root.render(<BehaviorSettingsSection
      runtimeCapabilities={desktopCapabilities}
      appSettings={{ ...DEFAULT_APP_SETTINGS }}
      updatingShortcut={false}
      saveSettings={vi.fn()}
      changeToggleShortcut={vi.fn()}
      clearSearchHistory={vi.fn()}
      changeCraftOpenMode={vi.fn()}
      shortcutFromKeyboardEvent={() => null}
    />));

    const status = container.querySelector<HTMLElement>("[role='status']")!;
    expect(status.textContent).toContain("CraftBridge 0.12.0 已连接");
    expect(status.classList.contains("available")).toBe(true);
    const refresh = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "重新检测")!;
    await act(async () => refresh.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith("get_craft_bridge_status");

    await act(async () => root.unmount());
  });
});
