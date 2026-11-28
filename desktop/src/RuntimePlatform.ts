export type RuntimePlatform = "android" | "windows" | "other";

export type RuntimeCapabilities = {
  platform: RuntimePlatform;
  mobile: boolean;
  desktop: boolean;
  globalShortcut: boolean;
  autostart: boolean;
  windowState: boolean;
  tray: boolean;
  nativeOcr: boolean;
  customStorageLocation: boolean;
  localVault: boolean;
  craftBackgroundOpen: boolean;
};

function detectRuntimePlatform(): RuntimePlatform {
  const userAgent = globalThis.navigator?.userAgent ?? "";
  if (/Android/i.test(userAgent)) return "android";
  if (/Windows/i.test(userAgent)) return "windows";
  return "other";
}

const platform = detectRuntimePlatform();
const mobile = platform === "android";
const windows = platform === "windows";

export const runtimeCapabilities: RuntimeCapabilities = {
  platform,
  mobile,
  desktop: !mobile,
  globalShortcut: windows,
  autostart: windows,
  windowState: windows,
  tray: windows,
  nativeOcr: windows,
  customStorageLocation: windows,
  localVault: windows,
  craftBackgroundOpen: windows,
};

// CSS uses this stable platform marker instead of inferring the runtime from
// viewport width. A narrow Windows window must remain a desktop window.
if (typeof document !== "undefined") document.documentElement.dataset.runtimePlatform = platform;
