import { BookmarkCheck, BookmarkPlus, Copy, Sparkles } from "lucide-react";
import { useContext, useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { runtimeCapabilities } from "./RuntimePlatform";
import { AgentPanelContext, AgentTextMaterialContext, type Entry } from "./StandaloneAgentLauncher";
import { writeClipboardText } from "./usePreviewController";

type SelectionBox = {
  text: string;
  x: number;
  top: number;
  bottom: number;
};

export type SelectionSnippetOutcome = "added" | "removed" | void;
export type SelectionNotifyTone = "success" | "error";

export function PreviewSelectionActions({
  scrollRef,
  contentKey = "",
  title,
  agentEntry = null,
  isSnippetSaved,
  onSaveSnippet,
  onNotify,
  enabled = true,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  contentKey?: string;
  title: string;
  agentEntry?: Entry;
  isSnippetSaved?: (text: string) => boolean;
  onSaveSnippet?: (text: string) => SelectionSnippetOutcome;
  onNotify?: (message: string, tone?: SelectionNotifyTone) => void;
  enabled?: boolean;
}) {
  const openAgent = useContext(AgentPanelContext);
  const textMaterials = useContext(AgentTextMaterialContext);
  const [selection, setSelection] = useState<SelectionBox | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);

  const active = enabled && runtimeCapabilities.platform !== "android";

  useEffect(() => {
    setSelection(null);
    if (!active) return;
    const boundRegion = scrollRef.current;
    if (!boundRegion) return;
    let pointerId: number | null = null;

    const currentRegion = () => scrollRef.current;

    const sync = () => {
      if (pointerId !== null) return;
      const region = currentRegion();
      if (!region) {
        setSelection(null);
        return;
      }
      const domSelection = document.getSelection();
      if (!domSelection || domSelection.isCollapsed || domSelection.rangeCount === 0) {
        setSelection(null);
        return;
      }
      const anchor = domSelection.anchorNode;
      const focus = domSelection.focusNode;
      if (!anchor || !focus || !region.contains(anchor) || !region.contains(focus)) {
        setSelection(null);
        return;
      }
      const anchorEl = anchor instanceof Element ? anchor : anchor.parentElement;
      if (anchorEl?.closest("input, textarea, select, [contenteditable='true'], .agent-panel, .preview-toc-popover")) {
        setSelection(null);
        return;
      }
      const text = domSelection.toString().trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const clip = region.getBoundingClientRect();
      const range = domSelection.getRangeAt(0);
      const rects = Array.from(range.getClientRects?.() ?? []);
      const visibleRect = rects.find((rect) =>
        rect.width > 0 && rect.bottom > clip.top && rect.top < clip.bottom && rect.right > clip.left && rect.left < clip.right,
      );
      const fallbackRect = range.getBoundingClientRect?.();
      const bounds = visibleRect ?? (fallbackRect && (fallbackRect.width > 0 || fallbackRect.height > 0) ? fallbackRect : null);
      if (!bounds) {
        setSelection(null);
        return;
      }
      const hasClipBounds = clip.width > 0 && clip.height > 0;
      setSelection({
        text,
        x: hasClipBounds ? Math.max(clip.left, bounds.left) : bounds.left,
        top: hasClipBounds ? Math.max(clip.top, bounds.top) : bounds.top,
        bottom: hasClipBounds ? Math.min(clip.bottom, bounds.bottom) : bounds.bottom,
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && pillRef.current?.contains(event.target)) return;
      const region = currentRegion();
      if (event.target instanceof Node && region?.contains(event.target)) pointerId = event.pointerId;
      setSelection(null);
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (pointerId !== event.pointerId) return;
      pointerId = null;
      sync();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !pillRef.current) return;
      document.getSelection()?.removeAllRanges();
      setSelection(null);
      event.stopPropagation();
    };

    document.addEventListener("selectionchange", sync);
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", sync);
    boundRegion.addEventListener("scroll", sync, true);

    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", sync);
      boundRegion.removeEventListener("scroll", sync, true);
    };
  }, [active, scrollRef, contentKey]);

  if (!active || !selection) return null;

  const canAskAgent = Boolean(openAgent && textMaterials);
  const snippetSaved = Boolean(isSnippetSaved?.(selection.text));
  const buttonCount = (onSaveSnippet ? 1 : 0) + (canAskAgent ? 1 : 0) + 1;
  const estimatedWidth = buttonCount * 96;
  const left = Math.max(8, Math.min(selection.x, Math.max(8, window.innerWidth - estimatedWidth)));
  const above = selection.top > 56;

  const dismiss = () => {
    document.getSelection()?.removeAllRanges();
    setSelection(null);
  };

  const handleSaveSnippet = () => {
    if (!onSaveSnippet) return;
    const text = selection.text;
    try {
      const outcome = onSaveSnippet(text);
      const removed = outcome === "removed" || (outcome === undefined && snippetSaved);
      onNotify?.(removed ? "已取消摘录收藏" : "已收藏所选摘录", "success");
      dismiss();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      onNotify?.(`摘录收藏失败：${detail}`, "error");
    }
  };

  const handleAskAgent = () => {
    if (!openAgent || !textMaterials) return;
    textMaterials.setPending({ kind: "text", title: title || "当前页面", text: selection.text });
    openAgent(agentEntry);
    dismiss();
  };

  const handleCopy = async () => {
    const text = selection.text;
    try {
      await writeClipboardText(text);
      onNotify?.("已复制所选摘录", "success");
      dismiss();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      onNotify?.(`复制摘录失败：${detail}`, "error");
    }
  };

  return createPortal(
    <div
      ref={pillRef}
      className="preview-selection-pill"
      role="group"
      aria-label="选中文字快捷操作"
      style={{
        left,
        top: above ? selection.top - 8 : selection.bottom + 8,
        transform: above ? "translateY(-100%)" : undefined,
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {onSaveSnippet && (
        <>
          <button
            type="button"
            aria-pressed={snippetSaved}
            onClick={handleSaveSnippet}
          >
            {snippetSaved ? <BookmarkCheck size={13} aria-hidden="true" /> : <BookmarkPlus size={13} aria-hidden="true" />}
            <span>{snippetSaved ? "取消摘录" : "摘录收藏"}</span>
          </button>
          <span className="preview-selection-pill-sep" aria-hidden="true" />
        </>
      )}
      {canAskAgent && (
        <>
          <button type="button" className="primary-ask" onClick={handleAskAgent}>
            <Sparkles size={13} aria-hidden="true" />
            <span>问助手</span>
          </button>
          <span className="preview-selection-pill-sep" aria-hidden="true" />
        </>
      )}
      <button type="button" onClick={() => void handleCopy()}>
        <Copy size={13} aria-hidden="true" />
        <span>复制摘录</span>
      </button>
    </div>,
    document.body,
  );
}
