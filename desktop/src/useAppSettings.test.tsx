// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "./AppSettings";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { useAppSettings } from "./useAppSettings";

let settingsApi: ReturnType<typeof useAppSettings> | undefined;

function Probe({ onError }: { onError: (message: string) => void }) {
  settingsApi = useAppSettings(onError);
  return <span>{settingsApi.appSettings.interfaceFontSize}</span>;
}

describe("useAppSettings", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onError = vi.fn();

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockReset();
    onError.mockReset();
    settingsApi = undefined;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("normalizes settings returned by older backends", async () => {
    invokeMock.mockResolvedValue({ interfaceFontSize: 99, searchHistoryEnabled: false });
    await act(async () => root.render(<Probe onError={onError} />));

    let loaded: AppSettings | undefined;
    await act(async () => { loaded = await settingsApi?.loadAppSettings(); });

    expect(invokeMock).toHaveBeenCalledWith("get_settings");
    expect(loaded?.interfaceFontSize).toBe(16);
    expect(loaded?.searchHistoryEnabled).toBe(false);
    expect(container.textContent).toBe("16");
  });

  it("reports save failures without replacing the current settings", async () => {
    invokeMock.mockRejectedValue(new Error("保存失败"));
    await act(async () => root.render(<Probe onError={onError} />));
    const before = settingsApi?.appSettings;

    await act(async () => { await settingsApi?.saveSettings({ ...before!, interfaceFontSize: 15 }); });

    expect(onError).toHaveBeenCalledWith("Error: 保存失败");
    expect(settingsApi?.appSettings).toEqual(before);
  });

  it("owns shortcut persistence and preserves the saved shortcut when a later change fails", async () => {
    invokeMock.mockResolvedValue("Ctrl+Shift+Space");
    await act(async () => root.render(<Probe onError={onError} />));
    await act(async () => settingsApi!.changeToggleShortcut("Ctrl+Shift+Space"));
    expect(invokeMock).toHaveBeenCalledWith("update_toggle_shortcut", { shortcut: "Ctrl+Shift+Space" });
    expect(settingsApi!.appSettings.toggleShortcut).toBe("Ctrl+Shift+Space");
    expect(settingsApi!.shortcutMessage).toContain("Ctrl+Shift+Space"); expect(settingsApi!.updatingShortcut).toBe(false);
    invokeMock.mockRejectedValue(new Error("conflict"));
    await act(async () => settingsApi!.changeToggleShortcut("Ctrl+Space"));
    expect(settingsApi!.appSettings.toggleShortcut).toBe("Ctrl+Shift+Space"); expect(settingsApi!.shortcutMessage).toBe("Error: conflict"); expect(settingsApi!.updatingShortcut).toBe(false);
  });

  it("applies auto sync grouping and source opening preferences through the same settings owner", async () => {
    invokeMock.mockImplementation(async (_command, settings) => settings);
    await act(async () => root.render(<Probe onError={onError} />));
    await act(async () => settingsApi!.changeAutoSync(30));
    await act(async () => settingsApi!.changeRecentGroupingSetting(true));
    await act(async () => settingsApi!.changeCraftOpenMode("preview", "web"));
    expect(settingsApi!.appSettings).toMatchObject({ autoSyncMinutes: 30, groupRecentByDateWhenUnlimited: true, craftPreviewOpenMode: "web" });
    expect(invokeMock.mock.calls.every(call => call[0] === "update_settings")).toBe(true);
  });
});
