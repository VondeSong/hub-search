import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { runtimeCapabilities } from "./RuntimePlatform";
import { showOperationStatus } from "./useOperationStatus";

export function useAgentConditionNotices() {
  useEffect(() => {
    if (!runtimeCapabilities.desktop) return;
    let stopped = false;
    let unsubscribe: (() => void) | undefined;
    const seen = new Set<string>();
    void listen<{ eventId: string; message: string; goal: string; tone?: string }>("agent-condition-notice", event => {
      const value = event.payload;
      if (stopped || !value || typeof value.eventId !== "string" || typeof value.message !== "string" || typeof value.goal !== "string" || seen.has(value.eventId)) return;
      if (seen.size >= 100) seen.delete(seen.values().next().value!);
      seen.add(value.eventId);
      showOperationStatus(`${value.goal.slice(0, 60)}：${value.message.slice(0, 200)}`, value.tone === "warning" ? "warning" : "success", 6_000);
    }).then(stop => { if (stopped) stop(); else unsubscribe = stop; }).catch(() => { /* Persistent notice remains on the work. */ });
    return () => { stopped = true; unsubscribe?.(); };
  }, []);
}
