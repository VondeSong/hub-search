import { describe, expect, it } from "vitest";
import { appShellStyle, DEFAULT_APP_SETTINGS, normalizeAppSettings } from "./AppSettings";

describe("normalizeAppSettings", () => {
  it("fills fields missing from older settings payloads", () => {
    expect(normalizeAppSettings({ searchHistoryEnabled: false })).toEqual({
      ...DEFAULT_APP_SETTINGS,
      searchHistoryEnabled: false,
    });
  });

  it("rejects invalid values and preserves explicit false values", () => {
    const settings = normalizeAppSettings({
      autoSyncMinutes: Number.NaN,
      interfaceFontSize: "16",
      imageOcrEnabled: false,
      toggleShortcut: "   ",
      craftResultOpenMode: "external",
    });

    expect(settings.autoSyncMinutes).toBe(DEFAULT_APP_SETTINGS.autoSyncMinutes);
    expect(settings.interfaceFontSize).toBe(DEFAULT_APP_SETTINGS.interfaceFontSize);
    expect(settings.imageOcrEnabled).toBe(false);
    expect(settings.toggleShortcut).toBe(DEFAULT_APP_SETTINGS.toggleShortcut);
    expect(settings.craftResultOpenMode).toBe(DEFAULT_APP_SETTINGS.craftResultOpenMode);
  });

  it("applies the same numeric bounds as the Rust settings backend", () => {
    const settings = normalizeAppSettings({
      autoSyncMinutes: 9_999,
      interfaceFontSize: 9,
      resultFontSize: 20.9,
      previewFontSize: 99,
      previewTitleFontSize: -3,
      resultsPanePercent: 91,
      recentPageLimit: 750,
      recentTaskLimit: -8,
    });

    expect(settings.autoSyncMinutes).toBe(1_440);
    expect(settings.interfaceFontSize).toBe(12);
    expect(settings.resultFontSize).toBe(20);
    expect(settings.previewFontSize).toBe(22);
    expect(settings.previewTitleFontSize).toBe(12);
    expect(settings.resultsPanePercent).toBe(75);
    expect(settings.recentPageLimit).toBe(500);
    expect(settings.recentTaskLimit).toBe(0);
  });

  it("accepts all supported Craft opening modes", () => {
    expect(normalizeAppSettings({ craftResultOpenMode: "bridge" }).craftResultOpenMode).toBe("bridge");
    expect(normalizeAppSettings({ craftPreviewOpenMode: "client" }).craftPreviewOpenMode).toBe("client");
  });

  it("defaults old task appearance preferences to filled and preserves the outline variant", () => {
    expect(normalizeAppSettings({}).taskStatusStyle).toBe("filled");
    expect(normalizeAppSettings({ taskStatusStyle: "unknown" }).taskStatusStyle).toBe("filled");
    expect(normalizeAppSettings({ taskStatusStyle: "outline" }).taskStatusStyle).toBe("outline");
  });

  it("migrates the removed hidden-WebView mode to CraftBridge", () => {
    expect(normalizeAppSettings({ craftResultOpenMode: "background_web" }).craftResultOpenMode).toBe("bridge");
  });

  it("maps user display settings to the main window style variables", () => {
    const settings = normalizeAppSettings({
      interfaceFontSize: 16,
      resultFontSize: 13,
      listTitleBold: false,
      previewTitleBold: false,
    });

    expect(appShellStyle(settings)).toMatchObject({
      "--interface-font-size": "16px",
      "--result-font-size": "13px",
      "--list-title-weight": "450",
      "--preview-title-weight": "450",
    });
  });
});
