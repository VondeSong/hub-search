import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { userProfileStorage } from "./UserProfileStorage";

type Bookmark = {
  key: string;
  title: string;
  paragraph: number;
  fraction: number;
};
export type ReadingAnchor =
  | { query: string; context?: string; occurrence?: number }
  | { bookmark: Bookmark };
const storageKey = "hub.mobile.reading.position.v1";

function readBookmark(): Bookmark | null {
  try {
    const mark = JSON.parse(userProfileStorage.getItem(storageKey) || "null");
    return mark &&
      typeof mark.key === "string" &&
      typeof mark.title === "string" &&
      Number.isInteger(mark.paragraph) &&
      Number.isFinite(mark.fraction)
      ? mark
      : null;
  } catch {
    return null;
  }
}

export function useMobileReadingPosition(
  ref: RefObject<HTMLDivElement | null>,
  key: string | undefined,
  title: string,
) {
  const [bookmark, setBookmark] = useState(readBookmark);
  const pending = useRef<ReadingAnchor | null>(null);
  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane || !key) return;
    const paragraphs = Array.from(
      pane.querySelectorAll<HTMLElement>(
        ".collection-post-text :is(p,li,h1,h2,h3,h4),.collection-public-snapshot [data-reading-line]:not(:empty)",
      ),
    );
    const anchor = pending.current;
    pending.current = null;
    let match: HTMLElement | undefined;
    const ranges: Range[] = [];
    if (anchor && "query" in anchor && anchor.query.trim()) {
      const needle = anchor.query.trim().toLowerCase();
      const hits = paragraphs.filter((p) =>
        p.textContent?.toLowerCase().includes(needle),
      );
      const context = anchor.context
        ?.replace(/<\/?mark>/gi, "")
        .replace(/^[…\s]+|[…\s]+$/g, "")
        .toLowerCase();
      match =
        (context &&
          hits.find((p) => {
            const text = p.textContent?.trim().toLowerCase();
            return text && (text.includes(context) || context.includes(text));
          })) ||
        hits[anchor.occurrence || 0] ||
        hits[0];
      if (match) {
        const walker = document.createTreeWalker(match, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node.textContent?.toLowerCase() || "";
          const index = text.indexOf(needle);
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          ranges.push(range);
        }
        match.classList.add("mobile-reading-hit");
        if (typeof Highlight !== "undefined")
          CSS.highlights.set("mobile-reading-match", new Highlight(...ranges));
      }
    }
    const saved =
      anchor && "bookmark" in anchor
        ? anchor.bookmark
        : !anchor && window.history.state?.hubReadingPreview
          ? readBookmark()
          : null;
    const para =
      match || (saved?.key === key ? paragraphs[saved.paragraph] : undefined);
    if (para)
      pane.scrollTop +=
        para.getBoundingClientRect().top -
        pane.getBoundingClientRect().top +
        (match ? -8 : para.offsetHeight * (saved?.fraction || 0));
    const save = () => {
      const top = pane.getBoundingClientRect().top;
      let index = -1;
      for (const [i, p] of paragraphs.entries()) {
        if (p.getBoundingClientRect().top > top + 9) break;
        index = i;
      }
      const p = paragraphs[index];
      const mark = {
        key,
        title,
        paragraph: index,
        fraction: p
          ? Math.max(
              0,
              Math.min(
                1,
                (top - p.getBoundingClientRect().top) /
                  Math.max(1, p.offsetHeight),
              ),
            )
          : 0,
      };
      userProfileStorage.setItem(storageKey, JSON.stringify(mark));
      setBookmark(mark);
    };
    // A short article can show the whole hit without enough space to align it at the top.
    if (para) {
      const mark = {
        key,
        title,
        paragraph: paragraphs.indexOf(para),
        fraction: match ? 0 : saved?.fraction || 0,
      };
      userProfileStorage.setItem(storageKey, JSON.stringify(mark));
      setBookmark(mark);
    } else save();
    let moved = false;
    let timer: ReturnType<typeof setTimeout>;
    const scroll = () => {
      moved = true;
      clearTimeout(timer);
      timer = setTimeout(save, 180);
    };
    pane.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(timer);
      if (moved && pane.isConnected) save();
      pane.removeEventListener("scroll", scroll);
      window.removeEventListener("pagehide", save);
      match?.classList.remove("mobile-reading-hit");
      if (typeof Highlight !== "undefined")
        CSS.highlights.delete("mobile-reading-match");
    };
  }, [ref, key, title]);
  return { bookmark, pending };
}
