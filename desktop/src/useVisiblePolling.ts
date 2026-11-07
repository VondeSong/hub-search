import { useEffect, useRef } from "react";
import { isWindowVisible, useDocumentVisible } from "./WindowVisibility";

export function useVisiblePolling(task: () => Promise<unknown> | unknown, enabled: boolean, intervalMs: number, options: { refreshKey?: unknown; initialDelayMs?: number } = {}) {
  const taskRef = useRef(task);
  const runningRef = useRef<{ generation: object; promise: Promise<unknown> } | null>(null);
  const previousVisible = useRef<boolean | null>(null);
  taskRef.current = task;
  const { refreshKey, initialDelayMs = 0 } = options;
  const visible = useDocumentVisible();

  useEffect(() => {
    if (!enabled) { previousVisible.current = null; return; }
    if (!visible) { if (previousVisible.current === true) previousVisible.current = false; return; }
    const resumed = previousVisible.current === false;
    previousVisible.current = true;
    let disposed = false;
    const generation = {};
    let timer = 0;

    const schedule = () => {
      window.clearTimeout(timer);
      if (!disposed && isWindowVisible()) timer = window.setTimeout(run, intervalMs);
    };
    const run = async () => {
      if (disposed || !isWindowVisible()) return;
      const previous = runningRef.current;
      if (previous) {
        await previous.promise.catch(() => undefined);
        if (!disposed && previous.generation !== generation) void run();
        else schedule();
        return;
      }
      const request = { generation, promise: Promise.resolve().then(() => taskRef.current()) };
      runningRef.current = request;
      try {
        await request.promise;
      } catch {
        // Polling is best-effort; the next visible interval will retry.
      } finally {
        if (runningRef.current === request) runningRef.current = null;
        schedule();
      }
    };
    if (initialDelayMs && !resumed) timer = window.setTimeout(run, initialDelayMs);
    else void run();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [enabled, visible, intervalMs, refreshKey, initialDelayMs]);
}
