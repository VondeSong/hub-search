// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CollectionViewTabs } from "./CollectionViewTabs";
import { COLLECTION_VIEWS_KEY, CollectionViewsProvider, defaultCollectionView, parseCollectionViews, useCollectionViews, type CollectionViewsContextValue } from "./CollectionViews";
import { defaultCollectionCards } from "./CollectionCardConfig";

let container: HTMLDivElement, root: Root, model: CollectionViewsContextValue;
function Harness({ compact = false }: { compact?: boolean }) {
  model = useCollectionViews();
  return <div className="collections-workspace"><CollectionViewTabs compact={compact} onChange={patch => { model.updateView(patch); model.updateSavedView(); }}/></div>;
}
beforeEach(() => {
  localStorage.clear(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function mount(compact = false) { await act(async () => root.render(<CollectionViewsProvider><Harness compact={compact}/></CollectionViewsProvider>)); }
async function click(label: string, scope: ParentNode = container) {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === label || node.getAttribute("aria-label") === label)!;
  expect(button).toBeTruthy(); await act(async () => button.click());
}
async function input(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, value); element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
}
function persisted() { return parseCollectionViews(localStorage.getItem(COLLECTION_VIEWS_KEY)); }

it("shows genuine named tabs and keeps all saved configuration when changing layout", async () => {
  const first = { ...defaultCollectionView("gallery"), id: "first", name: "技术阅读", hidden: false, source: "dida", tags: ["汽车"], status: "unread", query: "BMS", widths: { title: 710 }, cards: { ...defaultCollectionCards, size: "spacious", hidden: ["author"] } };
  localStorage.setItem(COLLECTION_VIEWS_KEY, JSON.stringify({ version: 2, view: first, views: [first, { ...defaultCollectionView("table"), id: "second", name: "最近资料", hidden: false }], activeEntry: { kind: "view", id: "first" }, layoutPreferences: { table: { ...defaultCollectionView("table"), widths: { title: 200 }, cards: defaultCollectionCards } } }));
  await mount();
  expect(container.querySelector("summary")?.textContent).toBe("技术阅读");
  expect(container.querySelector('[aria-label="打开视图 最近资料"]')).toBeTruthy();
  expect(container.querySelectorAll(".collection-database-tab-track>.collection-database-view-tab")).toHaveLength(1);
  await click("表格");
  expect(model.view).toMatchObject({ id: "first", name: "技术阅读", layout: "table", source: "dida", tags: ["汽车"], status: "unread", query: "BMS", widths: { title: 710 }, cards: { size: "spacious", hidden: ["author"] } });
  expect(model.views[0]).toMatchObject({ layout: "table", widths: { title: 710 } });
  expect(model.views[1].layout).toBe("table");
  expect(model.isModified).toBe(false);
});

it("creates an independent named view with an explicit layout and inherited filters without editing on cancel", async () => {
  await mount(); await act(async () => model.updateView({ source: "telegram", status: "unread", tags: ["学习"], query: "材料", sorts: [{ id: "sort", field: "published", ascending: true }], density: "compact" }));
  const initial = model.view;
  await click("新建视图");
  const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
  expect(dialog.open).toBe(true); expect(document.activeElement).toBe(dialog.querySelector("input"));
  await input(dialog.querySelector("input")!, "视频阅读"); await click("画廊", dialog); await click("取消", dialog);
  expect(model.view).toBe(initial); expect(model.views).toHaveLength(0); expect(document.activeElement).toBe(container.querySelector('[aria-label="新建视图"]'));
  await click("新建视图"); const next = container.querySelector("dialog")!;
  await input(next.querySelector("input")!, "视频阅读"); await click("画廊", next); await click("创建视图", next);
  expect(model.views).toHaveLength(1); expect(model.view).toMatchObject({ name: "视频阅读", layout: "gallery", source: "telegram", status: "unread", tags: ["学习"], query: "材料", density: "compact", sorts: [{ field: "published", ascending: true }] });
  expect(model.activeEntry).toEqual({ kind: "view", id: model.views[0].id });
  expect(persisted().views[0]).toMatchObject({ name: "视频阅读", layout: "gallery" });
});

it("keeps the menu DOM and subsequent layout click when naming the temporary view", async () => {
  await mount(); const menu = container.querySelector("details")!; menu.open = true;
  const field = container.querySelector<HTMLInputElement>('[aria-label="视图名称"]')!;
  await act(async () => field.focus()); await input(field, "我的资料");
  const layout = [...container.querySelectorAll<HTMLButtonElement>(".collection-database-layout-options button")].find(node => node.textContent === "表格")!;
  await act(async () => { layout.focus(); layout.click(); });
  expect(container.querySelector("details")).toBe(menu); expect(menu.open).toBe(true);
  expect(model.views).toHaveLength(1); expect(model.views[0]).toMatchObject({ name: "我的资料", layout: "table" });
  expect(container.querySelector("summary")?.textContent).toBe("我的资料");
});

it("duplicates exact current settings, edits independently, and deletes only the selected view", async () => {
  await mount(); await act(async () => { model.updateView({ source: "likes", status: "read", destinationId: "craft-main", density: "compact" }); model.saveView("原视图"); });
  const original = model.views[0]; await click("复制视图");
  expect(model.views).toHaveLength(2); expect(model.view.id).not.toBe(original.id); expect(model.view).toMatchObject({ name: "原视图 副本", source: "likes", status: "read", destinationId: "craft-main", density: "compact" });
  await click("画廊"); expect(model.views[0]).toEqual(original); expect(model.views[1].layout).toBe("gallery");
  await click("删除视图"); expect(model.views).toEqual([original]); expect(model.view.id).toBe(original.id); expect(model.view.layout).toBe("list");
});

it("renames a saved view without replacing its identity and rejects a blank name", async () => {
  await mount(); await act(async () => model.saveView("原名称")); const id = model.view.id;
  let field = container.querySelector<HTMLInputElement>('[aria-label="视图名称"]')!;
  await act(async () => field.focus()); await input(field, "  学习阅读  "); await act(async () => field.blur());
  expect(model.views[0]).toMatchObject({ id, name: "学习阅读" });
  field = container.querySelector<HTMLInputElement>('[aria-label="视图名称"]')!;
  await act(async () => field.focus()); await input(field, "   "); await act(async () => field.blur());
  expect(model.views[0]).toMatchObject({ id, name: "学习阅读" }); expect(field.value).toBe("学习阅读");
});

it("offers a reachable saved-view switcher in compact mode and persists gallery properties correctly", async () => {
  await mount(true); await act(async () => { model.saveView("列表阅读"); model.saveView("画廊阅读", { layout: "gallery" }); });
  const selector = container.querySelector<HTMLSelectElement>('[aria-label="切换阅读视图"]')!;
  expect([...selector.options].map(option => option.textContent)).toEqual(["列表阅读", "画廊阅读"]);
  const author = [...container.querySelectorAll<HTMLLabelElement>(".collection-database-property")].find(node => node.textContent === "作者")!.querySelector<HTMLInputElement>("input")!;
  await act(async () => author.click()); expect(model.views[1].cards?.hidden).toContain("author");
  await input(selector, model.views[0].id); expect(model.view.name).toBe("列表阅读"); expect(model.view.columns.author).toBe(true);
  await input(container.querySelector<HTMLSelectElement>('[aria-label="切换阅读视图"]')!, model.views[1].id);
  expect(model.view.name).toBe("画廊阅读"); expect(model.view.cards?.hidden).toContain("author");
});

it("keeps the 30-view limit visible and refuses blank creation", async () => {
  await mount(); await click("新建视图"); const dialog = container.querySelector("dialog")!;
  await input(dialog.querySelector("input")!, "  "); expect(dialog.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await click("取消", dialog); await act(async () => { for (let i = 0; i < 30; i++) model.saveView(`视图 ${i}`); });
  expect(container.querySelector<HTMLButtonElement>('[aria-label="新建视图"]')?.disabled).toBe(true);
  expect([...container.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "复制视图")?.disabled).toBe(true);
});

it("keeps each named view's condition color independent and persists it across layout changes", async () => {
  await mount(); await act(async () => model.saveView("按状态阅读"));
  await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读条件颜色"]')!, "status");
  const statusId = model.view.id;
  await click("画廊"); await click("复制视图");
  await input(container.querySelector<HTMLSelectElement>('[aria-label="阅读条件颜色"]')!, "source");
  const sourceId = model.view.id;
  expect(model.views.find(item => item.id === statusId)).toMatchObject({ colorMode: "status", layout: "gallery" });
  expect(model.views.find(item => item.id === sourceId)).toMatchObject({ colorMode: "source", layout: "gallery" });
  await click("打开视图 按状态阅读"); expect(model.view.colorMode).toBe("status");
  expect(persisted().views.map(item => item.colorMode)).toEqual(["status", "source"]);
});

it("fits the creation form to the keyboard viewport, keeps its footer separate from scrolling content and submits without dismissing the keyboard", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 900, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport); vi.stubGlobal("innerHeight", 900);
  try {
    await mount(true); await click("新建视图");
    const dialog = container.querySelector<HTMLDialogElement>("dialog")!;
    const name = dialog.querySelector<HTMLInputElement>('[aria-label="新视图名称"]')!;
    expect(document.activeElement).toBe(name);
    expect(dialog.style.getPropertyValue("--collection-create-visible-height")).toBe("900px");
    await input(name, "手机新视图");
    await act(async () => { viewport.height = 480; viewport.offsetTop = 40; viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll")); });
    expect(dialog.style.getPropertyValue("--collection-create-visible-height")).toBe("480px");
    expect(dialog.style.getPropertyValue("--collection-create-visible-top")).toBe("40px");
    const body = dialog.querySelector(".collection-database-create-body")!;
    const footer = dialog.querySelector("footer")!;
    expect(body.contains(name)).toBe(true); expect(body.contains(footer)).toBe(false); expect(footer.parentElement).toBe(body.parentElement);
    await act(async () => { viewport.scale = 2; viewport.height = 240; viewport.offsetTop = 120; viewport.dispatchEvent(new Event("resize")); viewport.dispatchEvent(new Event("scroll")); });
    expect(dialog.style.getPropertyValue("--collection-create-visible-height")).toBe("480px");
    expect(dialog.style.getPropertyValue("--collection-create-visible-top")).toBe("40px");
    await act(async () => { viewport.scale = 1; viewport.height = 900; viewport.offsetTop = 0; viewport.dispatchEvent(new Event("resize")); });
    expect(dialog.style.getPropertyValue("--collection-create-visible-height")).toBe("900px");
    expect(dialog.style.getPropertyValue("--collection-create-visible-top")).toBe("0px");
    expect(name.value).toBe("手机新视图");
    await act(async () => { viewport.height = 480; viewport.dispatchEvent(new Event("resize")); });
    await click("看板", body); await click("创建视图", footer);
    expect(viewport.height).toBe(480); expect(model.view).toMatchObject({ name: "手机新视图", layout: "board" });
    expect(container.querySelector("dialog")).toBeNull();
  } finally { vi.unstubAllGlobals(); }
});
