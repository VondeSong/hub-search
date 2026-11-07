// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionPostBody } from "./CollectionPostBody";
import { ReadingArticleTools } from "./ReadingArticleTools";
import { runtimeCapabilities } from "./RuntimePlatform";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let host: HTMLDivElement, root: Root;
let originalState: unknown, originalMobile: boolean;
const button = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const readingRoute = { hubMobileRoute: "collections" };
const readingPreview = { ...readingRoute, hubReadingPreview: true, articleContext: "retained" };
const settleHistory = async () => { await act(async () => vi.advanceTimersByTimeAsync(20)); };
const systemBack = async () => { window.history.back(); await settleHistory(); };
function beginMobilePreview() {
  runtimeCapabilities.mobile = true;
  window.history.replaceState({ hubMobileRoute: "search" }, "");
  window.history.pushState(readingRoute, "");
  window.history.pushState(readingPreview, "");
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  originalState = window.history.state;
  originalMobile = runtimeCapabilities.mobile;
  runtimeCapabilities.mobile = false;
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
    close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new Event("close")); } },
  });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  await settleHistory();
  host.remove();
  window.history.replaceState(originalState, "");
  runtimeCapabilities.mobile = originalMobile;
  vi.restoreAllMocks(); vi.useRealTimers();
});

it("keeps maintenance panels and status polling out of the article until more is opened", async () => {
  const post = { id: "100", text: "正文", authorName: "作者", authorHandle: "reader", publishedAt: "2026-10-08", url: "https://example.invalid/article", quotedText: "", contentStatus: "complete", links: [], media: [] };
  await act(async () => root.render(<><ReadingArticleTools itemKey="article-a" revision="v1" /><CollectionPostBody post={post} itemKey="article-a" open={async () => {}} /></>));
  expect(host.textContent).toContain("正文");
  expect(document.querySelector("dialog")).toBeNull();
  expect(host.querySelector(".reading-attachments")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => button("更多阅读操作").click());
  expect(document.querySelector("dialog")?.open).toBe(true);
  expect(document.querySelector("dialog")?.textContent).toContain("本文离线");
  expect(document.querySelector("dialog")?.textContent).toContain("云端恢复检查");
  expect(host.querySelector(".collection-posts .reading-attachments")).toBeNull();
  expect(invoke).toHaveBeenCalledWith("reading_attachment_status", { key: "article-a" });
  expect(invoke).toHaveBeenCalledWith("reading_copy_status", { key: "article-a" });
  expect(invoke.mock.calls.every(([command]) => ["reading_attachment_status", "reading_copy_status"].includes(command))).toBe(true);
  await act(async () => button("关闭本文管理").click());
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(button("更多阅读操作"));
  invoke.mockClear(); await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(invoke).not.toHaveBeenCalled();
});

it("closes on native cancellation and on changing articles, without retaining the old tools", async () => {
  await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
  await act(async () => button("更多阅读操作").click());
  await act(async () => document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true })));
  expect(document.querySelector("dialog")).toBeNull();
  await act(async () => button("更多阅读操作").click());
  await act(async () => root.render(<ReadingArticleTools itemKey="article-b" revision="v2" />));
  expect(document.querySelector("dialog")).toBeNull();
  expect(button("更多阅读操作").getAttribute("aria-expanded")).toBe("false");
  invoke.mockClear();
  await act(async () => button("更多阅读操作").click());
  expect(invoke).toHaveBeenCalledWith("reading_copy_status", { key: "article-b" });
  expect(invoke.mock.calls.every(([, args]) => args.key === "article-b")).toBe(true);
});

it("consumes the first real mobile Back for tools, then returns from the article on the second Back", async () => {
  beginMobilePreview();
  const articleBack = vi.fn();
  function Preview() {
    const [visible, setVisible] = useState(true);
    useEffect(() => {
      const listener = (event: PopStateEvent) => { articleBack(event.state); if (!event.state?.hubReadingPreview) setVisible(false); };
      window.addEventListener("popstate", listener);
      return () => window.removeEventListener("popstate", listener);
    }, []);
    return visible ? <section aria-label="阅读正文"><ReadingArticleTools itemKey="article-a" revision="v1" /></section> : <p>原阅读列表</p>;
  }
  await act(async () => root.render(<Preview />));
  const length = window.history.length;
  await act(async () => button("更多阅读操作").click());
  expect(window.history.length).toBe(length + 1);
  expect(window.history.state).toMatchObject(readingPreview);
  expect(window.history.state.hubReadingArticleTools).toBeTruthy();
  await systemBack();
  expect(window.history.state).toEqual(readingPreview);
  expect(document.querySelector("dialog")).toBeNull();
  expect(host.querySelector('[aria-label="阅读正文"]')).toBeTruthy();
  expect(document.activeElement).toBe(button("更多阅读操作"));
  expect(articleBack).not.toHaveBeenCalled();
  invoke.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(invoke).not.toHaveBeenCalled();
  await systemBack();
  expect(window.history.state).toEqual(readingRoute);
  expect(host.textContent).toBe("原阅读列表");
  expect(articleBack).toHaveBeenCalledExactlyOnceWith(readingRoute);
});

it.each(["button", "backdrop", "cancel", "native-close"])("consumes the tools history entry when closed by %s, without a ghost Back step", async method => {
  beginMobilePreview();
  const back = vi.spyOn(window.history, "back");
  await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
  await act(async () => button("更多阅读操作").click());
  await act(async () => {
    if (method === "button") button("关闭本文管理").click();
    else if (method === "backdrop") document.querySelector("dialog")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: -1 }));
    else if (method === "native-close") document.querySelector("dialog")!.close();
    else document.querySelector("dialog")!.dispatchEvent(new Event("cancel", { cancelable: true }));
  });
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(button("更多阅读操作"));
  await settleHistory();
  expect(window.history.state).toEqual(readingPreview);
  expect(back).toHaveBeenCalledTimes(1);
  invoke.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(invoke).not.toHaveBeenCalled();
  await systemBack();
  expect(window.history.state).toEqual(readingRoute);
});

it("waits for closing history to settle before allowing another tools session", async () => {
  beginMobilePreview();
  await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
  await act(async () => button("更多阅读操作").click());
  const firstToken = window.history.state.hubReadingArticleTools;
  await act(async () => { button("关闭本文管理").click(); button("更多阅读操作").click(); });
  expect(document.querySelector("dialog")).toBeNull();
  await settleHistory();
  expect(window.history.state).toEqual(readingPreview);
  await act(async () => button("更多阅读操作").click());
  expect(window.history.state.hubReadingArticleTools).toBeTruthy();
  expect(window.history.state.hubReadingArticleTools).not.toBe(firstToken);
  await systemBack();
  expect(window.history.state).toEqual(readingPreview);
  expect(document.querySelector("dialog")).toBeNull();
});

it("releases only the previous article's tools entry on replacement and stops its polling and focus restoration", async () => {
  beginMobilePreview();
  const back = vi.spyOn(window.history, "back");
  await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
  const oldTrigger = button("更多阅读操作");
  await act(async () => oldTrigger.click());
  await act(async () => root.render(<ReadingArticleTools itemKey="article-b" revision="v2" />));
  await settleHistory();
  expect(back).toHaveBeenCalledTimes(1);
  expect(window.history.state).toEqual(readingPreview);
  expect(document.querySelector("dialog")).toBeNull();
  expect(oldTrigger.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(oldTrigger);
  expect(document.activeElement).not.toBe(button("更多阅读操作"));
  invoke.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(invoke).not.toHaveBeenCalled();
  await act(async () => button("更多阅读操作").click());
  expect(invoke.mock.calls.every(([, args]) => args.key === "article-b")).toBe(true);
  await systemBack();
  expect(document.activeElement).toBe(button("更多阅读操作"));
  expect(window.history.state).toEqual(readingPreview);
});

it("does not navigate or restore focus after a module replaces the route and unmounts tools", async () => {
  beginMobilePreview();
  const back = vi.spyOn(window.history, "back");
  await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
  await act(async () => button("更多阅读操作").click());
  const oldTrigger = button("更多阅读操作");
  const nextRoute = { hubMobileRoute: "tasks" };
  window.history.replaceState(nextRoute, "");
  await act(async () => root.render(<button aria-label="新模块按钮">任务</button>));
  button("新模块按钮").focus();
  await settleHistory();
  expect(window.history.state).toEqual(nextRoute);
  expect(back).not.toHaveBeenCalled();
  expect(document.querySelector("dialog")).toBeNull();
  expect(oldTrigger.isConnected).toBe(false);
  expect(document.activeElement).toBe(button("新模块按钮"));
  invoke.mockClear();
  await act(async () => vi.advanceTimersByTimeAsync(15000));
  expect(invoke).not.toHaveBeenCalled();
});

it("leaves nested history and multi-step navigation to their owners", async () => {
  beginMobilePreview();
  const otherBack = vi.fn();
  window.addEventListener("popstate", otherBack);
  try {
    await act(async () => root.render(<ReadingArticleTools itemKey="article-a" revision="v1" />));
    await act(async () => button("更多阅读操作").click());
    const toolsState = window.history.state;
    window.history.pushState({ ...toolsState, hubSettings: true }, "");
    await systemBack();
    expect(window.history.state).toEqual(toolsState);
    expect(document.querySelector("dialog")?.open).toBe(true);
    expect(otherBack).toHaveBeenCalledTimes(1);
    window.history.go(-2); await settleHistory();
    expect(window.history.state).toEqual(readingRoute);
    expect(document.querySelector("dialog")).toBeNull();
    expect(otherBack).toHaveBeenCalledTimes(2);
  } finally { window.removeEventListener("popstate", otherBack); }
});
