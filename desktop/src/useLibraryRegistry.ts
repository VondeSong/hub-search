import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import { reconcileLibraryCounts } from "./LibraryManagement";
import type { LibrarySyncHealth } from "./IndexStatusTypes";
import type { LibrarySummary } from "./SearchTypes";

export function useLibraryRegistry() {
  const [spaces, setSpaces] = useState<LibrarySummary[]>([]);
  const [ready, setReady] = useState(false);
  const [registryError, setRegistryError] = useState("");
  const current = useRef(spaces);
  const health = useRef<LibrarySyncHealth[]>([]);
  const active = useRef(false);
  const started = useRef(false);
  const revision = useRef(0);
  const reloadSpaces = useCallback(async () => {
    const requested = ++revision.current;
    const next = await invoke<LibrarySummary[]>("list_libraries");
    if (active.current && requested === revision.current) {
      current.current = reconcileLibraryCounts(next, health.current);
      setSpaces(current.current); setReady(true); setRegistryError("");
    }
    return next;
  }, []);
  const reconcileCounts = useCallback((nextHealth: LibrarySyncHealth[]) => {
    health.current = nextHealth;
    const synchronized = reconcileLibraryCounts(current.current, nextHealth);
    if (synchronized === current.current || !active.current) return false;
    current.current = synchronized; setSpaces(synchronized);
    return true;
  }, []);
  useEffect(() => {
    active.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("library-registry-updated", () => { if (!disposed) void reloadSpaces().catch(() => undefined); })
      .then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => undefined);
    if (!started.current) {
      started.current = true;
      void (async () => {
        // Local libraries become usable before a provider restoration completes.
        try { await reloadSpaces(); }
        catch (reason) { if (active.current) setRegistryError(String(reason)); }
        finally { if (active.current) setReady(true); }
        if (!active.current) return;
        try { await invoke("restore_connections"); }
        catch { /* Each persisted library retains its provider reconnect status. */ }
        if (!active.current) return;
        try { await reloadSpaces(); }
        catch { /* Keep the already loaded local registry when only refresh fails. */ }
      })();
    }
    return () => { active.current = false; disposed = true; unlisten?.(); };
  }, [reloadSpaces]);
  return { spaces, ready, reloadSpaces, reconcileCounts, registryError };
}
