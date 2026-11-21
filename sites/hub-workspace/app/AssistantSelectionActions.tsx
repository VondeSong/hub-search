import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { PanelLeft, Quote } from "lucide-react";

type Selection = { text: string; x: number; top: number; bottom: number };

export function AssistantSelectionActions({ scroll, selector, onAdd, onSide }: {
  scroll: RefObject<HTMLDivElement | null>;
  selector: string;
  onAdd: (text: string) => boolean;
  onSide?: (text: string) => boolean;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const region = scroll.current;
    if (!region) return;
    let pointerId: number | null = null;
    const sync = () => {
      if (pointerId !== null) return;
      const domSelection = document.getSelection();
      const start = domSelection?.anchorNode;
      const end = domSelection?.focusNode;
      const container = (start instanceof Element ? start : start?.parentElement)?.closest(selector);
      if (!domSelection || domSelection.isCollapsed || !container || !region.contains(container) || !container.contains(end ?? null)) {
        setSelection(null);
        return;
      }
      const text = domSelection.toString().trim();
      const clip = region.getBoundingClientRect();
      const bounds = Array.from(domSelection.getRangeAt(0).getClientRects()).find(rect =>
        rect.width && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right);
      setSelection(text && bounds ? {
        text, x: Math.max(clip.left, bounds.left), top: Math.max(clip.top, bounds.top), bottom: Math.min(clip.bottom, bounds.bottom),
      } : null);
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbar.current?.contains(event.target)) return;
      if (event.target instanceof Node && region.contains(event.target)) pointerId = event.pointerId;
      setSelection(null);
    };
    const pointerEnd = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      sync();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !toolbar.current) return;
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      event.stopPropagation();
    };
    document.addEventListener("selectionchange", sync);
    document.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", pointerEnd);
    window.addEventListener("pointercancel", pointerEnd);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", sync);
    region.addEventListener("scroll", sync, true);
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerEnd);
      window.removeEventListener("pointercancel", pointerEnd);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", sync);
      region.removeEventListener("scroll", sync, true);
    };
  }, [scroll, selector]);

  if (!selection) return null;
  const left = Math.max(8, Math.min(selection.x, window.innerWidth - (onSide ? 286 : 150)));
  const above = selection.top > 54;
  function apply(action: (text: string) => boolean) {
    if (selection && action(selection.text)) {
      document.getSelection()?.removeAllRanges();
      setSelection(null);
    }
  }

  return createPortal(<div ref={toolbar} className="assistant-selection-actions" role="group" aria-label="所选文字操作"
    style={{ left, top: above ? selection.top - 6 : selection.bottom + 6, translate: above ? "0 -100%" : undefined }}
    onMouseDown={event => event.preventDefault()}>
    <button type="button" onClick={() => apply(onAdd)}><Quote size={15} aria-hidden="true"/>添加到对话</button>
    {onSide && <button type="button" onClick={() => apply(onSide)}><PanelLeft size={15} aria-hidden="true"/>在侧边聊天中提问</button>}
  </div>, document.body);
}
