// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { prepareQuickSearchResults, searchResultSummary } from "./QuickSearchGrouping";
import { normalizeQuickSearchResults } from "./SearchResultTestData";
import { LibraryIcon } from "./LibraryIcon";
import { QuickSearchResultList } from "./QuickSearchResultList";
import type { SearchResult } from "./SearchTypes";
import { pageFavoriteKey, snippetFavoriteKey } from "./PageFavorites";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function hits(count = 4) {
  return normalizeQuickSearchResults(Array.from({ length: count }, (_, i) => ({
    id: `hit-${i}`, entityKey: `hit-${i}`, blockId: `block-${i}`, documentId: "page", spaceId: "main", libraryName: "Main",
    title: "页面", snippet: `历史片段 ${i}`, matchTerms: ["历史"], matchField: "body",
  })));
}

it("labels a completed Dida task in search results", async () => {
  const result = { ...hits(1)[0], provider: "dida365" as const, taskStatus: 2 };
  const node = document.createElement("div"); const root = createRoot(node);
  try {
    await act(async () => root.render(<QuickSearchResultList query="页面" results={[result]} selectedIndex={0} renderLibraryIcon={() => null} onSelectResult={() => {}} onOpenResult={() => {}} />));
    expect(node.querySelector(".grouped-page-title .dida-result-status")?.textContent).toBe("已完成");
  } finally { await act(async () => root.unmount()); }
});

it("handles path and snippet menus separately and exposes an independent snippet bookmark", async () => {
  const results = hits(1);
  const node = document.createElement("div"); const root = createRoot(node);
  const context = vi.fn(); const save = vi.fn(); const select = vi.fn();
  const props = { query: "历史", results, selectedIndex: -1, renderLibraryIcon: () => null, onSelectResult: select, onOpenResult: () => {}, onContextResult: context, onToggleSnippetFavorite: save };
  try {
    await act(async () => root.render(<QuickSearchResultList {...props} />));
    const pathEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => node.querySelector(".grouped-page-context")!.dispatchEvent(pathEvent));
    expect(pathEvent.defaultPrevented).toBe(true);
    expect(context.mock.calls[0][1].favoriteKind).toBe("page");
    expect(context.mock.calls[0][1].snippet).toBe("");
    const snippetEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(async () => node.querySelector(".grouped-passage-excerpt")!.dispatchEvent(snippetEvent));
    expect(snippetEvent.defaultPrevented).toBe(true);
    expect(context.mock.calls[1][1]).toBe(results[0]);
    const button = node.querySelector<HTMLButtonElement>(".grouped-snippet-favorite")!;
    expect(button.getAttribute("aria-label")).toBe("收藏此片段");
    await act(async () => button.click());
    expect(save).toHaveBeenCalledWith(results[0]);
    expect(select).not.toHaveBeenCalled();
    await act(async () => root.render(<QuickSearchResultList {...props} snippetFavoriteIds={new Set([snippetFavoriteKey(results[0])])} />));
    expect(node.querySelector(".grouped-snippet-favorite")?.getAttribute("aria-pressed")).toBe("true");
  } finally { await act(async () => root.unmount()); }
});

it("keeps details in detail mode and hides match labels in compact mode without losing passage targets", async () => {
  const results = hits(3).map(hit => ({ ...hit, modifiedAt: 1769817600 }));
  const node = document.createElement("div"); const root = createRoot(node); const open = vi.fn();
  const props = { query: "历史", results, selectedIndex: -1, renderLibraryIcon: () => null, onSelectResult: () => {}, onOpenResult: open };
  try {
    await act(async () => root.render(<QuickSearchResultList {...props} />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(2);
    expect(node.querySelector(".grouped-page-summary")?.textContent).toContain("3 段正文匹配");
    expect(node.querySelector(".grouped-context-date")?.textContent).toContain("2026年1月31日");
    await act(async () => root.render(<QuickSearchResultList {...props} compact />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(1);
    expect(node.querySelector(".grouped-page-summary")).toBeNull();
    expect(node.querySelector(".grouped-page-evidence")).toBeNull();
    expect(node.querySelector(".grouped-context-date")?.textContent).toContain("2026年1月31日");
    await act(async () => node.querySelector<HTMLButtonElement>(".grouped-excerpt-toggle")!.click());
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(3);
    await act(async () => node.querySelectorAll(".quick-craft-result-block")[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(open).toHaveBeenCalledWith(results[2]);
  } finally { await act(async () => root.unmount()); }
});

it("groups by source identity, keeps library icons, and opens the exact selected passage", async () => {
  const results = hits(3); results[2] = { ...results[2], provider: "obsidian", libraryId: "vault", libraryName: "Vault", documentId: "other" };
  const node = document.createElement("div"); const root = createRoot(node); const select = vi.fn(); const open = vi.fn();
  const customIcon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
  const renderIcon = (r: SearchResult, name: string) => <LibraryIcon provider={r.provider} name={name} iconSvg={r.libraryId === "main" ? customIcon : undefined} compact />;
  try {
    await act(async () => root.render(<QuickSearchResultList query="历史" results={results} selectedIndex={1} renderLibraryIcon={renderIcon} onSelectResult={select} onOpenResult={open} />));
    expect(node.querySelectorAll(".quick-craft-result-group")).toHaveLength(2);
    expect(Array.from(node.querySelectorAll(".quick-craft-result-heading img"), icon => icon.getAttribute("src"))).toEqual([customIcon, "/icons/library/obsidian.svg"]);
    const rows = node.querySelectorAll<HTMLButtonElement>(".grouped-search-hit button");
    expect(rows[1].getAttribute("aria-current")).toBe("true");
    expect(node.querySelectorAll(".grouped-search-hit mark")).toHaveLength(3);
    await act(async () => rows[2].click()); expect(select).toHaveBeenCalledWith(2);
    await act(async () => rows[2].dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))); expect(open).toHaveBeenCalledWith(results[2]);
    await act(async () => rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))); expect(open).toHaveBeenLastCalledWith(results[1]);
  } finally { await act(async () => root.unmount()); }
});

it("shows two passages, expands locally, reveals keyboard selection, and safely collapses it", async () => {
  const results = hits(); const node = document.createElement("div"); const root = createRoot(node);
  function View({ query = "历史", initial = -1 }) { const [index, setIndex] = useState(initial); return <QuickSearchResultList query={query} results={results} selectedIndex={index} renderLibraryIcon={() => null} onSelectResult={setIndex} onOpenResult={() => {}} />; }
  try {
    await act(async () => root.render(<View />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(2);
    expect(node.querySelector(".grouped-excerpt-toggle")?.textContent).toContain("其余 2");
    await act(async () => node.querySelector<HTMLButtonElement>(".grouped-excerpt-toggle")!.click());
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(4);
    await act(async () => root.render(<View query="新查询" />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(2);
    await act(async () => root.render(<View key="keyboard" initial={3} />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(4);
    expect(node.querySelector("[aria-current=true]")?.textContent).toContain("片段 3");
    await act(async () => node.querySelector<HTMLButtonElement>(".grouped-excerpt-toggle")!.click());
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(2);
    expect(node.querySelector("[aria-current=true]")?.textContent).toContain("片段 0");
    expect(searchResultSummary(results, "历史")).toBe("1 个页面 · 4 段正文匹配");
  } finally { await act(async () => root.unmount()); }
});

it("renders title/path-only evidence once without leaking unrelated body text", async () => {
  const raw = normalizeQuickSearchResults([0, 1, 2].map(i => ({ id: `a${i}`, documentId: "a", spaceId: "s", title: "使用AI", path: "Main / 使用AI", snippet: "不相关正文及元数据", matchTerms: ["使用AI"], matchField: "title,path" })));
  const results = prepareQuickSearchResults(raw, "使用AI");
  expect(results).toHaveLength(1);
  expect(searchResultSummary(results, "使用AI")).toBe("1 个页面 · 0 段正文匹配");
  const node = document.createElement("div"); const root = createRoot(node); const open = vi.fn();
  try {
    await act(async () => root.render(<QuickSearchResultList query="使用AI" results={results} selectedIndex={0} renderLibraryIcon={() => null} onSelectResult={() => {}} onOpenResult={open} />));
    expect(node.querySelectorAll(".grouped-search-hit")).toHaveLength(0);
    expect(node.textContent).not.toContain("不相关正文");
    expect(node.textContent).toContain("标题匹配"); expect(node.textContent).toContain("路径匹配");
    expect(node.querySelector(".grouped-page-title mark")?.textContent).toBe("使用AI");
    const pageHit = node.querySelector<HTMLButtonElement>(".grouped-page-hit")!;
    expect(pageHit.querySelector(".grouped-page-title")).not.toBeNull();
    expect(pageHit.querySelector(".grouped-page-context")).not.toBeNull();
    await act(async () => pageHit.querySelector(".grouped-page-context")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(open).toHaveBeenCalledWith(results[0]);
  } finally { await act(async () => root.unmount()); }
});

it("keeps context and drag on hits but offers one page favorite in the heading", async () => {
  const results = hits(3); const node = document.createElement("div"); const root = createRoot(node);
  const context = vi.fn(), drag = vi.fn(), favorite = vi.fn(), select = vi.fn(), hover = vi.fn();
  try {
    await act(async () => root.render(<QuickSearchResultList query="历史" results={results} selectedIndex={0} renderLibraryIcon={() => null} onSelectResult={select} onHoverResult={hover} onOpenResult={() => {}} onContextResult={context} onDragResult={drag} onToggleFavorite={favorite} favoriteIds={new Set([pageFavoriteKey(results[0])])} />));
    const row = node.querySelector(".quick-craft-result-block")!;
    await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
    expect(context.mock.calls[0].slice(1)).toEqual([results[0], 0]);
    await act(async () => row.dispatchEvent(new Event("dragstart", { bubbles: true })));
    expect(drag.mock.calls[0][1]).toBe(results[0]);
    await act(async () => row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    expect(hover).not.toHaveBeenCalled();
    await act(async () => node.querySelector<HTMLButtonElement>(".grouped-search-favorite")!.click());
    expect(node.querySelectorAll(".grouped-search-favorite")).toHaveLength(1);
    expect(node.querySelector(".grouped-search-favorite")?.getAttribute("aria-pressed")).toBe("true");
    expect(node.querySelector(".quick-craft-result-heading .grouped-search-favorite")).not.toBeNull();
    expect(node.querySelector(".grouped-page-passages .grouped-search-favorite")).toBeNull();
    expect(favorite).toHaveBeenCalledWith(results[0]); expect(select).not.toHaveBeenCalled();
  } finally { await act(async () => root.unmount()); }
});

it("keeps late match evidence in a short excerpt and identifies OCR and attachment pages", async () => {
  const results = hits(2); results[0] = { ...results[0], snippet: "背景".repeat(140) + "历史正文" + "后文".repeat(100) };
  results[1] = { ...results[1], sourceType: "pdf_ocr", sourceTitle: "材料.pdf", pageNumber: 7 };
  const node = document.createElement("div"); const root = createRoot(node);
  try {
    await act(async () => root.render(<QuickSearchResultList query="历史" results={results} selectedIndex={0} renderLibraryIcon={() => null} onSelectResult={() => {}} onOpenResult={() => {}} />));
    const rows = node.querySelectorAll(".quick-craft-result-block");
    expect(rows[0].querySelector(".grouped-passage-excerpt")).not.toBeNull();
    expect(rows[0].textContent!.indexOf("历史")).toBeLessThanOrEqual(9);
    expect(rows[0].querySelector("mark")?.textContent).toBe("历史");
    expect(rows[1].textContent).toContain("识别文字 · 材料.pdf · 第 7 页");
  } finally { await act(async () => root.unmount()); }
});
