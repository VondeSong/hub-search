import type { CSSProperties } from "react";

export type CraftOpenMode = "bridge" | "web" | "client";
export type TaskStatusStyle = "filled" | "outline";

export type AppSettings = {
  autoSyncMinutes: number;
  interfaceFontSize: number;
  resultFontSize: number;
  previewFontSize: number;
  previewTitleFontSize: number;
  listTitleBold: boolean;
  previewTitleBold: boolean;
  taskStatusStyle: TaskStatusStyle;
  imageOcrEnabled: boolean;
  pdfEnabled: boolean;
  pdfOcrEnabled: boolean;
  groupRecentByDateWhenUnlimited: boolean;
  semanticRecentDates: boolean;
  recentPageLimit: number;
  recentTaskLimit: number;
  dynamicFacetCountsEnabled: boolean;
  searchSuggestionsEnabled: boolean;
  searchHistoryEnabled: boolean;
  rememberWindowPosition: boolean;
  resultsPanePercent: number;
  toggleShortcut: string;
  startOnBoot: boolean;
  startHidden: boolean;
  hideOnFocusLost: boolean;
  hideAfterOpen: boolean;
  craftResultOpenMode: CraftOpenMode;
  craftPreviewOpenMode: CraftOpenMode;
};

export const DEFAULT_APP_SETTINGS: Readonly<AppSettings> = {
  autoSyncMinutes: 15,
  interfaceFontSize: 13,
  resultFontSize: 14,
  previewFontSize: 14,
  previewTitleFontSize: 16,
  listTitleBold: true,
  previewTitleBold: true,
  taskStatusStyle: "filled",
  imageOcrEnabled: true,
  pdfEnabled: true,
  pdfOcrEnabled: true,
  groupRecentByDateWhenUnlimited: true,
  semanticRecentDates: false,
  recentPageLimit: 30,
  recentTaskLimit: 10,
  dynamicFacetCountsEnabled: true,
  searchSuggestionsEnabled: true,
  searchHistoryEnabled: true,
  rememberWindowPosition: true,
  resultsPanePercent: 60,
  toggleShortcut: "Ctrl+Shift+K",
  startOnBoot: false,
  startHidden: true,
  hideOnFocusLost: false,
  hideAfterOpen: false,
  craftResultOpenMode: "bridge",
  craftPreviewOpenMode: "bridge",
};

export function appShellStyle(settings: AppSettings): CSSProperties {
  return {
    "--interface-font-size": `${settings.interfaceFontSize}px`,
    "--result-font-size": `${settings.resultFontSize}px`,
    "--preview-font-size": `${settings.previewFontSize}px`,
    "--preview-title-font-size": `${settings.previewTitleFontSize}px`,
    "--list-title-weight": settings.listTitleBold ? "670" : "450",
    "--preview-title-weight": settings.previewTitleBold ? "700" : "450",
  } as CSSProperties;
}

function recordFrom(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const bounded = Math.min(maximum, Math.max(minimum, value));
  return integer ? Math.trunc(bounded) : bounded;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function openModeOr(value: unknown, fallback: CraftOpenMode): CraftOpenMode {
  if (value === "background_web") return "bridge";
  return value === "bridge" || value === "web" || value === "client" ? value : fallback;
}

export function normalizeAppSettings(value: unknown): AppSettings {
  const source = recordFrom(value);
  const defaults = DEFAULT_APP_SETTINGS;
  const shortcut = typeof source.toggleShortcut === "string" && source.toggleShortcut.trim()
    ? source.toggleShortcut.trim()
    : defaults.toggleShortcut;

  return {
    autoSyncMinutes: boundedNumber(source.autoSyncMinutes, defaults.autoSyncMinutes, 0, 24 * 60),
    interfaceFontSize: boundedNumber(source.interfaceFontSize, defaults.interfaceFontSize, 12, 16),
    resultFontSize: boundedNumber(source.resultFontSize, defaults.resultFontSize, 12, 22),
    previewFontSize: boundedNumber(source.previewFontSize, defaults.previewFontSize, 13, 22),
    previewTitleFontSize: boundedNumber(source.previewTitleFontSize, defaults.previewTitleFontSize, 12, 26),
    listTitleBold: booleanOr(source.listTitleBold, defaults.listTitleBold),
    previewTitleBold: booleanOr(source.previewTitleBold, defaults.previewTitleBold),
    taskStatusStyle: source.taskStatusStyle === "outline" ? "outline" : "filled",
    imageOcrEnabled: booleanOr(source.imageOcrEnabled, defaults.imageOcrEnabled),
    pdfEnabled: booleanOr(source.pdfEnabled, defaults.pdfEnabled),
    pdfOcrEnabled: booleanOr(source.pdfOcrEnabled, defaults.pdfOcrEnabled),
    groupRecentByDateWhenUnlimited: booleanOr(source.groupRecentByDateWhenUnlimited, defaults.groupRecentByDateWhenUnlimited),
    semanticRecentDates: booleanOr(source.semanticRecentDates, defaults.semanticRecentDates),
    recentPageLimit: boundedNumber(source.recentPageLimit, defaults.recentPageLimit, 0, 500),
    recentTaskLimit: boundedNumber(source.recentTaskLimit, defaults.recentTaskLimit, 0, 500),
    dynamicFacetCountsEnabled: booleanOr(source.dynamicFacetCountsEnabled, defaults.dynamicFacetCountsEnabled),
    searchSuggestionsEnabled: booleanOr(source.searchSuggestionsEnabled, defaults.searchSuggestionsEnabled),
    searchHistoryEnabled: booleanOr(source.searchHistoryEnabled, defaults.searchHistoryEnabled),
    rememberWindowPosition: booleanOr(source.rememberWindowPosition, defaults.rememberWindowPosition),
    resultsPanePercent: boundedNumber(source.resultsPanePercent, defaults.resultsPanePercent, 25, 75, false),
    toggleShortcut: shortcut,
    startOnBoot: booleanOr(source.startOnBoot, defaults.startOnBoot),
    startHidden: booleanOr(source.startHidden, defaults.startHidden),
    hideOnFocusLost: booleanOr(source.hideOnFocusLost, defaults.hideOnFocusLost),
    hideAfterOpen: booleanOr(source.hideAfterOpen, defaults.hideAfterOpen),
    craftResultOpenMode: openModeOr(source.craftResultOpenMode, defaults.craftResultOpenMode),
    craftPreviewOpenMode: openModeOr(source.craftPreviewOpenMode, defaults.craftPreviewOpenMode),
  };
}
