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
  await select("日期范围", "30"); await click("重置");
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
  await click("全不选");
  await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(scope).toHaveBeenCalledWith([]); expect(props.setFolderId).toHaveBeenCalledWith("");
});

it("switches content type without changing query, date or library range; clears conditions individually", async () => {
  const props = filters();
  await act(async () => root.render(<MobileSearchControls filters={props}/>));
  await click("任务");
  expect(props.setSourceFilters).toHaveBeenCalledWith({ craft: false, task: true, pdf: false, media: false, attachment: false, reading: false, flashcard: false });
  expect(props.setDateFilter).not.toHaveBeenCalled(); expect(props.setFolderId).not.toHaveBeenCalled();
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='移除筛选：近 7 天']")!.click());
  expect(props.setDateFilter).toHaveBeenCalledWith("any");
});

it("keeps the five prototype destinations reachable with Agents in the center", async () => {
  const navigate = vi.fn();
  await act(async () => root.render(<MobileNavigation active="agents" onSelect={navigate} dueCount={3}/>));
  expect([...host.querySelectorAll("button")].map(button => button.textContent)).toEqual(["搜索", "浏览", "Agents", "任务", "3复习"]);
  expect(host.querySelector("[aria-current='page']")?.textContent).toBe("Agents"); await click("Agents"); expect(navigate).toHaveBeenCalledWith("agents");
});

it("opens the real insights workspace from browse without duplicating Agents", async () => {
  const insights = vi.fn();
  await act(async () => root.render(<MobileBrowse favoriteCount={0} historyCount={0} journalCount={0} tagCount={0} onOpen={vi.fn()} onOpenInsights={insights} onOpenLibraries={vi.fn()} onOpenSettings={vi.fn()} onOpenSyncHealth={vi.fn()} syncNeedsAttention={false}/>));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("洞察"))!.click());
  expect(insights).toHaveBeenCalledOnce(); expect(host.textContent).toContain("发现与回看");
});

it("keeps content synchronization and Agents as distinct connection actions", async () => {
  const content = vi.fn(), agents = vi.fn();
  await act(async () => root.render(<MobileConnections onContent={content} onAgents={agents}/>));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("阿里云内容同步"))!.click());
  expect(content).toHaveBeenCalledOnce(); expect(agents).not.toHaveBeenCalled();
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith("Agents 会话"))!.click());
  expect(agents).toHaveBeenCalledOnce();
});

 it.each([['阅读','reading'],['闪卡','flashcard']])('selects %s without broadening the current library or date range',async(label,key)=>{
  const props=filters(),scope=vi.fn(); props.selectedLibraryIds=[];
  await act(async()=>root.render(<MobileSearchControls filters={props} onSelectLibraries={scope}/>));
  await click(label);
  expect(props.setSourceFilters).toHaveBeenCalledWith(Object.fromEntries(['craft','task','pdf','media','attachment','reading','flashcard'].map(id=>[id,id===key])));
  expect(scope).not.toHaveBeenCalled();expect(props.setDateFilter).not.toHaveBeenCalled();
 });
