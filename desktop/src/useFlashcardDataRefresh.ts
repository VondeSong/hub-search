import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Observe committed sync data without replacing an editor or active review session. */
export function useFlashcardDataRefresh(refresh: () => Promise<unknown> | unknown) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let disposed = false;
    let running = false;
    let queued = false;
    let unlisten: UnlistenFn | undefined;
    const changed = async () => {
      if (disposed) return;
      if (running) { queued = true; return; }
      running = true;
      try {
        do {
          queued = false;
          await refreshRef.current();
        } while (queued && !disposed);
      } catch { /* Each consumer owns its error presentation. */ }
      finally { running = false; }
    };
    window.addEventListener("hub:cloud-data-changed", changed);
    if ("__TAURI_INTERNALS__" in window) {
      void listen("flashcards-data-changed", changed).then(detach => {
        if (disposed) { detach(); return; }
        unlisten = detach;
        // Close the gap between the initial read and asynchronous listener registration.
        void changed();
      }).catch(() => undefined);
    }
    return () => {
      disposed = true;
      window.removeEventListener("hub:cloud-data-changed", changed);
      unlisten?.();
    };
  }, []);
}
