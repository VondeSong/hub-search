import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";

// Ephemeral work context survives module switches, but never writes content to disk.
const values = new Map<string, unknown>();
export function useWorkspaceSession<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => values.has(key) ? values.get(key) as T : initial);
  const update = useCallback((next: SetStateAction<T>) => {
    setValue(previous => {
      const resolved = typeof next === "function" ? (next as (value: T) => T)(previous) : next;
      values.set(key, resolved);
      return resolved;
    });
  }, [key]);
  return [value, update] as const;
}

const positions = new Map<string, number>();
export function useWorkspaceScroll(key: string, ready: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const restored = useRef(false);
  useEffect(() => {
    if (!ready || restored.current || !ref.current) return;
    ref.current.scrollTop = positions.get(key) ?? 0;
    restored.current = true;
  }, [key, ready]);
  const onScroll = useCallback(() => {
    if (restored.current && ref.current) positions.set(key, ref.current.scrollTop);
  }, [key]);
  return { ref, onScroll };
}
