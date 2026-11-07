import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WindowVisibility = { revision: string; visible: boolean; minimized: boolean; foreground: boolean };
const listeners = new Set<() => void>();
let nativeState: WindowVisibility | null = null;
let lifetime: { active: boolean; ready: boolean; unlisten?: UnlistenFn; pending: boolean } | null = null;
let detachDocument: (() => void) | null = null;
const nativeHost = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function isWindowVisible(): boolean {
  if (typeof document === "undefined" || document.hidden) return false;
  if (!nativeHost()) return true;
  return Boolean(nativeState?.visible && !nativeState.minimized && nativeState.foreground);
}
const notify = () => listeners.forEach(listener => listener());
function accept(value: WindowVisibility, owner: NonNullable<typeof lifetime>) {
  if (!owner.active || lifetime !== owner || typeof value?.revision !== "string" || !/^\d+$/.test(value.revision)
    || [value.visible, value.minimized, value.foreground].some(field => typeof field !== "boolean")) return;
  if (nativeState && BigInt(value.revision) <= BigInt(nativeState.revision)) return;
  nativeState = value;
  notify();
}
async function refresh(owner: NonNullable<typeof lifetime>) {
  if (!owner.active || !owner.ready || owner.pending) return;
  owner.pending = true;
  try { accept(await invoke<WindowVisibility>("get_window_visibility"), owner); }
  catch { /* Keep the last authoritative host state until the next focus event. */ }
  finally { owner.pending = false; }
}
function start() {
  const owner = { active: true, ready: false, pending: false } as NonNullable<typeof lifetime>;
  lifetime = owner;
  const changed = () => notify();
  const focused = () => { if (nativeHost()) void refresh(owner); };
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("focus", focused);
  detachDocument = () => {
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("focus", focused);
  };
  if (nativeHost()) void (async () => {
    try {
      const unlisten = await listen<WindowVisibility>("hub-window-visibility", event => accept(event.payload, owner));
      if (!owner.active || lifetime !== owner) { unlisten(); return; }
      owner.unlisten = unlisten;
    } catch { /* An initial query still supplies the host's current state. */ }
    owner.ready = true;
    await refresh(owner);
  })();
}
export function subscribeWindowVisibility(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      if (lifetime) { lifetime.active = false; lifetime.unlisten?.(); }
      lifetime = null; nativeState = null;
      detachDocument?.(); detachDocument = null;
    }
  };
}
export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribeWindowVisibility, isWindowVisible, () => false);
}
