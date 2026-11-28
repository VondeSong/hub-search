// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MobileSearchControls, MobileSearchFilterForm } from "./MobileSearchControls";
import { MobileBrowse, MobileConnections, MobileNavigation } from "./MobileNavigation";
import type { FilterBar } from "./FilterBar";

let host: HTMLDivElement, root: Root;
const libraries = [{ id: "os", name: "OS", provider: "obsidian" as const, connected: true, documentCount: 5, excludedPaths: [] }];
function filters(): ComponentProps<typeof FilterBar> {
  return { activeSpaces: libraries, spaces: libraries, dateFilter: "7", dateMenuOpen: false, folderId: "", folderMenuOpen: false, folders: [], searchScope: "title", searchScopeMenuOpen: false, selectedLibraryIds: null,
    sourceFilters: { craft: true, task: false, pdf: true, media: false, attachment: true }, syncing: false,
    refreshIndex: vi.fn(), setDateFilter: vi.fn(), setDateMenuOpen: vi.fn(), setFolderId: vi.fn(), setFolderMenuOpen: vi.fn(), setSearchScope: vi.fn(), setSearchScopeMenuOpen: vi.fn(), setSourceFilters: vi.fn(), startWindowDrag: vi.fn() };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
async function click(text: string) { await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === text)!.click()); }
async function select(label: string, value: string) { await act(async () => { const input = host.querySelector<HTMLSelectElement>(`select[aria-label='${label}']`)!; input.value = value; input.dispatchEvent(new Event("change", { bubbles: true })); }); }

it("keeps filter changes and reset as drafts, discards them on cancel, then applies once", async () => {
  const props = filters(), scope = vi.fn(), applied = vi.fn();
  function Harness() { const [open, setOpen] = useState(true); return <><button onClick={() => setOpen(!open)}>切换</button>{open && <MobileSearchFilterForm filters={props} onSelectLibraries={scope} onApply={applied}/>}</>; }
  await act(async () => root.render(<Harness/>));
  await select("日期范围", "30"); await click("重置全库");
  expect(props.setDateFilter).not.toHaveBeenCalled(); expect(scope).not.toHaveBeenCalled();
  await click("切换"); await click("切换");
  expect(host.querySelector<HTMLSelectElement>("select[aria-label='日期范围']")!.value).toBe("7");
  expect(host.querySelector<HTMLSelectElement>("select[aria-label='内容类型']")!.value).toBe("custom");
  await select("日期范围", "90");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(props.setDateFilter).toHaveBeenCalledExactlyOnceWith("90");
  expect(props.setSourceFilters).toHaveBeenCalledWith({ ...props.sourceFilters, reading: false, flashcard: false }); expect(applied).toHaveBeenCalledOnce();
});

it("retains an explicitly empty library range instead of broadening to all", async () => {
  const props = filters(), scope = vi.fn();
  await act(async () => root.render(<MobileSearchFilterForm filters={props} onSelectLibraries={scope} onApply={vi.fn()}/>));
  await click("清空");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(scope).toHaveBeenCalledWith([]); expect(props.setFolderId).toHaveBeenCalledWith("");
});

it("switches content type without changing query, date or library range; clears conditions individually", async () => {
  const props = filters();
  await act(async () => root.render(<MobileSearchControls filters={props}/>));
  await select("内容类型", "task");
  expect(props.setSourceFilters).toHaveBeenCalledWith({ craft: false, task: true, pdf: false, media: false, attachment: false, reading: false, flashcard: false });
  expect(props.setDateFilter).not.toHaveBeenCalled(); expect(props.setFolderId).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='移除筛选：近 7 天']")!.click());
  expect(props.setDateFilter).toHaveBeenCalledWith("any");
});

it("keeps six primary tabs when an advanced type is active", async () => {
  const props = filters();
  props.sourceFilters = { craft: false, task: false, pdf: false, media: true, attachment: false, reading: false, flashcard: false };
  await act(async () => root.render(<MobileSearchControls filters={props} inlineScope results={[]} />));

  const tabs = host.querySelector("nav[aria-label='搜索内容类型']")!;
  expect([...tabs.querySelectorAll("button")].map(button => button.textContent)).toEqual(["全部", "资料", "日志", "任务", "阅读", "闪卡"]);
  expect(tabs.querySelector('[aria-pressed="true"]')).toBeNull();
  const mediaFilter = host.querySelector<HTMLButtonElement>("[aria-label='移除筛选：类型：媒体']")!;
  await act(async () => mediaFilter.click());
  expect(props.setSourceFilters).toHaveBeenCalledWith({ craft: true, task: true, pdf: true, media: true, attachment: true, reading: true, flashcard: true });
  expect(props.setDateFilter).not.toHaveBeenCalled();
});

it("keeps the five prototype destinations reachable with Agents in the center", async () => {
  const navigate = vi.fn();
  await act(async () => root.render(<MobileNavigation active="agents" onSelect={navigate} dueCount={3}/>));
  expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["搜索", "浏览", "助手", "任务", "3复习"]);
  expect(host.querySelector("[aria-current='page']")?.textContent).toBe("助手"); await click("助手"); expect(navigate).toHaveBeenCalledWith("agents");
});

it("opens the real insights workspace from browse without duplicating Agents", async () => {
  const insights = vi.fn();
  await act(async () => root.render(<MobileBrowse favoriteCount={0} historyCount={0} journalCount={0} tagCount={0} onOpen={vi.fn()} onOpenInsights={insights} onOpenLibraries={vi.fn()} onOpenSettings={vi.fn()} onOpenSyncHealth={vi.fn()} syncNeedsAttention={false}/>));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("洞察"))!.click());
  expect(insights).toHaveBeenCalledOnce(); expect(host.textContent).toContain("发现与连接");
});

it("keeps content synchronization and Agents as distinct connection actions", async () => {
  const content = vi.fn(), agents = vi.fn();
  await act(async () => root.render(<MobileConnections onContent={content} onAgents={agents}/>));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("阿里云内容同步"))!.click());
  expect(content).toHaveBeenCalledOnce(); expect(agents).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("助手会话"))!.click());
  expect(agents).toHaveBeenCalledOnce();
});

 it.each([['阅读','reading'],['闪卡','flashcard']])('selects %s without broadening the current library or date range',async(_label,key)=>{
  const props=filters(),scope=vi.fn(); props.selectedLibraryIds=[];
  await act(async()=>root.render(<MobileSearchControls filters={props} onSelectLibraries={scope}/>));
  await select("内容类型", key);
  expect(props.setSourceFilters).toHaveBeenCalledWith(Object.fromEntries(['craft','task','pdf','media','attachment','reading','flashcard'].map(id=>[id,id===key])));
  expect(scope).not.toHaveBeenCalled();expect(props.setDateFilter).not.toHaveBeenCalled();
 });

it("inverts only the selected libraries and keeps advanced filters when restoring the full scope", async () => {
  const props=filters(), scope=vi.fn(); props.spaces=[...libraries,{...libraries[0],id:"second",name:"第二库"}];props.selectedLibraryIds=["os"];
  await act(async()=>root.render(<MobileSearchFilterForm filters={props} onSelectLibraries={scope} onApply={vi.fn()}/>));
  const apply=()=>act(async()=>{host.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));});
  await click("反选");await apply();expect(scope).toHaveBeenLastCalledWith(["second"]);
  await click("重置全库");await apply();expect(scope).toHaveBeenLastCalledWith(null);
  expect(props.setDateFilter).toHaveBeenLastCalledWith("7");expect(props.setSearchScope).toHaveBeenLastCalledWith("title");
});

it("supports one-tap library-only selection and folder chips in scope filter form", async () => {
  const props = filters(), scope = vi.fn();
  props.spaces = [...libraries, { ...libraries[0], id: "craft-1", name: "Craft" }];
  props.folders = [{ id: "f1", spaceId: "craft-1", libraryName: "Craft", name: "架构", path: "工作/架构" }];
  await act(async () => root.render(<MobileSearchFilterForm filters={props} onSelectLibraries={scope} onApply={vi.fn()} />));
  await click("工作/架构");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(scope).toHaveBeenLastCalledWith(["craft-1"]);
  expect(props.setFolderId).toHaveBeenLastCalledWith("craft-1\u0000f1");
});

it("normalizes manually checking all libraries to null and preserves unrelated folder on library toggle", async () => {
  const props = filters(), scope = vi.fn();
  props.spaces = [...libraries, { ...libraries[0], id: "craft-1", name: "Craft", provider: "craft" as const }];
  props.selectedLibraryIds = ["craft-1"];
  props.folders = [{ id: "f1", spaceId: "craft-1", libraryName: "Craft", name: "架构", path: "工作/架构" }];
  props.folderId = "craft-1\u0000f1";
  await act(async () => root.render(<MobileSearchFilterForm filters={props} onSelectLibraries={scope} onApply={vi.fn()} />));
  const osCheckbox = host.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
  await act(async () => { osCheckbox.click(); });
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(scope).toHaveBeenLastCalledWith(null);
  expect(props.setFolderId).toHaveBeenLastCalledWith("craft-1\u0000f1");
});

it("renders zero-selected applied scope warning and clears scope on reset", async () => {
  const props = filters(), scope = vi.fn();
  props.selectedLibraryIds = [];
  props.activeSpaces = [];
  await act(async () => root.render(<MobileSearchControls filters={props} onSelectLibraries={scope} />));
  expect(host.textContent).toContain("零选中不回退整库");
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='清除资料范围']")!.click());
  expect(scope).toHaveBeenCalledWith(null);
  expect(props.setFolderId).toHaveBeenCalledWith("");
});

it("hides folder and advanced filters in libraryOnly mode and prunes stale library IDs on submit", async () => {
  const props = filters(), scope = vi.fn();
  props.spaces = [...libraries];
  props.selectedLibraryIds = ["removed-lib"];
  props.folders = [{ id: "f1", spaceId: "os", libraryName: "OS", name: "日志", path: "日志" }];
  await act(async () => root.render(<MobileSearchFilterForm filters={props} libraryOnly onSelectLibraries={scope} onApply={vi.fn()} />));
  expect(host.querySelector("[aria-label='文件夹范围']")).toBeNull();
  expect(host.querySelector("[aria-label='日期范围']")).toBeNull();
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(scope).toHaveBeenCalledWith([]);
  expect(props.setDateFilter).not.toHaveBeenCalled();
});
