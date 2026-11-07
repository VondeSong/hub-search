import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

export function useMobileSearch({ enabled, query, setQuery, input }: {
  enabled: boolean; query: string; setQuery: (value: string) => void;
  input: RefObject<HTMLInputElement | null>;
}) {
  const [expanded, setExpanded] = useState(false);
  const session = useRef<{ query: string; trigger: HTMLElement | null } | null>(null);
  const open = useCallback(() => {
    if (!enabled) return;
    if (!session.current) {
      session.current = { query, trigger: document.activeElement instanceof HTMLElement ? document.activeElement : null };
      window.history.pushState({ ...(window.history.state ?? {}), hubMobileSearch: true }, "");
    }
    // Reveal the field within the tap, so WebView can open its keyboard on focus.
    flushSync(() => setExpanded(true));
    input.current?.focus();
  }, [enabled, input, query]);
  const consumeBack = useCallback(() => {
    if (!session.current) return false;
    const previous = session.current;
    session.current = null;
    input.current?.blur();
    setExpanded(false);
    setQuery(previous.query);
    requestAnimationFrame(() => previous.trigger?.focus({ preventScroll: true }));
    return true;
  }, [input, setQuery]);
  const cancel = useCallback(() => {
    input.current?.blur();
    if (session.current) window.history.back();
  }, [input]);
  useEffect(() => {
    if (!expanded) return;
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [expanded, input]);
  return { expanded, open, cancel, consumeBack };
}
