// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionNavigation } from "./CollectionNavigation";
import { CollectionViewsProvider, type CollectionNavigationCounts } from "./CollectionViews";
import { CollectionsWorkspace } from "./CollectionsWorkspace";
import { DesktopSidebar } from "./DesktopSidebar";
import { createSmartCollection } from "./SmartCollections";
import type { LibrarySummary } from "./SearchTypes";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null) }));

const libraries: LibrarySummary[] = [
  { id: "craft-main", name: "Main", provider: "craft", connected: true, documentCount: 150, excludedPaths: [] },
  { id: "obsidian-main", name: "Main", provider: "obsidian", connected: true, documentCount: 1300, excludedPaths: [] },
  { id: "dida", name: "滴答清单", provider: "dida365", connected: true, documentCount: 450, excludedPaths: [] },
];
const counts: CollectionNavigationCounts = {
  all: 697, unread: 610, inProgress: 7, read: 80, archived: 9, abandoned: 4,
  needsAttention: 2, savedCopies: [{ libraryId: "craft-main", count: 11 }, { libraryId: "obsidian-main", count: 12 }],
};
const item = {
  key: "x:read", collectedAt: 1791165600000, read: false, status: "unread", tags: ["AI"], lifecycle: "active",
  post: { id: "read", text: "用于阅读的收藏\n正文仍在本地", authorName: "作者", authorHandle: "reader", publishedAt: "2026-10-05", url: "https://x.com/reader/status/read", quotedText: "", contentStatus: "complete", links: [], media: [], source: "bookmarks" },
};
const storage = { config: { mode: "database", vaultPath: "", downloadMedia: true, autoSyncMinutes: 30 }, running: false, status: "" };
const page = {
  items: [item], total: 697, unread: 610, matched: 1, navigationCounts: counts, availableTags: ["AI", "阅读"],
  connected: true, running: false, canResume: true, status: "",
  sources: [
    { id: "bookmarks", count: 673, connected: true, canResume: true, status: "" },
    { id: "likes", count: 20, connected: true, canResume: true, status: "" },
    { id: "telegram", count: 4, connected: true, canResume: true, status: "" },
  ],
};
let container: HTMLDivElement;
let root: Root;

function Harness({ sidebarProps }: { sidebarProps?: ComponentProps<typeof DesktopSidebar> }) {
  const [visible, setVisible] = useState(true);
  return <>
    <button aria-label="测试切换模块" onClick={() => setVisible(value => !value)}>切换模块</button>
    {sidebarProps ? <DesktopSidebar {...sidebarProps} /> : <CollectionNavigation libraries={libraries} />}
    {visible && <CollectionsWorkspace />}
  </>;
}
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  invoke.mockImplementation(async (command: string) => command === "list_collection_items" ? page : command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : []);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); invoke.mockReset(); });
async function mount(sidebarProps?: ComponentProps<typeof DesktopSidebar>) {
  await act(async () => root.render(<CollectionViewsProvider><Harness sidebarProps={sidebarProps} /></CollectionViewsProvider>));
  await act(async () => vi.advanceTimersByTimeAsync(160));
}
async function clickButton(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(element => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
}
async function clickNavigation(label: string) {
  const button = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="阅读导航"] button')].find(element => element.getAttribute("aria-label") === label || element.querySelector("span")?.textContent?.trim() === label);
  expect(button, label).toBeTruthy(); await act(async () => button!.click());
  await act(async () => vi.advanceTimersByTimeAsync(160));
}
async function changeField(label: string, value: string) {
  const element = container.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  expect(element, label).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
const latestQuery = () => { const calls = invoke.mock.calls.filter(([command]) => command === "list_collection_items"); return calls[calls.length - 1]?.[1]; };
const localCommands = new Set(["list_collection_items", "get_collection_storage", "list_libraries", "collection_library_operations"]);

it("uses source-scoped full counts and local queries for reading navigation independently of the visible page", async () => {
  invoke.mockImplementation(async (command: string, args?: { source?: string }) => command === "list_collection_items" ? { ...page, navigationCounts: args?.source === "telegram" ? { ...counts, all: 4, unread: 3, inProgress: 0, read: 1, savedCopies: [] } : counts } : command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : []);
  await mount();
  const navigation = container.querySelector('[aria-label="阅读导航"]')!;
  expect(navigation.textContent).toContain("610");
  expect(container.querySelectorAll(".collection-row")).toHaveLength(1);
  const telegram = container.querySelector<HTMLButtonElement>(".collection-chip-telegram")!;
  await act(async () => telegram.click()); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(navigation.textContent).toContain("3");
  await clickNavigation("待读");
  expect(latestQuery()).toMatchObject({ source: "telegram", status: "unread", offset: 0 });
  await clickButton("表格");
  expect(container.querySelector(".collection-table-wrap")).toBeTruthy();
  expect(latestQuery()).toMatchObject({ source: "telegram", status: "unread" });
  await clickNavigation("归档");
  expect(latestQuery()).toMatchObject({ source: "telegram", status: "archived" });
  expect(container.querySelector('.task-view-switch button[aria-pressed="true"]')?.textContent).toBe("表格");
  expect(invoke.mock.calls.every(([command]) => localCommands.has(command))).toBe(true);
});

it("passes a saved-copy library filter while preserving source and revealing its active condition", async () => {
  await mount();
  await act(async () => container.querySelector<HTMLButtonElement>(".collection-chip-likes")!.click());
  await act(async () => vi.advanceTimersByTimeAsync(160));
  await clickNavigation("已保存副本");
  const libraryButton = [...container.querySelectorAll<HTMLButtonElement>('[aria-label="阅读导航"] button')].find(button => button.textContent?.includes("Craft") && button.textContent.includes("Main"));
  expect(libraryButton).toBeTruthy(); await act(async () => libraryButton!.click());
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(latestQuery()).toMatchObject({ source: "likes", status: "all", filters: { libraryId: "craft-main" } });
  expect(container.querySelector('[aria-label="当前筛选条件"]')?.textContent).toContain("已保存副本：Main");
  expect(invoke.mock.calls.every(([command]) => localCommands.has(command))).toBe(true);
});

it("saves explicit query conditions and later layout changes in the named view without writing content", async () => {
  await mount(); await clickNavigation("待读"); await clickButton("筛选");
  await changeField("内容类型筛选", "video"); await changeField("收集时间筛选", "7");
  // Changing scope refreshes the page and its available tags before a real
  // user can select an option from the new query's tag picker.
  await act(async () => vi.advanceTimersByTimeAsync(160));
  expect([...container.querySelectorAll<HTMLOptionElement>('[aria-label="阅读标签筛选"] option')].some(option => option.value === "AI")).toBe(true);
  await changeField("阅读标签筛选", "AI");
  await clickButton("新建视图"); await changeField("新视图名称", "AI 视频待读"); await clickButton("创建视图");
  await clickButton("画廊");
  expect(container.querySelector(".collection-nav-view-changes")).toBeNull();
  await clickNavigation("全部内容"); await clickNavigation("AI 视频待读");
  expect(latestQuery()).toMatchObject({ source: "all", status: "unread", media: "video", filters: { tags: ["AI"], collectedWithinDays: 7 } });
  expect(container.querySelector('.task-view-switch button[aria-pressed="true"]')?.textContent).toBe("画廊");
  expect(container.querySelector(".collection-view-modified")).toBeNull();
  expect(invoke.mock.calls.every(([command]) => localCommands.has(command))).toBe(true);
});

it.each(["列表", "表格", "看板", "画廊"])("offers target-specific recovery in %s without reopening a successful target", async layout => {
  const plan = { provider: "craft", status: "planned", summary: "归档原文", reason: "", libraryName: "Main", destinationPath: "今日页面", title: "用于阅读的收藏", markdown: "正文", tasks: [], warnings: [], attachments: [] };
  const operations = [
    { key: item.key, action: "move", target: "craft-main", phase: "partial", error: "附件待补齐", plan },
    { key: item.key, action: "move", target: "dida", phase: "unknown", error: "写入结果待核对", plan: { ...plan, provider: "dida365", libraryName: "滴答清单" } },
    { key: item.key, action: "move", target: "obsidian-main", phase: "cancelled", error: "保留已有副本", plan },
  ];
  invoke.mockImplementation(async (command: string) => command === "list_collection_items" ? { ...page, items: [{ ...item, attentionOperations: operations.filter(operation => operation.phase !== "cancelled") }] } : command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : []);
  await mount(); await clickButton(layout); await clickNavigation("需要处理");
  expect(latestQuery()).toMatchObject({ status: "needs_attention" });
  const actions = container.querySelector(".collection-attention-actions")!;
  expect(actions.textContent).toContain("Main：继续补齐");
  expect(actions.textContent).toContain("滴答清单：待核对");
  expect(actions.querySelectorAll("button")).toHaveLength(2);
  await act(async () => [...actions.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("滴答清单"))!.click());
  expect(container.querySelector("dialog[open]")?.textContent).toContain("实际创建的页面或任务 ID");
  expect(invoke.mock.calls.every(([command]) => localCommands.has(command))).toBe(true);
});

it("renders the production collection sidebar separately from search smart collections under their shared provider", async () => {
  const smart = createSmartCollection("search-ai", "搜索专用智能集合", {
    query: "使用 AI", libraryIds: null, folderId: "", dateFilter: "any", searchScope: "all",
    sourceFilters: { craft: true, task: true, pdf: true, media: true, attachment: true },
  }, 1);
  const raw = JSON.stringify([smart]); localStorage.setItem("hub-desktop-smart-collections-v1", raw);
  const onApplySmartCollection = vi.fn();
  const props: ComponentProps<typeof DesktopSidebar> = {
    activeView: "collections", smartCollections: [smart], activeSmartCollectionId: smart.id,
    currentSearchCanBeSaved: true, spaces: libraries, selectedLibraryIds: null,
    renderLibraryIcon: () => <i />, onSelectView: () => undefined, onToggleLibrary: () => undefined,
    onToggleAllLibraries: () => undefined, onManageLibraries: () => undefined,
    favoriteCount: 0, taskOpenCount: 0, journalCount: 0, journalDates: [], selectedJournalDate: "",
    onSelectJournalDate: () => undefined, historyCount: 0, flashcardDueCount: 0,
    tags: [], selectedTag: "", tagOverviewMode: "all", favoriteTags: [], recentTags: [], customTagGroups: [], tagProperties: {}, tagsLoading: false,
    onSelectTagsOverview: () => undefined, onSelectCleanupTags: () => undefined, onSelectTag: () => undefined,
    onToggleFavoriteTag: () => undefined, onCreateTagGroup: () => undefined, onDeleteTagGroup: () => undefined,
    onAssignTagToGroup: () => undefined, onCreateSmartCollection: () => true, onApplySmartCollection,
    onRenameSmartCollection: () => true, onDeleteSmartCollection: () => undefined, onCollapse: () => undefined,
  };
  await mount(props);
  expect(container.querySelector(".desktop-sidebar-brand .sidebar-home strong")?.textContent).toBe("阅读");
  expect(container.querySelector(".desktop-sidebar.view-collections")?.getAttribute("aria-label")).toBe("阅读导航");
  expect(container.querySelector(".desktop-sidebar.view-collections .collection-navigation")).toBeTruthy();
  expect(container.querySelector(".sidebar-smart-collections")).toBeNull();
  expect(container.textContent).not.toContain(smart.name);
  await clickNavigation("待读");
  expect(latestQuery()).toMatchObject({ status: "unread", query: "" });
  expect(onApplySmartCollection).not.toHaveBeenCalled();
  expect(localStorage.getItem("hub-desktop-smart-collections-v1")).toBe(raw);
  await act(async () => root.render(<CollectionViewsProvider><DesktopSidebar {...props} activeView="home" /></CollectionViewsProvider>));
  expect(container.querySelector(".sidebar-smart-collections")?.textContent).toContain(smart.name);
  expect(container.querySelector(".collection-navigation")).toBeNull();
  expect(localStorage.getItem("hub-desktop-smart-collections-v1")).toBe(raw);
});

it("retains the selected local preview and scroll position after the workspace unmounts and returns", async () => {
  await mount();
  await act(async () => container.querySelector<HTMLElement>(".collection-row")!.click());
  const database = container.querySelector<HTMLDivElement>(".collection-database")!;
  await act(async () => { database.scrollTop = 360; database.dispatchEvent(new Event("scroll", { bubbles: true })); });
  await clickButton("测试切换模块");
  expect(container.querySelector(".collections-workspace")).toBeNull();
  await clickButton("测试切换模块"); await act(async () => vi.advanceTimersByTimeAsync(160));
  expect(container.querySelector<HTMLDivElement>(".collection-database")?.scrollTop).toBe(360);
  expect(container.querySelector('[aria-label="阅读详情"]')?.textContent).toContain("正文仍在本地");
  expect(container.querySelector(".collection-row.selected")).toBeTruthy();
  expect(invoke.mock.calls.every(([command]) => localCommands.has(command))).toBe(true);
});

it.each(["partial", "unknown", "needs_review"])("keeps a parked %s plan isolated from another active target and resumes only its library", async phase => {
  const plan = { provider: "craft", status: "planned", summary: "归档原文", reason: "", libraryName: "Main", destinationPath: "今日页面", title: "用于阅读的收藏", markdown: "正文", tasks: [], warnings: [], attachments: [] };
  const parked = { key: item.key, action: "move", target: "craft-main", phase, error: "该库等待恢复", parked: true, plan };
  const active = { key: item.key, action: "move", target: "dida", phase: "saving", error: "", plan: { ...plan, provider: "dida365", libraryName: "滴答清单" } };
  invoke.mockImplementation(async (command: string) => command === "list_collection_items" ? { ...page, items: [{ ...item, attentionOperations: [parked] }] } : command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : command === "collection_library_operations" ? [active, parked] : command === "move_collection_to_library" ? "此资料库处理已恢复" : []);
  await mount(); await clickNavigation("需要处理");
  await act(async () => container.querySelector<HTMLButtonElement>(".collection-attention-actions button")!.click());
  const dialog = container.querySelector<HTMLDialogElement>("dialog[open]")!;
  expect(dialog).toBeTruthy(); expect(dialog.querySelector("strong")?.textContent).toBe("Main");
  const buttons = [...dialog.querySelectorAll("button")].map(button => button.textContent);
  expect(buttons).not.toContain("取消方案");
  expect(buttons).not.toContain("继续补齐");
  expect(buttons).not.toContain("按方案保存副本");
  expect(dialog.querySelector('[aria-label="实际页面或任务 ID"]')).toBeNull();
  expect(dialog.querySelector('[aria-label="补充处理目标"]')).toBeNull();
  await clickButton("恢复此库处理");
  expect(invoke).toHaveBeenCalledWith("move_collection_to_library", { key: item.key, destination: "craft-main" });
  expect(invoke.mock.calls.filter(([command]) => command === "move_collection_to_library")).toHaveLength(1);
  expect(container.querySelector("dialog[open] strong")?.textContent).toBe("Main");
  expect(invoke.mock.calls.some(([command]) => ["approve_collection_conversion", "cancel_collection_conversion", "resolve_collection_conversion", "regenerate_collection_conversion"].includes(command))).toBe(false);
});

it("rejects an older local response before it can replace a newer source's list or navigation counts", async () => {
  let resolveOld!: (value: typeof page) => void;
  invoke.mockImplementation((command: string, args?: { source?: string }) => {
    if (command === "list_collection_items") return args?.source === "all" ? new Promise<typeof page>(resolve => { resolveOld = resolve; }) : Promise.resolve({ ...page, navigationCounts: { ...counts, unread: 8 }, items: [{ ...item, post: { ...item.post, text: "新版来源内容" } }] });
    return Promise.resolve(command === "get_collection_storage" ? storage : command === "list_libraries" ? libraries : []);
  });
  await mount();
  await act(async () => container.querySelector<HTMLButtonElement>(".collection-chip-likes")!.click());
  await act(async () => vi.advanceTimersByTimeAsync(160));
  await act(async () => resolveOld({ ...page, navigationCounts: { ...counts, unread: 999 } }));
  expect(container.querySelector(".collection-database")?.textContent).toContain("新版来源内容");
  expect(container.querySelector('[aria-label="阅读导航"]')?.textContent).not.toContain("999");
  expect(latestQuery()).toMatchObject({ source: "likes" });
});
