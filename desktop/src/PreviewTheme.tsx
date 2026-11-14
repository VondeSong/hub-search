import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { getUserProfileStorageStatus, subscribeUserProfileStorage, userProfileStorage } from "./UserProfileStorage";
import "./PreviewTheme.css";

export type PreviewTheme = "current" | "craft";
export const PREVIEW_THEME_KEY = "hub.preview.theme.v1";
function snapshot(): PreviewTheme {
  try { return userProfileStorage.getItem(PREVIEW_THEME_KEY) === "craft" ? "craft" : "current"; }
  catch { return "current"; }
}

export function usePreviewTheme(content: RefObject<HTMLDivElement | null>) {
  const theme = useSyncExternalStore(subscribeUserProfileStorage, snapshot, () => "current" as const);
  const status = useSyncExternalStore(subscribeUserProfileStorage, getUserProfileStorageStatus);
  const [error, setError] = useState("");
  const position = useRef<{ element: Element; offset: number } | null>(null);
  const change = (next: PreviewTheme) => {
    if (next === theme) return;
    const root = content.current;
    if (root && root.scrollTop > 0) {
      const top = root.getBoundingClientRect().top;
      const element = Array.from(root.querySelectorAll(".preview-document > *")).find(node => node.getBoundingClientRect().bottom > top + 1);
      if (element) position.current = { element, offset: element.getBoundingClientRect().top - top };
    }
    try { userProfileStorage.setItem(PREVIEW_THEME_KEY, next); setError(""); }
    catch (reason) { position.current = null; setError(String(reason)); }
  };
  useLayoutEffect(() => {
    const saved = position.current, root = content.current;
    position.current = null;
    if (saved && root?.contains(saved.element)) root.scrollTop += saved.element.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset;
  }, [theme, content]);
  return { theme, change, ready: status.ready, error: error || status.error };
}

export function PreviewThemePicker({ theme, change, ready, error, sourceLayout }: ReturnType<typeof usePreviewTheme> & { sourceLayout?: boolean }) {
  return <div className="preview-theme-bar">
    <div className="preview-theme-choice" role="group" aria-label="预览样式">
      <span>预览样式</span><div>{(["current", "craft"] as const).map(value => <button type="button" key={value}
        aria-pressed={theme === value} disabled={!ready} onClick={() => change(value)}>{value === "craft" ? "Craft 风格" : "当前"}</button>)}</div>
    </div>
    {sourceLayout && theme === "craft" && <span className="preview-theme-note">复杂布局以原文为准</span>}
    {error && <span className="preview-theme-error" role="alert">样式偏好尚未保存：{error}</span>}
  </div>;
}
