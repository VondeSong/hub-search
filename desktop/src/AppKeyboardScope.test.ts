// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { canHandleSearchWorkspaceKeyboard, isInsideKeyboardDialog } from "./AppKeyboardScope";

afterEach(() => { document.body.replaceChildren(); });

function captureSearch(workspaceActive: boolean, searchAction: (event: KeyboardEvent) => void) {
  const listener = (event: KeyboardEvent) => {
    if (!canHandleSearchWorkspaceKeyboard(event, workspaceActive)) return;
    event.preventDefault();
    searchAction(event);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

function press(target: EventTarget, key: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

describe("search workspace capture scope", () => {
  it.each(["Enter", "ArrowDown", "PageUp", "Home", "End", "F12", "x"])("does not act on cached search selection outside search: %s", key => {
    const openCachedResult = vi.fn();
    const remove = captureSearch(false, openCachedResult);
    try {
      expect(press(document.body, key).defaultPrevented).toBe(false);
      expect(openCachedResult).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it("keeps search result navigation available on the active workspace background", () => {
    const navigateSearch = vi.fn();
    const remove = captureSearch(true, navigateSearch);
    try {
      expect(press(document.body, "ArrowDown").defaultPrevented).toBe(true);
      expect(navigateSearch).toHaveBeenCalledTimes(1);
    } finally { remove(); }
  });

  it.each([
    '<button aria-label="更多阅读操作"><svg><path /></svg></button>',
    '<a href="https://fixture.invalid">原文</a>',
    '<details><summary>附件云副本</summary></details>',
    '<select><option>列表</option></select>',
    '<input aria-label="搜索阅读内容">',
    '<textarea></textarea>',
    '<div contenteditable=""><span>正文</span></div>',
    '<article role="button" tabindex="0">阅读卡片</article>',
    '<div role="separator" tabindex="0">调整宽度</div>',
  ])("lets focused controls receive native Enter and navigation: %s", html => {
    document.body.innerHTML = html;
    const target = document.body.querySelector("path, span, summary, select, input, textarea, article, [role=separator]") || document.body.firstElementChild!;
    const ownAction = vi.fn();
    target.addEventListener("keydown", ownAction);
    const openCachedResult = vi.fn();
    const remove = captureSearch(true, openCachedResult);
    try {
      for (const key of ["Enter", " ", "ArrowDown", "Home"]) expect(press(target, key).defaultPrevented).toBe(false);
      expect(ownAction).toHaveBeenCalledTimes(4);
      expect(openCachedResult).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it("leaves the search input Enter to its own submit handler", () => {
    document.body.innerHTML = '<input aria-label="搜索">';
    const input = document.querySelector("input")!;
    const submitSearch = vi.fn();
    input.addEventListener("keydown", event => { if (event.key === "Enter") submitSearch(); });
    const openCachedResult = vi.fn();
    const remove = captureSearch(true, openCachedResult);
    try {
      expect(press(input, "Enter").defaultPrevented).toBe(false);
      expect(submitSearch).toHaveBeenCalledTimes(1);
      expect(openCachedResult).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it("keeps explicit preview shortcuts available while the search input owns focus", () => {
    document.body.innerHTML = '<input aria-label="搜索">';
    const input = document.querySelector("input")!;
    const previewAction = vi.fn();
    const remove = captureSearch(true, previewAction);
    try {
      expect(press(input, "F12").defaultPrevented).toBe(true);
      expect(press(input, "ArrowLeft", { altKey: true }).defaultPrevented).toBe(true);
      expect(press(input, "p", { altKey: true }).defaultPrevented).toBe(true);
      expect(previewAction).toHaveBeenCalledTimes(3);
    } finally { remove(); }
  });

  it("does not open search results from an open dialog body", () => {
    document.body.innerHTML = '<dialog open><p tabindex="0">本文管理</p></dialog>';
    const target = document.querySelector("p")!;
    expect(isInsideKeyboardDialog(target)).toBe(true);
    const searchAction = vi.fn();
    const remove = captureSearch(true, searchAction);
    try {
      expect(press(target, "Enter").defaultPrevented).toBe(false);
      expect(searchAction).not.toHaveBeenCalled();
    } finally { remove(); }
  });

  it.each(['<dialog open><button>关闭</button></dialog>', '<div role="dialog"><input></div>', '<section role="alertdialog"><p>确认</p></section>'])("yields Escape to the dialog that owns focus: %s", html => {
    document.body.innerHTML = html;
    const target = document.body.firstElementChild!.firstElementChild!;
    expect(isInsideKeyboardDialog(target)).toBe(true);
    expect(isInsideKeyboardDialog(document.body)).toBe(html.startsWith('<dialog'));
  });

  it("does not consume composition or events already handled by another owner", () => {
    const composing = new KeyboardEvent("keydown", { key: "Enter", isComposing: true });
    expect(canHandleSearchWorkspaceKeyboard(composing, true)).toBe(false);
    const handled = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    handled.preventDefault();
    expect(canHandleSearchWorkspaceKeyboard(handled, true)).toBe(false);
  });

  it.each(['<textarea></textarea>', '<p tabindex="0">调查结论</p>', '<button>关闭助手</button>'])("leaves Escape and result navigation to an assistant panel: %s", content => {
    document.body.innerHTML = `<aside data-hub-keyboard-scope="assistant">${content}</aside>`;
    const panel = document.querySelector("aside")!;
    const target = panel.firstElementChild!;
    const panelKeys = vi.fn();
    panel.addEventListener("keydown", panelKeys);
    const searchAction = vi.fn();
    const remove = captureSearch(true, searchAction);
    try {
      expect(isInsideKeyboardDialog(target)).toBe(true);
      for (const key of ["Escape", "ArrowDown", "Enter", "F12"]) expect(press(target, key).defaultPrevented).toBe(false);
      expect(panelKeys).toHaveBeenCalledTimes(4);
      expect(searchAction).not.toHaveBeenCalled();
      panel.hidden = true;
      expect(isInsideKeyboardDialog(target)).toBe(false);
    } finally { remove(); }
  });
});
