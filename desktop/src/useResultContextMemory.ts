import { useEffect, useLayoutEffect, useRef } from "react";

type Entry = { entityKey: string; top: number };
const memory = new Map<string, Entry>();
// Store identities, not row numbers: refreshed results may be reordered.
export function useResultContextMemory(context: string, items: { entityKey: string }[], index: number, ready: boolean, restore?: (index: number) => void, selectionManagedByData = false) {
  const ref = useRef<HTMLDivElement>(null);
  const active = useRef("");
  const pendingIndex = useRef<number | null>(null);
  const previousItems = useRef(items);
  useLayoutEffect(() => {
    if (!ready || !restore || !ref.current) return;
    const entering = active.current !== context;
    if (!entering && previousItems.current === items) return;
    // Local search publishes order and selection together. Remapping that new
    // position through the old array would select another source and close its
    // assistant. Other lists still delegate refresh preservation to this hook.
    if (!entering && selectionManagedByData) {
      previousItems.current = items;
      pendingIndex.current = null;
      return;
    }
    const saved = memory.get(context);
    // A click can update selection and refresh the array in the same render
    // (for example when recording viewing history). Prefer that live selection
    // over the saved selection from the preceding render.
    const selectedKey = entering ? saved?.entityKey : previousItems.current[index]?.entityKey;
    const found = selectedKey ? items.findIndex(item => item.entityKey === selectedKey) : -1;
    const nextIndex = found < 0 ? 0 : found;
    pendingIndex.current = nextIndex;
    active.current = context;
    previousItems.current = items;
    if (index !== nextIndex) restore(nextIndex);
    if (entering) ref.current.scrollTop = saved?.top ?? 0;
  }, [context, items, index, ready, restore, selectionManagedByData]);
  useEffect(() => {
    if (!ready || active.current !== context || !restore) return;
    if (pendingIndex.current !== null && index !== pendingIndex.current) return;
    pendingIndex.current = null;
    const previous = memory.get(context);
    memory.set(context, { entityKey: items[index]?.entityKey ?? "", top: previous?.top ?? 0 });
    // Bound session-only history when searching many distinct phrases.
    if (memory.size > 100) memory.delete(memory.keys().next().value!);
  }, [context, index, items, ready, restore]);
  const onScroll = () => {
    if (!ready || active.current !== context || pendingIndex.current !== null || !restore) return;
    const saved = memory.get(context);
    memory.set(context, { entityKey: saved?.entityKey ?? items[index]?.entityKey ?? "", top: ref.current?.scrollTop ?? 0 });
  };
  return { ref, onScroll };
}
