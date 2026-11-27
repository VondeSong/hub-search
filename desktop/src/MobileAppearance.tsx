import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { getUserProfileStorageStatus, subscribeUserProfileStorage, userProfileStorage } from "./UserProfileStorage";

const key = "hub.mobile.appearance.v1";
const themes = { system: "跟随系统", white: "纯白", black: "纯黑", paper: "暖纸" };
const accents = { blue: "湖蓝", sage: "鼠尾草", iris: "鸢尾紫" };
export function normalizeMobileAppearance(raw: string | null) {
  let value: { theme?: string; accent?: string } = {};
  try { value = JSON.parse(raw || "{}") || {}; } catch { /* Keep existing data until the user makes a choice. */ }
  return { theme: Object.prototype.hasOwnProperty.call(themes, value.theme || "") ? value.theme! : "system", accent: Object.prototype.hasOwnProperty.call(accents, value.accent || "") ? value.accent! : "blue" };
}
function snapshot() { try { return userProfileStorage.getItem(key); } catch { return null; } }
function useAppearance() {
  const raw = useSyncExternalStore(subscribeUserProfileStorage, snapshot);
  return normalizeMobileAppearance(raw);
}
const readingKey = "hub.mobile.reading-size.v1";
function readingSize() {
  try { return userProfileStorage.getItem(readingKey) === "large"; } catch { return false; }
}
export function useMobileAppearance() {
  const large = useSyncExternalStore(subscribeUserProfileStorage, readingSize);
  useLayoutEffect(() => {
    document.documentElement.dataset.mobileReadingSize = large ? "large" : "normal";
    return () => { delete document.documentElement.dataset.mobileReadingSize; };
  }, [large]);
  const value = useAppearance();
  useLayoutEffect(() => {
    document.documentElement.dataset.mobileTheme = value.theme;
    document.documentElement.dataset.mobileAccent = value.accent;
    return () => { delete document.documentElement.dataset.mobileTheme; delete document.documentElement.dataset.mobileAccent; };
  }, [value.theme, value.accent]);
}
export function useMobileMenuAppearance() {
  const appearance = useAppearance();
  const large = useSyncExternalStore(subscribeUserProfileStorage, readingSize);
  const status = useSyncExternalStore(subscribeUserProfileStorage, getUserProfileStorageStatus);
  const [error, setError] = useState("");
  function save(keyName: string, value: string) {
    try { userProfileStorage.setItem(keyName, value); setError(""); }
    catch (e) { setError(String(e)); }
  }
  return { ...appearance, large, ready: status.ready, error: error || status.error,
    toggleSize: () => save(readingKey, large ? "normal" : "large"),
    selectTheme: (theme: string) => save(key, JSON.stringify({ ...appearance, theme })),
    selectAccent: (accent: string) => save(key, JSON.stringify({ ...appearance, accent })),
  };
}
export function MobileAppearanceSettings() {
  const value = useAppearance(), status = useSyncExternalStore(subscribeUserProfileStorage, getUserProfileStorageStatus);
  const [error, setError] = useState("");
  function save(change: Partial<typeof value>) {
    try { userProfileStorage.setItem(key, JSON.stringify({ ...value, ...change })); setError(""); } catch (e) { setError(String(e)); }
  }
  return <div className="mobile-appearance-settings">
    <div className="settings-section-label settings-category display">外观</div>
    <div className="background-setting-row settings-category display"><span><strong>主题</strong><small>应用到页面、速记和阅读</small></span><select aria-label="手机主题" disabled={!status.ready} value={value.theme} onChange={e => save({ theme: e.target.value })}>{Object.entries(themes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
    <div className="background-setting-row settings-category display"><span><strong>强调色</strong></span><select aria-label="手机强调色" disabled={!status.ready} value={value.accent} onChange={e => save({ accent: e.target.value })}>{Object.entries(accents).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div>
    {(error || status.error) && <p role="alert">{error || status.error}</p>}
  </div>;
}

export function MobileReaderFontButton() {
  const appearance = useMobileMenuAppearance();
  return <button type="button" className="bw-reader-font" aria-label="切换阅读字号" aria-pressed={appearance.large} disabled={!appearance.ready} onClick={appearance.toggleSize}>Aa</button>;
}
