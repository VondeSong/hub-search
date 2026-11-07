import { Fragment, useLayoutEffect, useRef } from "react";
import type { Evidence } from "./AgentDelivery";

export type CitationLocation = { excerpt: Evidence; quote: string; onReturn: () => void };

export function citationMatches(content: string, quote: string): number[] {
  if (!quote) return [];
  const matches: number[] = [];
  for (let at = content.indexOf(quote); at !== -1; at = content.indexOf(quote, at + 1)) matches.push(at);
  return matches;
}

// Render the authorized source response, never an unverified stale preview cache.
export function AgentCitationPreview({ value }: { value: CitationLocation }) {
  const root = useRef<HTMLElement>(null);
  const { excerpt, quote } = value;
  const matches = citationMatches(excerpt.content, quote);
  useLayoutEffect(() => {
    const target = matches.length === 1 ? root.current?.querySelector("mark") : root.current;
    target?.scrollIntoView?.({ block: "center", behavior: "instant" });
  }, [value]);
  const at = matches.length === 1 ? matches[0] : -1;
  return <section ref={root} className="agent-citation-preview" aria-label="引用定位">
    <header><div><strong>{excerpt.title}</strong><p>{excerpt.sourcePath}</p></div><button type="button" onClick={value.onReturn}>返回回答</button></header>
    <p role="status">{matches.length === 1 ? "已定位引用原文" : matches.length > 1 ? `原文中有 ${matches.length} 处相同文字，无法唯一定位；请结合上下文核对。` : "当前原文未找到该引用，请核对来源变化。"} · 第 {excerpt.startChar + 1}–{excerpt.endChar} / {excerpt.totalChars} 字符{excerpt.truncated ? "（节选）" : ""}</p>
    <div className="agent-citation-text">{at < 0 ? excerpt.content : <Fragment>{excerpt.content.slice(0, at)}<mark tabIndex={-1}>{quote}</mark>{excerpt.content.slice(at + quote.length)}</Fragment>}</div>
  </section>;
}
