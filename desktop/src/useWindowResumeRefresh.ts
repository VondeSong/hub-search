import { useEffect, useRef } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";

export function useWindowResumeRefresh(task: () => Promise<unknown> | unknown, delayMs = 80) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    let disposed = false;
    let running = false;
    let queued = false;
    let timer = 0;

    const run = async () => {
      if (disposed || !isWindowVisible()) return;
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        await taskRef.current();
      } catch {
        // The caller owns error presentation; resume events must not create an unhandled rejection.
      } finally {
        running = false;
        if (queued) {
          queued = false;
          requestRefresh();
        }
      }
    };
    const requestRefresh = () => {
      if (disposed || !isWindowVisible()) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(), delayMs);
    };
    const handleVisibilityChange = () => {
      if (isWindowVisible()) requestRefresh();
      else { window.clearTimeout(timer); queued = false; }
    };

    window.addEventListener("focus", requestRefresh);
    const unsubscribe = subscribeWindowVisibility(handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", requestRefresh);
      unsubscribe();
    };
  }, [delayMs]);
}
