import { useEffect } from "react";
import { isWindowVisible, subscribeWindowVisibility } from "./WindowVisibility";

// Real data changes still invalidate a collapsed projection. While hidden,
// retain one dirty notification and refresh once when the document returns.
export function useVisibleChange(eventName: string, onChange: () => unknown) {
  useEffect(() => {
    let dirty = false;
    const flush = () => {
      if (!isWindowVisible() || !dirty) return;
      dirty = false;
      onChange();
    };
    const changed = () => { dirty = true; flush(); };
    window.addEventListener(eventName, changed);
    const unsubscribe = subscribeWindowVisibility(flush);
    return () => {
      window.removeEventListener(eventName, changed);
      unsubscribe();
    };
  }, [eventName, onChange]);
}
