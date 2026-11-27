// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionsWorkspace } from "./CollectionsWorkspace";
import { CollectionViewsProvider, useCollectionViews, type CollectionViewsContextValue } from "./CollectionViews";
import { clearOperationStatus } from "./useOperationStatus";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("./AgentInvestigation", () => ({ ReadingInvestigation: () => <button type="button">询问助手</button> }));

const item = { key: "x:loading-test", collectedAt: 1791763200000, read: false, status: "unread", lifecycle: "active", tags: [], post: { id: "loading-test", text: "读取完成的本地正文", authorName: "本地作者", authorHandle: "fixture", publishedAt: "2026-10-12", url: "https://x.com/fixture/status/loading-test", links: [], media: [], quotedText: "", source: "bookmarks" } };
const page = { items: [item], total: 814, unread: 814, matched: 814, connected: true, running: false, canResume: false, status: "", sources: [{ id: "bookmarks", count: 753, connected: true, canResume: false, status: "" }, { id: "likes", count: 19, connected: true, canResume: false, status: "" }, { id: "telegram", count: 2, connected: true, canResume: false, status: "" }, { id: "dida", count: 40, connected: true, canResume: false, status: "" }] };
const storage = { config: { mode: "database", vaultPath: "", downloadMedia: true, autoSyncMinutes: 30 }, running: false, status: "" };
function pending<T = unknown>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

let container: HTMLDivElement, root: Root, model: CollectionViewsContextValue;
function Probe() { model = useCollectionViews(); return null; }
function Route() { const [reading, setReading] = useState(true); return <><Probe /><button onClick={() => setReading(!reading)}>{reading ? "离开阅读" : "回到阅读"}</button>{reading && <CollectionsWorkspace />}</>; }
async function mount() { await act(async () => root.render(<CollectionViewsProvider><Route /></CollectionViewsProvider>)); await act(async () => vi.advanceTimersByTimeAsync(160)); }
async function click(label: string) { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(value => value.textContent === label || value.getAttribute("aria-label") === label); expect(button).toBeTruthy(); await act(async () => button!.click()); }
const row = () => container.querySelector<HTMLElement>(".collection-row");

beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); clearOperationStatus();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  invoke.mockReset(); invoke.mockImplementation(async command => command === "list_collection_items" ? page : command === "get_collection_storage" ? storage : []);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); invoke.mockReset(); });

it("shows local rows and source counts before slow storage, library and copy status finish", async () => {
  const status = pending();
  invoke.mockImplementation(command => command === "list_collection_items" ? Promise.resolve(page) : status.promise);
  await mount();
  expect(row()?.textContent).toContain(item.post.text);
  expect(container.querySelector(".collections-empty")).toBeNull();
  expect(container.querySelector(".collection-chip-bookmarks strong")?.textContent).toBe("753");
  expect(container.querySelector(".task-source-chip strong")?.textContent).toBe("814");
  // A new filter still starts its own page read while auxiliary status is slow.
  await act(async () => model.updateView({ source: "telegram" }));
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(invoke).toHaveBeenCalledWith("list_collection_items", expect.objectContaining({ source: "telegram" }));
  expect(invoke.mock.calls.filter(([command]) => command === "get_collection_storage")).toHaveLength(1);
  await act(async () => status.resolve([]));
});

it("restores the same reading page and scroll position immediately, then accepts the fresh local read", async () => {
  await mount();
  const database = container.querySelector<HTMLElement>(".collection-database")!;
  database.scrollTop = 280; await act(async () => database.dispatchEvent(new Event("scroll", { bubbles: true })));
  await click("离开阅读");
  const fresh = pending();
  invoke.mockImplementation(command => command === "list_collection_items" ? fresh.promise : Promise.resolve(command === "get_collection_storage" ? storage : []));
  await click("回到阅读");
  expect(row()?.textContent).toContain(item.post.text);
  expect(container.querySelector(".collection-chip-bookmarks strong")?.textContent).toBe("753");
  expect(container.querySelector<HTMLElement>(".collection-database")?.scrollTop).toBe(280);
  expect(container.querySelector(".collections-empty")).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(160));
  await act(async () => fresh.resolve({ ...page, items: [{ ...item, post: { ...item.post, text: "后台校验后的最新正文" } }] }));
  expect(row()?.textContent).toContain("后台校验后的最新正文");
});

it.each([
  ["source", () => model.updateView({ source: "telegram" })],
  ["query", () => model.updateView({ query: "新的搜索" })],
  ["tags", () => model.updateView({ tags: ["新的标签"] })],
  ["status", () => model.updateView({ status: "read" })],
  ["media", () => model.updateView({ media: "photo" })],
  ["destination", () => model.updateView({ destinationId: "another-library" })],
  ["date", () => model.updateView({ dateFilter: "7" })],
  ["board inclusion", () => model.selectLayout("board")],
  ["sorting", () => model.updateView({ sorts: [{ id: "sort-author", field: "author", ascending: true }] })],
  ["paging", () => model.updateSession({ offset: 60 })],
] as const)("does not reuse retained rows after changing %s while reading is unmounted", async (_name, change) => {
  await mount(); await click("离开阅读");
  invoke.mockImplementation(command => command === "list_collection_items" ? pending().promise : Promise.resolve(command === "get_collection_storage" ? storage : []));
  await act(async () => change()); await click("回到阅读");
  expect(row()).toBeNull();
  expect(container.querySelector(".collections-empty")?.textContent).toContain("正在读取本地阅读内容");
});

it.each(["read", "archive", "delete", "refresh"])("does not resurrect old retained rows after a successful %s while an old poll is in flight", async action => {
  await mount();
  const oldPoll = pending(), newest = pending(); let reads = 0;
  invoke.mockImplementation(command => {
    if (command === "list_collection_items") return ++reads === 1 ? oldPoll.promise : newest.promise;
    return Promise.resolve(command === "get_collection_storage" ? storage : command === "set_collection_lifecycle" || command === "refresh_collection_content" ? "已保存" : []);
  });
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  if (action === "read") await click(`标为已读：${item.post.text}`);
  else {
    await act(async () => row()!.click());
    if (action === "refresh") await click("更新内容");
    else {
      await click("阅读状态"); await click(action === "archive" ? "归档" : "删除");
      if (action === "delete") await click("删除页面和附件");
    }
  }
  expect(invoke.mock.calls.some(([command]) => command === (action === "read" ? "set_collection_read" : action === "refresh" ? "refresh_collection_content" : "set_collection_lifecycle"))).toBe(true);
  await act(async () => oldPoll.resolve(page));
  await click("离开阅读"); await click("回到阅读");
  expect(row()).toBeNull();
  expect(container.querySelector(".collections-empty")).toBeTruthy();
  await act(async () => vi.advanceTimersByTimeAsync(160));
  await act(async () => newest.resolve({ ...page, items: [], total: 0, matched: 0 }));
  expect(row()).toBeNull();
});

it("releases the retained page when its navigation provider is replaced", async () => {
  await mount();
  invoke.mockImplementation(command => command === "list_collection_items" ? pending().promise : Promise.resolve(command === "get_collection_storage" ? storage : []));
  await act(async () => root.render(<CollectionViewsProvider key="new-session"><Route /></CollectionViewsProvider>));
  expect(row()).toBeNull();
  expect(container.querySelector(".collections-empty")).toBeTruthy();
});

it("refreshes the current query when an earlier query's pending lifecycle write finishes", async () => {
  await mount(); const saved = pending();
  const telegram = { ...item, key: "telegram:current", post: { ...item.post, source: "telegram", text: "当前 Telegram 阅读内容" } };
  invoke.mockImplementation((command, args) => command === "set_collection_lifecycle" ? saved.promise : Promise.resolve(command === "list_collection_items" ? { ...page, items: args.source === "telegram" ? [telegram] : [item] } : command === "get_collection_storage" ? storage : []));
  await act(async () => row()!.click()); await click("阅读状态"); await click("归档");
  await act(async () => model.updateView({ source: "telegram" }));
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(row()?.textContent).toContain(telegram.post.text);
  await act(async () => saved.resolve("已归档"));
  expect(row()?.textContent).toContain(telegram.post.text);
  expect(invoke.mock.calls.filter(([command]) => command === "list_collection_items").map(([, args]) => args.source)).toEqual(["all", "telegram", "telegram"]);
});

it("rejects a new owner's pre-write read when an unmounted owner's pending write finishes", async () => {
  await mount(); const saved = pending(), oldRead = pending(), newest = pending(); let reads = 0;
  invoke.mockImplementation(command => command === "set_collection_lifecycle" ? saved.promise : command === "list_collection_items" ? (++reads === 1 ? oldRead.promise : newest.promise) : Promise.resolve(command === "get_collection_storage" ? storage : []));
  await act(async () => row()!.click()); await click("阅读状态"); await click("归档");
  await click("离开阅读"); await click("回到阅读");
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(reads).toBe(1);
  await act(async () => saved.resolve("已归档"));
  expect(reads).toBe(1); // The unmounted owner cannot restart its old query.
  await act(async () => oldRead.resolve(page));
  await click("离开阅读"); await click("回到阅读");
  expect(row()).toBeNull(); // The other owner's old read cannot repopulate the cache.
  await act(async () => vi.advanceTimersByTimeAsync(160));
  await act(async () => newest.resolve({ ...page, items: [], total: 0, matched: 0 }));
  expect(row()).toBeNull();
});

it("invalidates the retained page when cloud or recovery changes local reading data while it is closed", async () => {
  await mount(); await click("离开阅读");
  await act(async () => window.dispatchEvent(new Event("hub:reading-data-changed")));
  invoke.mockImplementation(command => command === "list_collection_items" ? pending().promise : Promise.resolve(command === "get_collection_storage" ? storage : []));
  await click("回到阅读"); expect(row()).toBeNull();
  expect(container.querySelector(".collections-empty")).toBeTruthy();
});
