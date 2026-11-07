// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { SearchInputArea } from "./SearchInputArea";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });

it("keeps IME composition text out of the committed search query", async () => {
  let committedQuery = "";
  let composing = false;
  function Sample() {
    const [query, setQuery] = useState("");
    const [isComposing, setIsComposing] = useState(false);
    const input = useRef<HTMLInputElement>(null);
    committedQuery = query;
    composing = isComposing;
    return <SearchInputArea
      hasSpaces isMobileLayout={false} isComposing={isComposing} query={query} searchFocused={false}
      searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={input}
      suggestions={[]} syntaxHints={[]} filterSummary="" clearSearchHistory={() => {}} openSelectedResult={() => {}}
      rememberQuery={() => {}} removeSearchHistoryItem={() => {}} onApplySuggestion={() => {}}
      setIsComposing={setIsComposing} setQuery={setQuery} setSearchFocused={() => {}}
    />;
  }
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Sample />));
  const input = host.querySelector("input")!;
  const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

  await act(async () => input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await act(async () => {
    setNativeValue.call(input, "ni");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "ni", inputType: "insertText", isComposing: true }));
  });
  expect(composing).toBe(true);
  expect(input.value).toBe("ni");
  expect(committedQuery).toBe("");

  await act(async () => {
    setNativeValue.call(input, "你");
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
  });
  expect(composing).toBe(false);
  expect(committedQuery).toBe("你");
});

it("clears immediately from the fixed clear control, including active IME text", async () => {
  let committedQuery = "测试";
  let composing = true;
  function Sample() {
    const [query, setQuery] = useState("测试");
    const [isComposing, setIsComposing] = useState(true);
    const input = useRef<HTMLInputElement>(null);
    committedQuery = query;
    composing = isComposing;
    return <SearchInputArea
      hasSpaces isMobileLayout={false} isComposing={isComposing} query={query} searchFocused
      searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={input}
      suggestions={[]} syntaxHints={[]} filterSummary="" clearSearchHistory={() => {}} openSelectedResult={() => {}}
      rememberQuery={() => {}} removeSearchHistoryItem={() => {}} onApplySuggestion={() => {}}
      setIsComposing={setIsComposing} setQuery={setQuery} setSearchFocused={() => {}}
    />;
  }
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Sample />));
  const clear = host.querySelector<HTMLButtonElement>(".search-clear")!;
  await act(async () => clear.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
  expect(committedQuery).toBe("");
  expect(composing).toBe(false);
  expect(host.querySelector<HTMLInputElement>("input")!.value).toBe("");
  expect(host.querySelector(".search-clear")).toBeNull();
});

it("clears the focused search with Escape without moving focus", async () => {
  let committedQuery = "上班";
  function Sample() {
    const [query, setQuery] = useState("上班");
    const input = useRef<HTMLInputElement>(null);
    committedQuery = query;
    return <SearchInputArea
      hasSpaces isMobileLayout={false} isComposing={false} query={query} searchFocused
      searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={input}
      suggestions={[]} syntaxHints={[]} filterSummary="" clearSearchHistory={() => {}} openSelectedResult={() => {}}
      rememberQuery={() => {}} removeSearchHistoryItem={() => {}} onApplySuggestion={() => {}}
      setIsComposing={() => {}} setQuery={setQuery} setSearchFocused={() => {}}
    />;
  }
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Sample />));
  const input = host.querySelector<HTMLInputElement>("input")!;
  input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(committedQuery).toBe("");
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
});


it.each([true, false])("handles Enter using the current platform (mobile=%s)", async (mobile) => {
  const open = vi.fn();
  const remember = vi.fn();
  function Sample() {
    const input = useRef<HTMLInputElement>(null);
    return <SearchInputArea hasSpaces isMobileLayout={mobile} isComposing={false} query="测试" searchFocused
      searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled={false} searchInput={input}
      suggestions={[]} syntaxHints={[]} filterSummary="" selected="selected-document"
      clearSearchHistory={vi.fn()} openSelectedResult={open} rememberQuery={remember}
      removeSearchHistoryItem={vi.fn()} onApplySuggestion={vi.fn()} setIsComposing={vi.fn()}
      setQuery={vi.fn()} setSearchFocused={vi.fn()} />;
  }
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Sample />));
  const input = host.querySelector("input")!;
  input.focus();
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  expect(remember).toHaveBeenCalledWith("测试");
  expect(document.activeElement).not.toBe(input);
  expect(open).toHaveBeenCalledTimes(mobile ? 0 : 1);
  if (mobile) expect(input.getAttribute("enterkeyhint")).toBe("search");
});

it("does not refocus the keyboard after tapping a search suggestion", async () => {
  const apply = vi.fn();
  function Sample() {
    const input = useRef<HTMLInputElement>(null);
    return <SearchInputArea hasSpaces isMobileLayout isComposing={false} query="" searchFocused
      searchHistory={[]} searchHistoryEnabled={false} searchSuggestionsEnabled searchInput={input}
      suggestions={[{ id: "item", kind: "title", label: "标题", query: "标题" }]} syntaxHints={[]} filterSummary=""
      clearSearchHistory={vi.fn()} openSelectedResult={vi.fn()} rememberQuery={vi.fn()}
      removeSearchHistoryItem={vi.fn()} onApplySuggestion={apply} setIsComposing={vi.fn()}
      setQuery={vi.fn()} setSearchFocused={vi.fn()} />;
  }
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root.render(<Sample />));
  const input = host.querySelector("input")!;
  input.focus();
  await act(async () => host.querySelector<HTMLButtonElement>('[role="option"]')!.click());
  expect(apply).toHaveBeenCalledOnce();
  expect(document.activeElement).not.toBe(input);
});
