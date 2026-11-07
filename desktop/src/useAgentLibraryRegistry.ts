import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Provider } from "./ProviderLabels";
import type { LibrarySummary } from "./SearchTypes";

export type AgentLibrary = Pick<LibrarySummary, "id" | "name">;
export type AgentLibraryRegistry = {
  libraries: LibrarySummary[];
  /** A successful snapshot exists; a failed refresh does not discard it. */
  loaded: boolean;
  loading: boolean;
  error: string;
  watchError: string;
  reload: () => Promise<void>;
};

type RegistryState = Omit<AgentLibraryRegistry, "reload" | "watchError">;

export function isAgentLibraryProvider(provider: unknown): provider is Provider {
  return provider === "craft" || provider === "obsidian" || provider === "dida365" || provider === "feishu";
}

/** A read-only registry for the assistant. It never restores provider connections. */
export function useAgentLibraryRegistry(enabled = true): AgentLibraryRegistry {
  const [state, setState] = useState<RegistryState>({ libraries: [], loaded: false, loading: enabled, error: "" });
  const [watchError, setWatchError] = useState("");
  const active = useRef(false);
  const revision = useRef(0);
  const reload = useCallback(async () => {
    if (!active.current) return;
    const requested = ++revision.current;
    setState(current => ({ ...current, loading: true, error: "" }));
    try {
      const libraries = await invoke<LibrarySummary[]>("list_libraries");
      if (!Array.isArray(libraries) || libraries.some(library => !library || typeof library.id !== "string" || !library.id.trim() || typeof library.name !== "string")) {
        throw new Error("资料库列表不可用，请重新读取。");
      }
      if (active.current && requested === revision.current) {
        setState({ libraries: [...new Map(libraries.map(library => [library.id, library])).values()], loaded: true, loading: false, error: "" });
      }
    } catch (reason) {
      if (active.current && requested === revision.current) setState(current => ({ ...current, loading: false, error: String(reason) }));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    active.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    setWatchError("");
    setState(current => ({ ...current, loading: true }));
    // Subscribe before taking the first snapshot so a change during setup is not lost.
    void Promise.resolve().then(() => listen("library-registry-updated", () => { if (!disposed) void reload(); })).then(stop => {
      if (disposed) { stop(); return; }
      unlisten = stop;
      void reload();
    }).catch(() => {
      if (!disposed) {
        setWatchError("资料库变更暂不能自动更新，可点击刷新。");
        void reload();
      }
    });
    return () => { disposed = true; active.current = false; revision.current++; unlisten?.(); };
  }, [enabled, reload]);

  return { ...state, loading: enabled && state.loading, watchError, reload };
}

/** Names are display data; the selected IDs remain the authorization identity. */
export function resolveAgentLibraries(selected: readonly AgentLibrary[], registry: Pick<AgentLibraryRegistry, "libraries" | "loaded">): AgentLibrary[] {
  const names = new Map(registry.libraries.map(library => [library.id, library.name]));
  return [...new Map(selected.map(library => [library.id, {
    id: library.id,
    name: names.get(library.id) || (library.name && library.name !== library.id ? library.name : registry.loaded ? "资料库不可用" : "已选资料库"),
  }])).values()];
}

export function agentLibraryScopeSummary(selected: readonly AgentLibrary[], registry: Pick<AgentLibraryRegistry, "libraries" | "loaded">, fallbackLabel = "添加资料范围") {
  const resolved = resolveAgentLibraries(selected, registry);
  const byId = new Map(registry.libraries.map(library => [library.id, library]));
  const unavailableCount = registry.loaded ? resolved.filter(library => !byId.has(library.id)).length : 0;
  const allSelected = registry.loaded && registry.libraries.length > 0 && resolved.length === registry.libraries.length && resolved.every(library => byId.has(library.id));
  const label = !resolved.length ? fallbackLabel : resolved.length === 1 ? resolved[0].name : allSelected ? `全部资料库 · ${resolved.length}` : `${resolved.length} 个资料库`;
  const title = resolved.length ? `${resolved.map(library => library.name).join("、")}${unavailableCount ? `；${unavailableCount} 个资料库当前不可用` : ""}` : fallbackLabel;
  return { label, title, unavailableCount, library: resolved.length === 1 ? byId.get(resolved[0].id) : undefined };
}
