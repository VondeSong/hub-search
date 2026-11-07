import { useCallback, useEffect, useRef, useState, type RefObject, type MouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AppSettings } from "./AppSettings";
import { runtimeCapabilities } from "./RuntimePlatform";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";
import { userProfileStorage } from "./UserProfileStorage";

const PREVIEW_SPLIT_KEY = "craft-search-preview-split-v1";
const PREVIEW_SPLIT_COMPACT_KEY = "hub-preview-split-compact-v1";
const DEFAULT_RESULTS_PANE_PERCENT = 60;
const normalizedPercent = (value: number) => Number.isFinite(value) ? Math.min(75, Math.max(25, value)) : DEFAULT_RESULTS_PANE_PERCENT;

type Options = {
  appSettings: AppSettings;
  loadAppSettings: () => Promise<AppSettings>;
  searchInput: RefObject<HTMLInputElement | null>;
};

export function useWindowLifecycleControls({ appSettings, loadAppSettings, searchInput }: Options) {
  const [resultsPanePercent, updateResultsPanePercent] = useState(() => {
    const stored = Number(userProfileStorage.getItem(PREVIEW_SPLIT_KEY));
    return Number.isFinite(stored) && stored >= 25 && stored <= 75 ? stored : DEFAULT_RESULTS_PANE_PERCENT;
  });
  const percentRef = useRef(resultsPanePercent);
  const saving = useRef(false);
  const pendingPercent = useRef<number | null>(null);
  const active = useRef(true);
  const userChangedSplit = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const setResultsPanePercent = useCallback((value: number) => {
    userChangedSplit.current = true;
    const percent = normalizedPercent(value);
    percentRef.current = percent;
    updateResultsPanePercent(percent);
  }, []);

  const persistWindowState = useCallback(async (panePercent = percentRef.current) => {
    if (!runtimeCapabilities.windowState || !active.current) return;
    pendingPercent.current = normalizedPercent(panePercent);
    if (saving.current) return;
    saving.current = true;
    try {
      // One physical persistence producer. Move/resize and splitter completions
      // coalesce behind it instead of queuing overlapping database writes.
      while (pendingPercent.current !== null && active.current) {
        const percent = pendingPercent.current;
        pendingPercent.current = null;
        const appWindow = getCurrentWindow();
        const [visible, minimized] = await Promise.all([appWindow.isVisible(), appWindow.isMinimized()]);
        if (!active.current || !visible || minimized) continue;
        const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        if (!active.current) break;
        await invoke("save_window_state", { x: position.x, y: position.y, width: size.width, height: size.height, resultsPanePercent: percent });
      }
    } catch { /* Best-effort geometry persistence cannot interrupt reading. */ }
    finally { saving.current = false; pendingPercent.current = null; }
  }, []);

  const savePreviewSplit = useCallback((value: number) => {
    setResultsPanePercent(value);
    userProfileStorage.setItem(PREVIEW_SPLIT_KEY, String(percentRef.current));
    void persistWindowState(percentRef.current);
  }, [persistWindowState, setResultsPanePercent]);
  const resetPreviewSplit = useCallback(() => savePreviewSplit(DEFAULT_RESULTS_PANE_PERCENT), [savePreviewSplit]);
  const hideWindow = useCallback(() => invoke<void>("hide_window"), []);
  const startWindowDrag = useCallback((event: MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // React portals bubble through their owner, outside the draggable header DOM.
    if (!event.currentTarget.contains(target)) return;
    if (target.closest("button, input, select, textarea, a, [role='button'], [role='option'], [role='menu'], [contenteditable='true'], .pane-resizer")) return;
    event.preventDefault();
    void getCurrentWindow().startDragging().catch(() => undefined);
  }, []);

  useEffect(() => {
    let disposed = false;
    void loadAppSettings().then(settings => {
      if (disposed || userChangedSplit.current) return;
      const oldDefault = settings.resultsPanePercent === 56;
      const migrateDefault = oldDefault && userProfileStorage.getItem(PREVIEW_SPLIT_COMPACT_KEY) !== "1";
      const restoreMigrated = oldDefault && Number(userProfileStorage.getItem(PREVIEW_SPLIT_KEY)) === DEFAULT_RESULTS_PANE_PERCENT;
      const percent = normalizedPercent(migrateDefault || restoreMigrated ? DEFAULT_RESULTS_PANE_PERCENT : settings.resultsPanePercent);
      percentRef.current = percent; updateResultsPanePercent(percent);
      userProfileStorage.setItem(PREVIEW_SPLIT_COMPACT_KEY, "1");
      userProfileStorage.setItem(PREVIEW_SPLIT_KEY, String(percent));
      if (migrateDefault) void persistWindowState(percent);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [loadAppSettings, persistWindowState]);

  useEffect(() => {
    if (!runtimeCapabilities.windowState || !appSettings.rememberWindowPosition) return;
    const appWindow = getCurrentWindow(); let disposed = false; let saveTimer = 0;
    const saveState = () => {
      window.clearTimeout(saveTimer);
      if (!isWindowVisible()) return;
      saveTimer = window.setTimeout(() => { if (!disposed) void persistWindowState(); }, 350);
    };
    saveState();
    const moved = appWindow.onMoved(saveState), resized = appWindow.onResized(saveState);
    const unsubscribe = subscribeWindowVisibility(saveState);
    return () => {
      disposed = true; window.clearTimeout(saveTimer); unsubscribe();
      void moved.then(dispose => dispose()).catch(() => undefined);
      void resized.then(dispose => dispose()).catch(() => undefined);
    };
  }, [appSettings.rememberWindowPosition, persistWindowState]);

  useEffect(() => {
    if (!runtimeCapabilities.tray || !appSettings.hideOnFocusLost) return;
    let disposed = false;
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (!disposed && !focused && !document.querySelector(".agent-panel:not([hidden])")) void invoke("hide_window").catch(() => undefined);
    });
    return () => { disposed = true; void unlisten.then(dispose => dispose()).catch(() => undefined); };
  }, [appSettings.hideOnFocusLost]);

  useEffect(() => {
    if (runtimeCapabilities.mobile) return;
    let disposed = false; let focusTimer: number | undefined;
    const unlisten = listen("hub-window-shown", () => {
      window.clearTimeout(focusTimer);
      focusTimer = window.setTimeout(() => {
        if (!disposed && isWindowVisible() && !document.querySelector('[role="dialog"]')) searchInput.current?.focus();
      }, 60);
    });
    return () => { disposed = true; window.clearTimeout(focusTimer); void unlisten.then(dispose => dispose()).catch(() => undefined); };
  }, [searchInput]);

  return { resultsPanePercent, setResultsPanePercent, savePreviewSplit, resetPreviewSplit, persistWindowState, hideWindow, startWindowDrag };
}
