// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { DEFAULT_APP_SETTINGS } from "./AppSettings";
import { runtimeCapabilities } from "./RuntimePlatform";
const { invokeMock, listenMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), listenMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onMoved: async () => () => {}, onResized: async () => () => {}, onFocusChanged: async () => () => {}, isVisible: async () => true, isMinimized: async () => false, outerPosition: async () => ({ x: 0, y: 0 }), outerSize: async () => ({ width: 1000, height: 700 }), startDragging: async () => {} }) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
vi.mock("./FlashcardsWorkspace", () => ({ FlashcardsWorkspace: () => <div data-testid="paused-review">暂停的复习</div> }));
vi.mock("./CloudAgents", () => ({ default: ({ onClose }: { onClose: () => void }) => <div data-testid="cloud-agents">云端对话<button onClick={onClose} aria-label="关闭云端 Agents">关闭</button></div> }));
vi.mock("./TaskWorkspace", () => ({ TaskWorkspace: () => <div data-testid="tasks">任务</div> }));
vi.mock("./CollectionsWorkspace", () => ({ CollectionsWorkspace: ({ initialItemKey, onSearchTargetHandled }: { initialItemKey?: string; onSearchTargetHandled?: () => void }) => {
  const [target, setTarget] = useState(initialItemKey);
  useEffect(() => { if (initialItemKey) { setTarget(initialItemKey); onSearchTargetHandled?.(); } }, [initialItemKey, onSearchTargetHandled]);
  return <div data-testid="reading-search-target">{target}</div>;
} }));
import App from "./App";

const libraries: LibrarySummary[] = ["Alpha", "Beta"].map((name, index) => ({ id: String(index), name, provider: "craft", connected: false, documentCount: 2, excludedPaths: [] }));
const result: SearchResult = { id: "doc", entityKey: "doc", documentId: "doc", contentType: "document", sourceType: "craft_page", provider: "craft", libraryId: "1", libraryName: "Beta", spaceId: "1", spaceName: "Beta", title: "Local page", documentTitle: "Local page", path: "", snippet: "Local body", matchTerms: [], matchField: "", matchCount: 0, subMatches: [] };
let root: Root, host: HTMLDivElement;
const advance = async (time: number) => act(async () => { await vi.advanceTimersByTimeAsync(time); });
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); vi.useFakeTimers(); invokeMock.mockReset(); listenMock.mockReset(); listenMock.mockResolvedValue(() => {});
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Element.prototype.scrollIntoView = vi.fn();
  localStorage.setItem("craft-search-filters-v1", '{"libraryIds":["1"]}');
  invokeMock.mockImplementation(async command => {
    if (command === "list_libraries") return libraries;
    if (command === "get_settings") return DEFAULT_APP_SETTINGS;
    if (command === "index_status") return { journalVersions: [], documentCount: 4, pendingJobs: 0, pendingDownloads: 0, pendingOcrPages: 0, pendingOtherJobs: 0, deferredOcrSources: 0, failedJobs: 0, failedOcrPages: 0, pendingLexicalJobs: 0, rateLimitEvents: 0, autoSyncEnabled: false, autoSyncConsecutiveFailures: 0, jobDetails: [], libraryHealth: [], obsidianWatchers: [] };
    if (command === "library_control") return { libraries: [] };
    if (command === "get_window_visibility") return { visible: true, minimized: false, foreground: true, revision: "1" };
    if (command === "journal_summary") return { count: 0, dates: [] };
    if (command === "recent_documents" || command === "local_search") return [result];
    if (command === "list_folders" || command === "list_tags") return [];
    if (command === "get_flashcard_dashboard_stats") return { dueCards: 0, newCards: 0, newDueCards: 0, newStudiedToday: 0 };
    if (command === "get_flashcard_study_settings") return { dailyNewLimit: 10 };
    if (command === "dynamic_search_facets") return { total: 4, truncated: false, sources: {}, libraries: {}, folders: {}, tags: {} };
    if (command === "get_isolated_runtime_status") return { enabled: false };
    if (command === "tag_assignment") return { count: 0, hasMore: false, items: [] };
    if (command === "restore_connections") return undefined;
    throw new Error(`Unexpected native command: ${command}`);
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });

it.each(["standalone", "sidebar"].flatMap(origin => ["助手", "搜索", "浏览", "任务"].map(destination => [origin, destination])))("leaves %s review when the mobile navigation opens %s", async (origin, destination) => {
  const original = { ...runtimeCapabilities };
  Object.assign(runtimeCapabilities, { mobile: origin === "standalone", desktop: origin !== "standalone" });
  if (origin === "sidebar") localStorage.setItem("hub-desktop-sidebar-enabled-v1", "true");
  window.history.replaceState({ hubMobileRoute: "search" }, "");
  const navigate = async (label: string) => {
    const button = host.querySelector<HTMLButtonElement>(`nav[aria-label="主要导航"] button[aria-label="${label}"]`)!;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    await advance(400);
  };
  try {
    await act(async () => root.render(<App />)); await advance(400);
    if (origin === "standalone") {
      await navigate("复习");
      expect(window.history.state.hubFlashcards).toBe(true);
    } else {
      const review = [...host.querySelectorAll<HTMLButtonElement>('nav[aria-label="浏览视图"] button')].find(button => button.textContent?.includes("闪卡复习"))!;
      expect(review).toBeTruthy();
      await act(async () => review.click()); await advance(400);
      Object.assign(runtimeCapabilities, { mobile: true, desktop: false });
      await act(async () => root.render(<App />)); await advance(400);
    }
    expect(host.querySelector('[data-testid="paused-review"]')).not.toBeNull();
    await navigate(destination);
    expect(host.querySelector('[data-testid="paused-review"]')).toBeNull();
    expect(window.history.state.hubFlashcards).not.toBe(true);
    if (destination === "助手") expect(host.querySelector('[data-testid="cloud-agents"]')).not.toBeNull();
    await navigate("复习");
    expect(host.querySelector('[data-testid="paused-review"]')).not.toBeNull();
    await act(async () => window.history.back()); await advance(100);
    expect(host.querySelector('[data-testid="paused-review"]')).toBeNull();
  } finally {
    Object.assign(runtimeCapabilities, original);
  }
});

it.each(["revisited-agents", "expanded-search"])("closes the Agents page explicitly after %s", async scenario => {
  const original = { ...runtimeCapabilities };
  Object.assign(runtimeCapabilities, { mobile: true, desktop: false });
  window.history.replaceState({ hubMobileRoute: "search" }, "");
  const navigate = async (label: string) => {
    const button = host.querySelector<HTMLButtonElement>(`nav[aria-label="主要导航"] button[aria-label="${label}"]`)!;
    expect(button).toBeTruthy();
    await act(async () => button.click()); await advance(400);
  };
  try {
    await act(async () => root.render(<App />)); await advance(400);
    if (scenario === "expanded-search") await navigate("搜索");
    await navigate("助手");
    if (scenario === "revisited-agents") { await navigate("复习"); await navigate("助手"); }
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="关闭云端 Agents"]')!;
    expect(close).toBeTruthy();
    await act(async () => close.click()); await advance(400);
    expect(host.querySelector('[data-testid="cloud-agents"]')).toBeNull();
    expect(host.querySelector('[data-testid="paused-review"]')).toBeNull();
    expect(window.history.state.hubMobileRoute).toBe("search");
    expect(window.history.state.hubMobileSearch).not.toBe(true);
    expect(host.querySelector('nav[aria-label="主要导航"] button[aria-label="搜索"][aria-current="page"]')).not.toBeNull();
  } finally { Object.assign(runtimeCapabilities, original); }
});

it("keeps the original reading module open after opening a nonempty search result",async()=>{
 const original=invokeMock.getMockImplementation()!;
 const reading={...result,id:"reading:exact:v1",entityKey:"reading:exact",documentId:"exact",provider:"hub",contentType:"reading",sourceType:"reading",title:"Reading target",documentTitle:"Reading target"};
 invokeMock.mockImplementation((command,args)=>command==="local_search"?Promise.resolve([reading]):command==="module_search_document"?Promise.resolve("Reading body"):original(command,args));
 await act(async()=>root.render(<App/>));await advance(400);
 const input=host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"needle");input.dispatchEvent(new Event("input",{bubbles:true}));});await advance(300);
 const target=[...host.querySelectorAll('button')].find(b=>b.textContent?.includes("Reading target"))!;expect(target).toBeTruthy();
 await act(async()=>target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));await advance(400);
 expect(invokeMock).toHaveBeenCalledWith("module_search_document",{kind:"reading",id:"exact"});
 expect(host.querySelector('[data-testid="reading-search-target"]')?.textContent).toBe("exact");
});

it("restores the original main-search query and scope when returning from a reading result with Ctrl+F", async () => {
  const original = invokeMock.getMockImplementation()!;
  const reading = { ...result, id: "reading:exact:v1", entityKey: "reading:exact", documentId: "exact", provider: "hub", contentType: "reading", sourceType: "reading", title: "Reading target", documentTitle: "Reading target" };
  invokeMock.mockImplementation((command, args) => command === "local_search" ? Promise.resolve([reading]) : command === "module_search_document" ? Promise.resolve("Reading body") : original(command, args));
  await act(async () => root.render(<App />)); await advance(400);
  const input = host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "kept reading query");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }); await advance(300);
  const target = [...host.querySelectorAll("button")].find(button => button.textContent?.includes("Reading target"))!;
  await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))); await advance(400);
  expect(host.querySelector('[data-testid="reading-search-target"]')?.textContent).toBe("exact");
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true }))); await advance(400);
  expect(host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]')?.value).toBe("kept reading query");
  expect(host.textContent).toContain("Reading target");
  const searches = invokeMock.mock.calls.filter(([command]) => command === "local_search");
  expect(searches[searches.length - 1]?.[1]).toEqual(expect.objectContaining({ query: "kept reading query", spaceIds: ["1"] }));
});

it("renders the selected local library and owned result data while remote restoration is still pending", async () => {
  const original = invokeMock.getMockImplementation()!;
  invokeMock.mockImplementation((command, args) => command === "restore_connections" ? new Promise(() => {}) : original(command, args));
  await act(async () => root.render(<App />)); await advance(400);
  expect(host.textContent).toContain("Beta"); expect(host.textContent).toContain("Local page");
  expect(invokeMock.mock.calls.filter(call => call[0] === "list_libraries")).toHaveLength(1);
  expect(invokeMock).toHaveBeenCalledWith("recent_documents", expect.objectContaining({ spaceIds: ["1"] }));
  expect(invokeMock.mock.calls.some(call => ["sync_library", "start_library_sync", "local_search"].includes(call[0]))).toBe(false);
  expect(JSON.parse(localStorage.getItem("craft-search-filters-v1")!).libraryIds).toEqual(["1"]);
});
it("passes an actual search input through the same restored scope and renders the owned response", async () => {
  await act(async () => root.render(<App />)); await advance(400);
  const input = host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]');
  expect(input).not.toBeNull();
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "needle"); input!.dispatchEvent(new Event("input", { bubbles: true })); });
  await advance(300);
  expect(invokeMock).toHaveBeenCalledWith("local_search", expect.objectContaining({ query: "needle", spaceIds: ["1"] }));
  expect(host.textContent).toContain("Local page");
  expect(invokeMock.mock.calls.filter(call => call[0] === "get_settings")).toHaveLength(1);
});

it("lets an open assistant handle Escape before clearing search or hiding Hub", async () => {
  await act(async () => root.render(<App />)); await advance(400);
  const panel = document.createElement("aside"); panel.className = "agent-panel"; host.append(panel);
  const input = host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "保留搜索词"); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => input.focus());
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => host.dispatchEvent(escape));
  expect(escape.defaultPrevented).toBe(false);
  expect(input.value).toBe("保留搜索词");
  expect(invokeMock.mock.calls.some(call => call[0] === "hide_window")).toBe(false);
  panel.hidden = true;
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(input.value).toBe("");
});

it("preserves the saved library scope after a failed local registry read and recovers through the same registry owner", async () => {
  const original = invokeMock.getMockImplementation()!;
  let firstRead = true;
  let restored!: () => void;
  invokeMock.mockImplementation((command, args) => {
    if (command === "list_libraries" && firstRead) { firstRead = false; return Promise.reject(new Error("Local registry temporarily unavailable")); }
    if (command === "restore_connections") return new Promise<void>(resolve => { restored = resolve; });
    return original(command, args);
  });
  await act(async () => root.render(<App />)); await advance(400);
  expect(JSON.parse(localStorage.getItem("craft-search-filters-v1")!).libraryIds).toEqual(["1"]);
  expect(invokeMock.mock.calls.filter(call => call[0] === "list_libraries")).toHaveLength(1);
  await act(async () => restored()); await advance(400);
  expect(host.textContent).toContain("Beta");
  expect(host.textContent).toContain("Local page");
  expect(invokeMock).toHaveBeenCalledWith("recent_documents", expect.objectContaining({ spaceIds: ["1"] }));
  expect(JSON.parse(localStorage.getItem("craft-search-filters-v1")!).libraryIds).toEqual(["1"]);
  expect(invokeMock.mock.calls.filter(call => call[0] === "list_libraries")).toHaveLength(2);
  expect(invokeMock.mock.calls.filter(call => call[0] === "restore_connections")).toHaveLength(1);
});

it("syncs or clears search list selection and keeps keyboard/focus actions aligned when opening from sidebar Recently Opened", async () => {
  const original = invokeMock.getMockImplementation()!;
  const searchA: SearchResult = { ...result, id: "hit-a", entityKey: "craft:a", documentId: "doc-a", title: "搜索命中 A", documentTitle: "搜索命中 A", snippet: "线束 A" };
  const searchB: SearchResult = { ...result, id: "hit-b", entityKey: "craft:b", documentId: "doc-b", title: "搜索命中 B", documentTitle: "搜索命中 B", snippet: "线束 B" };
  const recentOnly: SearchResult = { ...result, id: "recent-x", entityKey: "craft:x", documentId: "doc-x", title: "最近独有文档 X", documentTitle: "最近独有文档 X", snippet: "历史预览" };
  localStorage.setItem("hub-desktop-sidebar-enabled-v1", "true");
  localStorage.setItem("hub-desktop-view-history-v1", JSON.stringify([recentOnly, searchB]));
  const openedDocuments: string[] = [];
  invokeMock.mockImplementation((command, args) => {
    if (command === "local_search") return Promise.resolve([searchA, searchB]);
    if (command === "local_document") {
      const docId = (args as { documentId?: string })?.documentId;
      return Promise.resolve(`# 正文 ${docId}\n\n## 第一节\n\n## 第二节`);
    }
    if (command === "open_result") {
      openedDocuments.push((args as { documentId?: string })?.documentId ?? "");
      return Promise.resolve({});
    }
    if (command === "hide_window") return Promise.resolve();
    if (command === "result_link") return Promise.resolve("craftdocs://open?blockId=doc");
    return original(command, args);
  });

  const selectedRows = () => host.querySelectorAll(".quick-craft-result-block.selected, .grouped-page-hit.selected, .result-group.selected, .recent-item.selected");

  await act(async () => root.render(<App />)); await advance(400);
  const input = host.querySelector<HTMLInputElement>('input[aria-label^="搜索"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "线束");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await advance(400);

  // Initially searchA is highlighted
  expect(selectedRows()).toHaveLength(1);
  expect(selectedRows()[0].closest(".quick-craft-result-group")?.textContent).toContain("搜索命中 A");

  // Expand sidebar Recently Opened and click recentOnly (not in visible search results)
  const recentToggle = host.querySelector<HTMLButtonElement>(".sidebar-recent-toggle")!;
  await act(async () => recentToggle.click());
  const recentButtons = Array.from(host.querySelectorAll<HTMLButtonElement>(".sidebar-recent-open"));
  expect(recentButtons.map(b => b.textContent)).toEqual(["最近独有文档 X", "搜索命中 B"]);

  await act(async () => recentButtons[0].click()); await advance(100);
  // Stale blue selection on searchA is cleared, preview shows recentOnly
  expect(selectedRows()).toHaveLength(0);
  expect(host.querySelector(".preview-pane .preview-heading")?.textContent).toContain("最近独有文档 X");

  // Hovering searchA while previewing recentOnly does not resurrect stale blue selection
  const firstHit = host.querySelector<HTMLElement>(".quick-craft-result-block, .grouped-page-hit")!;
  await act(async () => firstHit.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
  expect(selectedRows()).toHaveLength(0);

  // Focus mode toggles on .workspace.with-preview and Escape restores split without closing preview
  const focusBtn = host.querySelector<HTMLButtonElement>(".preview-focus-btn")!;
  await act(async () => focusBtn.click());
  expect(host.querySelector(".workspace.with-preview.preview-focus-mode")).not.toBeNull();
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  expect(host.querySelector(".workspace.with-preview.preview-focus-mode")).toBeNull();
  expect(host.querySelector(".workspace.with-preview")).not.toBeNull();

  // Pressing Enter opens recentOnly (matches actual preview), NOT searchA
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await advance(2600);
  expect(openedDocuments).toEqual(["doc-x"]);

  // Pressing ArrowDown selects searchA, switches preview to searchA, and Enter opens searchA
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  await advance(100);
  expect(selectedRows()).toHaveLength(1);
  expect(selectedRows()[0].closest(".quick-craft-result-group")?.textContent).toContain("搜索命中 A");
  expect(host.querySelector(".preview-pane .preview-heading")?.textContent).toContain("搜索命中 A");
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await advance(2600);
  expect(openedDocuments).toEqual(["doc-x", "doc-a"]);

  // Clicking searchB from Recently Opened (present in visible results) syncs left selection to searchB
  const recentButtonsAfter = Array.from(host.querySelectorAll<HTMLButtonElement>(".sidebar-recent-open"));
  const searchBButton = recentButtonsAfter.find(b => b.textContent === "搜索命中 B")!;
  await act(async () => searchBButton.click()); await advance(100);
  expect(selectedRows()).toHaveLength(1);
  expect(selectedRows()[0].closest(".quick-craft-result-group")?.textContent).toContain("搜索命中 B");
  expect(host.querySelector(".preview-pane .preview-heading")?.textContent).toContain("搜索命中 B");
  await act(async () => host.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await advance(2600);
  expect(openedDocuments).toEqual(["doc-x", "doc-a", "doc-b"]);
});
