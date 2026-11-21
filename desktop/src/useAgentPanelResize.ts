import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

const MIN_WIDTH = 0;
const MAX_WIDTH = 1200;
const DEFAULT_WIDTH = 440;
const clamp = (value: number, maximum: number, minimum = MIN_WIDTH) => Math.min(maximum, Math.max(minimum, Math.round(value)));

// Both edge handles use the same drag lifecycle; resizing never starts an investigation.
export function useAgentPanelResize(open: boolean, panel: RefObject<HTMLElement | null>, axis: "width" | "height" = "width", extra = false) {
  const vertical = axis === "height";
  const defaultSize = vertical ? Math.max(320, Math.round(window.innerHeight / 2)) : DEFAULT_WIDTH;
  const storageKey = `hub.agent.${extra ? "extra-" : ""}panel.${axis}.v1`;
  const cssProperty = `--agent-${extra ? "extra-" : ""}panel-${axis}`;
  const readSize = () => {
    try {
      const saved = localStorage.getItem(storageKey);
      const size = saved?.trim() ? Number(saved) : NaN;
      if (Number.isFinite(size) && size >= 0) return size;
    } catch {}
    return vertical ? null : DEFAULT_WIDTH;
  };
  const [preferredWidth, setPreferredWidth] = useState<number | null>(readSize);
  const [maximum, setMaximum] = useState(MAX_WIDTH);
  const finishDrag = useRef<(() => void) | null>(null);
  const minimum = vertical ? Math.min(320, maximum) : MIN_WIDTH;
  const width = clamp(preferredWidth ?? defaultSize, maximum, minimum);
  const dock = () => panel.current?.ownerDocument.body;
  const availableWidth = (element: HTMLElement) => {
    if (vertical) return window.innerHeight;
    const style = getComputedStyle(element);
    return element.clientWidth - (parseFloat(style.paddingInlineStart) || 0) - (parseFloat(style.paddingInlineEnd) || 0);
  };
  const saveSize = (value: number | null) => {
    setPreferredWidth(value);
    try {
      if (value === null) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, String(value));
    } catch {}
  };
  const setWidth = (value: number) => saveSize(clamp(value, maximum, minimum));
  const reset = () => saveSize(vertical ? null : DEFAULT_WIDTH);
  useLayoutEffect(() => { if (open) setPreferredWidth(readSize()); }, [open, axis]);

  useEffect(() => {
    const element = dock();
    if (!element || !open) return;
    const measure = () => {
      const available = availableWidth(element);
      if (available > 0) {
        setMaximum(clamp(Math.floor(available - 24), vertical ? Number.MAX_SAFE_INTEGER : MAX_WIDTH));
        if (!vertical && available <= 640) finishDrag.current?.();
      }
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [open]);

  useEffect(() => {
    const element = dock();
    if (!element || !open) return;
    element.style.setProperty(cssProperty, `${width}px`);
    return () => { element.style.removeProperty(cssProperty); };
  }, [open, width, cssProperty]);
  useEffect(() => () => { finishDrag.current?.(); }, [open]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const element = dock();
    if (event.button !== 0 || !element || availableWidth(element) <= 0) return;
    event.preventDefault();
    finishDrag.current?.();
    const target = event.currentTarget, pointer = event.pointerId, startX = vertical ? event.clientY : event.clientX;
    const bounds = panel.current?.getBoundingClientRect();
    const startWidth = (vertical ? bounds?.height : bounds?.width) || width;
    const direction = !vertical && getComputedStyle(element).direction === "rtl" ? 1 : -1;
    target.focus({ preventScroll: true });
    target.setPointerCapture?.(pointer);
    document.body.classList.add(vertical ? "resizing-agent-panel-height" : "resizing-agent-panel");
    const move = (next: globalThis.PointerEvent) => {
      if (next.pointerId !== pointer) return;
      const limit = clamp(Math.floor(availableWidth(element) - 24), vertical ? Number.MAX_SAFE_INTEGER : MAX_WIDTH);
      saveSize(clamp(startWidth + direction * ((vertical ? next.clientY : next.clientX) - startX), limit, vertical ? Math.min(320, limit) : MIN_WIDTH));
    };
    let active = true;
    const finish = (next?: globalThis.PointerEvent) => {
      if (!active || (next && next.pointerId !== pointer)) return;
      active = false;
      document.body.classList.remove(vertical ? "resizing-agent-panel-height" : "resizing-agent-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", blur);
      target.removeEventListener("lostpointercapture", finish);
      if (target.hasPointerCapture?.(pointer)) target.releasePointerCapture(pointer);
      finishDrag.current = null;
    };
    const blur = () => finish();
    finishDrag.current = blur;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", blur);
    target.addEventListener("lostpointercapture", finish);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const direction = !vertical && dock() && getComputedStyle(dock()!).direction === "rtl" ? -1 : 1;
    const step = event.shiftKey ? 40 : 10;
    let next: number;
    if (event.key === (vertical ? "ArrowUp" : "ArrowLeft")) next = width + direction * step;
    else if (event.key === (vertical ? "ArrowDown" : "ArrowRight")) next = width - direction * step;
    else if (event.key === "Home") next = minimum;
    else if (event.key === "End") next = maximum;
    else if (event.key === "Enter") next = defaultSize;
    else return;
    event.preventDefault();
    setWidth(next);
  };
  return { width, maximum, minimum, setWidth, reset, onPointerDown, onKeyDown };
}
