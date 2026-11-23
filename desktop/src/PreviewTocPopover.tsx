import { List } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState, type RefObject } from "react";

export type PreviewTocHeading = {
  id: string;
  text: string;
  level: 1 | 2 | 3;
  element: HTMLElement;
};

function collectHeadings(container: HTMLElement | null): PreviewTocHeading[] {
  if (!container) return [];
  const nodes = container.querySelectorAll<HTMLElement>("h1, h2, h3");
  const result: PreviewTocHeading[] = [];
  let index = 0;
  for (const node of nodes) {
    if (node.classList.contains("preview-title")) continue;
    if (node.closest("[hidden], .preview-toc-popover, .agent-citation-preview")) continue;
    const text = node.textContent?.trim();
    if (!text) continue;
    const tag = node.tagName.toUpperCase();
    const level: 1 | 2 | 3 = tag === "H1" ? 1 : tag === "H2" ? 2 : 3;
    result.push({ id: `${index++}:${level}:${text}`, text, level, element: node });
  }
  return result;
}

export const PreviewTocPopover = memo(function PreviewTocPopover({
  contentRef,
  contentKey,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
  contentKey?: string;
}) {
  const [headings, setHeadings] = useState<PreviewTocHeading[]>([]);
  const [open, setOpen] = useState(false);
  const [alignLeft, setAlignLeft] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const scan = useCallback(() => {
    setHeadings(collectHeadings(contentRef.current));
  }, [contentRef]);

  useEffect(() => {
    setOpen(false);
    scan();
    const region = contentRef.current;
    if (!region || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => scan());
    observer.observe(region, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [contentKey, contentRef, scan]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  if (headings.length < 2) return null;

  const jumpTo = (element: HTMLElement) => {
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }
    setOpen(false);
  };

  const toggleOpen = () => {
    setOpen((current) => {
      if (current) return false;
      const wrap = wrapRef.current;
      const card = wrap?.closest(".preview-card");
      if (wrap && card) {
        const triggerRect = wrap.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const spaceLeft = triggerRect.right - cardRect.left;
        const spaceRight = cardRect.right - triggerRect.left;
        setAlignLeft(spaceLeft < 248 && spaceRight > spaceLeft);
      } else {
        setAlignLeft(false);
      }
      return true;
    });
  };

  return (
    <div className="preview-toc-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`preview-toc-trigger${open ? " active" : ""}`}
        aria-label="本页目录"
        title="本页目录"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <List size={16} />
      </button>
      {open && (
        <div className={`preview-toc-popover${alignLeft ? " align-left" : ""}`} role="dialog" aria-label="本页目录">
          <div className="preview-toc-head">本页目录</div>
          {headings.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`preview-toc-item level-${item.level}`}
              title={item.text}
              onClick={() => jumpTo(item.element)}
            >
              {item.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
