// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { CollectionNavigation } from "./CollectionNavigation";
import { CollectionViewsProvider, useCollectionViews, type CollectionViewsContextValue } from "./CollectionViews";
import type { LibrarySummary } from "./SearchTypes";

let container: HTMLDivElement, root: Root, model: CollectionViewsContextValue;
const libraries: LibrarySummary[] = [
  { id: "craft", provider: "craft", name: "Main", connected: true, documentCount: 10, excludedPaths: [], iconSvg: "data:image/png;base64,CROP" },
  { id: "obsidian", provider: "obsidian", name: "Main", connected: true, documentCount: 12, excludedPaths: [] },
];
function Probe() {
  model = useCollectionViews();
  useEffect(() => model.setNavigationCounts({ all: 19, unread: 15, inProgress: 2, read: 2, archived: 3, abandoned: 1, needsAttention: 2, savedCopies: [{ libraryId: "craft", count: 5 }] }), [model.setNavigationCounts]);
  return null;
}
beforeEach(() => { localStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(mountedLibraries = libraries) { await act(async () => root.render(<CollectionViewsProvider><Probe /><CollectionNavigation libraries={mountedLibraries} /></CollectionViewsProvider>)); }
async function click(label: string) { const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label)!; expect(button).toBeTruthy(); await act(async () => button.click()); }
async function input(value: string) { const element = container.querySelector<HTMLInputElement>(".collection-nav-editor input")!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); }); }

it("provides dedicated state navigation and opens collection settings without search collections", async () => {
  await mount();
  expect(container.textContent).not.toContain("智能集合");
  expect(container.querySelector('[aria-label="待读"]')?.textContent).toBe("待读15");
  await click("待读"); expect(model.view.status).toBe("unread");
  await click("需要处理"); expect(model.view.attentionOnly).toBe(true);
  await click("收集与保存设置"); expect(model.settingsRevision).toBe(1);
});

it("collapses matching provider and library names in visible and accessible saved-copy labels", async () => {
  await mount([
    ...libraries,
    { ...libraries[0], id: "craft-default", name: "Craft" },
    { ...libraries[1], id: "obsidian-default", name: "Obsidian" },
    { ...libraries[0], id: "dida-default", provider: "dida365", name: "滴答清单" },
    { ...libraries[0], id: "dida-custom", provider: "dida365", name: "稍后阅读" },
  ]);
  await click("展开已保存副本");
  for (const label of ["Craft", "Obsidian", "滴答清单", "滴答清单 · 稍后阅读", "Craft · Main", "Obsidian · Main"]) {
    const button = container.querySelector<HTMLButtonElement>(`[aria-label="已保存到 ${label}"]`)!;
    expect(button).not.toBeNull();
    expect(button.querySelector(":scope > span:not(.library-icon)")?.textContent).toBe(label);
    expect(button.title).toBe(`已保存到 ${label} 的收藏副本`);
    expect(button.querySelector<HTMLElement>(".library-icon")?.title).toBe(label);
  }
  expect(container.textContent).not.toContain("滴答清单 · 滴答清单");
  await click("已保存到 滴答清单");
  expect(model.view.destinationId).toBe("dida-default");
});

it("distinguishes duplicate library names and uses the cropped library icon for saved copies", async () => {
  await mount();
  expect(container.querySelector(".collection-nav-copies")).toBeNull();
  await click("展开已保存副本");
  expect(container.querySelector('[aria-label="已保存到 Craft · Main"]')?.textContent).toBe("Craft · Main5");
  expect(container.querySelector('[aria-label="已保存到 Obsidian · Main"]')).not.toBeNull();
  expect(container.querySelector<HTMLImageElement>('[aria-label="已保存到 Craft · Main"] img')?.src).toBe("data:image/png;base64,CROP");
  await click("已保存到 Craft · Main"); expect(model.view.destinationId).toBe("craft");
});

it("saves a named view and allows hiding and restoring its navigation entry", async () => {
  await mount();
  await click("保存当前筛选为视图"); await input("我的阅读"); await click("保存视图");
  expect(model.views[0].name).toBe("我的阅读");
  await click("视图 我的阅读 的更多操作"); await click("隐藏视图");
  expect(container.querySelector('[aria-label="我的阅读"]')).toBeNull();
  await click("管理我的视图");
  const checkbox = container.querySelector<HTMLInputElement>(".collection-nav-manage input")!;
  await act(async () => checkbox.click());
  expect(container.querySelector('[aria-label="我的阅读"]')).not.toBeNull();
});

it("shows each saved view's layout icon and refreshes it when layout changes are saved", async () => {
  await mount();
  const layouts = [
    ["list", "列表视图", "lucide-layout-list"],
    ["table", "表格视图", "lucide-table-2"],
    ["board", "看板视图", "lucide-columns-3"],
    ["gallery", "画廊视图", "lucide-gallery-horizontal"],
  ] as const;
  for (const [layout, name] of layouts) {
    await act(async () => model.selectLayout(layout));
    await act(async () => model.saveView(name));
  }
  for (const [, name, iconClass] of layouts) {
    const icon = container.querySelector(`[aria-label="${name}"] svg`)!;
    expect(icon.classList.contains(iconClass)).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
  }
  await click("列表视图");
  await act(async () => model.selectLayout("board"));
  expect(container.querySelector('[aria-label="列表视图"] svg')?.classList.contains("lucide-layout-list")).toBe(true);
  await click("更新视图");
  expect(container.querySelector('[aria-label="列表视图"] svg')?.classList.contains("lucide-columns-3")).toBe(true);
});

it("closes view menus after keyboard focus leaves or the window loses focus", async () => {
  await mount();
  await act(async () => model.saveView("菜单测试"));
  await click("视图 菜单测试 的更多操作");
  expect(container.querySelector('[role="menu"]')).not.toBeNull();
  const outside = container.querySelector<HTMLButtonElement>('[aria-label="待读"]')!;
  await act(async () => outside.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  await click("视图 菜单测试 的更多操作");
  expect(container.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("blur")));
  expect(container.querySelector('[role="menu"]')).toBeNull();
});
