import { useLayoutEffect, useRef, useState } from "react";
import { formatDate } from "./SearchResultPresentation";

/** Keep both ends of a path, using the actual available width rather than a character limit. */
export function middleEllipsis(text: string, width: number, measure: (value: string) => number): string {
  if (measure(text) <= width) return text;
  const chars = Array.from(text);
  let low = 0, high = chars.length - 1, best = "…";
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const head = Math.ceil(count * 0.4), tail = count - head;
    const candidate = chars.slice(0, head).join("") + "…" + (tail ? chars.slice(-tail).join("") : "");
    if (measure(candidate) <= width) { best = candidate; low = count + 1; }
    else high = count - 1;
  }
  return best;
}

export function SearchResultContext({ path, modifiedAt }: { path: string; modifiedAt?: number }) {
  const pathRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [shortened, setShortened] = useState({ path, text: path });
  const date = formatDate(modifiedAt);
  useLayoutEffect(() => {
    const element = pathRef.current, ruler = measureRef.current;
    if (!element || !ruler) return;
    let disposed = false;
    const update = () => {
      const width = element.getBoundingClientRect().width;
      if (disposed || width <= 0) return;
      const text = middleEllipsis(path, width + 0.01, value => {
        ruler.textContent = value;
        return ruler.getBoundingClientRect().width;
      });
      setShortened(previous => previous.path === path && previous.text === text ? previous : { path, text });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(element);
    document.fonts?.ready.then(update);
    return () => { disposed = true; observer?.disconnect(); };
  }, [path, date]);
  return <span className="grouped-page-context" title={`${path} · ${date ? `更新于 ${date}` : "更新日期未知"}`}>
    <span className="grouped-context-path" ref={pathRef} aria-label={path}>
      <span className="grouped-context-full" aria-hidden="true">{path}</span>
      <span className="grouped-context-visible" aria-hidden="true">{shortened.path === path ? shortened.text : path}</span>
    </span>
    <span className="grouped-context-ruler" ref={measureRef} aria-hidden="true" />
    <span className="grouped-context-date">· {date ? <time dateTime={new Date(modifiedAt! * 1000).toISOString()}>更新于 {date}</time> : "更新日期未知"}</span>
  </span>;
}
