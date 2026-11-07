import { invoke } from "@tauri-apps/api/core";
import { useCallback, useState } from "react";
import { DEFAULT_APP_SETTINGS, normalizeAppSettings, type AppSettings, type CraftOpenMode } from "./AppSettings";

export function useAppSettings(onSaveError: (message: string) => void) {
  const [appSettings, setAppSettings] = useState<AppSettings>(() => ({ ...DEFAULT_APP_SETTINGS }));
  const [updatingShortcut, setUpdatingShortcut] = useState(false);
  const [shortcutMessage, setShortcutMessage] = useState("");

  const loadAppSettings = useCallback(async () => {
    const settings = normalizeAppSettings(await invoke<AppSettings>("get_settings"));
    setAppSettings(settings);
    return settings;
  }, []);

  const saveSettings = useCallback(async (next: AppSettings) => {
    try {
      const settings = normalizeAppSettings(await invoke<AppSettings>("update_settings", next));
      setAppSettings(settings);
    } catch (reason) {
      onSaveError(String(reason));
    }
  }, [onSaveError]);

  const changeToggleShortcut = useCallback(async (shortcut: string) => {
    setUpdatingShortcut(true); setShortcutMessage("");
    try {
      const saved = await invoke<string>("update_toggle_shortcut", { shortcut });
      setAppSettings(current => ({ ...current, toggleShortcut: saved }));
      setShortcutMessage(`显示/隐藏快捷键已改为 ${saved}。`);
    } catch (reason) { setShortcutMessage(String(reason)); }
    finally { setUpdatingShortcut(false); }
  }, []);
  const changeAutoSync = useCallback((minutes: number) => {
    void saveSettings({ ...appSettings, autoSyncMinutes: minutes });
  }, [appSettings, saveSettings]);
  const changeRecentGroupingSetting = useCallback((enabled: boolean) => {
    void saveSettings({ ...appSettings, groupRecentByDateWhenUnlimited: enabled });
  }, [appSettings, saveSettings]);
  const changeCraftOpenMode = useCallback((source: "result" | "preview", mode: CraftOpenMode) => {
    void saveSettings(source === "preview" ? { ...appSettings, craftPreviewOpenMode: mode } : { ...appSettings, craftResultOpenMode: mode });
  }, [appSettings, saveSettings]);

  return { appSettings, loadAppSettings, saveSettings, updatingShortcut, shortcutMessage, changeToggleShortcut, changeAutoSync, changeRecentGroupingSetting, changeCraftOpenMode };
}
