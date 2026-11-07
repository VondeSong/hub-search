// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { COLLECTION_VIEWS_KEY, LEGACY_COLLECTION_VIEWS_KEY, CollectionViewsProvider, defaultCollectionView, parseCollectionViews, useCollectionViews, type CollectionViewsContextValue } from "./CollectionViews";

let container: HTMLDivElement;
let root: Root;
let model: CollectionViewsContextValue;
function Probe() { model = useCollectionViews(); return <span>{model.view.name}</span>; }
beforeEach(() => {
  localStorage.clear();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const legacyView = (id: string, name: string, layout: "list" | "table" | "board" | "gallery" = "list") => ({ ...defaultCollectionView(layout), id, name });

it("starts with no invented custom views and recovers malformed stores", () => {
  const initial = parseCollectionViews(null);
  expect(initial.views).toEqual([]);
  expect(initial.activeEntry).toEqual({ kind: "builtin", id: "all" });
  expect(initial.librariesCollapsed).toBe(true);
  expect(parseCollectionViews("{broken", "also broken")).toEqual(initial);
});

it("retains customized layout filters and the active archive configuration during migration", () => {
  const legacy = JSON.stringify({ active: "archive", views: [
    { ...legacyView("list", "列表"), source: "bookmarks" },
    { ...legacyView("table", "表格", "table"), widths: { title: 713 }, density: "compact", columns: { ...defaultCollectionView().columns, author: false } },
    { ...legacyView("archive", "归档"), status: "archived", source: "telegram", media: "video" },
    { ...legacyView("mine", "学习资料", "gallery"), status: "unread", sorts: [{ id: "s", field: "published", ascending: true }], cards: { size: "spacious", hidden: ["published"], rules: [] } },
  ] });
  const migrated = parseCollectionViews(null, legacy);
  expect(migrated.view).toMatchObject({ id: "archive", source: "telegram", status: "archived", media: "video" });
  expect(migrated.activeEntry).toEqual({ kind: "view", id: "archive" });
  expect(migrated.views.map(view => view.id)).toEqual(["list", "archive", "mine"]);
  expect(migrated.layoutPreferences.table).toMatchObject({ widths: { title: 713 }, density: "compact", columns: { author: false } });
  expect(migrated.views[2]).toMatchObject({ cards: { size: "spacious", hidden: ["published"] }, sorts: [{ field: "published", ascending: true }] });
});

it("keeps default display configurations without turning them into custom navigation entries", () => {
  const legacy = JSON.stringify({ active: "table", views: [
    legacyView("list", "列表"), { ...legacyView("table", "表格", "table"), widths: { title: 600 }, density: "compact" },
    legacyView("board", "看板", "board"), legacyView("gallery", "画廊", "gallery"), { ...legacyView("archive", "归档"), status: "archived" },
  ] });
  const migrated = parseCollectionViews(null, legacy);
  expect(migrated.views).toEqual([]);
  expect(migrated.layoutPreferences.table?.widths?.title).toBe(600);
  expect(migrated.view.layout).toBe("table");
});

it("does not remigrate legacy views after the independent store is saved", async () => {
  const legacy = JSON.stringify({ active: "list", views: [legacyView("list", "列表")] });
  localStorage.setItem(LEGACY_COLLECTION_VIEWS_KEY, legacy);
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => { model.updateView({ source: "telegram", query: "已保存", tags: ["AI"], dateFilter: "7" }); model.saveView("新视图"); });
  const persisted = localStorage.getItem(COLLECTION_VIEWS_KEY)!;
  expect(parseCollectionViews(persisted, legacy).views[0]).toMatchObject({ name: "新视图", source: "telegram", query: "已保存", tags: ["AI"], dateFilter: "7" });
  expect(localStorage.getItem(LEGACY_COLLECTION_VIEWS_KEY)).toBe(legacy);
});

it("persists the Dida reading source in saved views and active navigation", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => { model.updateView({ source: "dida" }); model.saveView("滴答稍后读"); });
  const restored = parseCollectionViews(localStorage.getItem(COLLECTION_VIEWS_KEY));
  expect(restored.view.source).toBe("dida");
  expect(restored.views[0]).toMatchObject({ name: "滴答稍后读", source: "dida" });
});

it("changes navigation conditions while preserving source, layout and the selected preview", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => { model.updateView({ source: "likes", layout: "gallery", media: "photo" }); model.updateSession({ selectedKey: "saved", previewEnabled: false, offset: 120, scrollTop: 680 }); });
  await act(async () => model.selectLibrary("craft-main"));
  expect(model.view).toMatchObject({ source: "likes", layout: "gallery", media: "photo", destinationId: "craft-main", status: "all" });
  expect(model.session).toEqual({ selectedKey: "saved", previewEnabled: false, offset: 0, scrollTop: 0 });
  await act(async () => model.selectBuiltin("unread"));
  expect(model.view).toMatchObject({ source: "likes", layout: "gallery", destinationId: "", attentionOnly: false, status: "unread" });
});

it("keeps saved conditions unchanged until update and supports hide, restore, reorder and delete", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => model.saveView("阅读"));
  const first = model.views[0].id;
  await act(async () => model.updateView({ status: "unread", query: "资料" }));
  expect(model.isModified).toBe(true);
  expect(model.views[0].query).toBe("");
  await act(async () => model.updateSavedView());
  expect(model.isModified).toBe(false);
  expect(model.views[0].status).toBe("unread");
  await act(async () => model.saveView("第二项"));
  const second = model.views[1].id;
  await act(async () => model.moveView(second, -1));
  expect(model.views.map(view => view.id)).toEqual([second, first]);
  await act(async () => model.setViewHidden(second, true));
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "all" });
  expect(model.views[0].hidden).toBe(true);
  await act(async () => { model.setViewHidden(second, false); model.selectView(second); });
  expect(model.activeEntry).toEqual({ kind: "view", id: second });
  await act(async () => model.deleteView(second));
  expect(model.views.map(view => view.id)).toEqual([first]);
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "all" });
});

it("keeps callback identities stable when counts and session change", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  const callbacks = [model.updateView, model.setNavigationCounts, model.selectView, model.updateSession];
  await act(async () => { model.setNavigationCounts({ all: 10, unread: 7, inProgress: 1, read: 2, archived: 1, abandoned: 0, needsAttention: 2, savedCopies: [] }); model.updateSession({ scrollTop: 400 }); });
  expect([model.updateView, model.setNavigationCounts, model.selectView, model.updateSession]).toEqual(callbacks);
});

it("updates built-in and library selection when their filter is changed or cleared", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => model.selectBuiltin("unread"));
  await act(async () => model.updateView({ status: "all" }));
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "all" });
  expect(model.view).toMatchObject({ id: "builtin:all", name: "全部内容" });
  await act(async () => model.updateView({ status: "read" }));
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "read" });
  await act(async () => model.selectLibrary("craft"));
  await act(async () => model.updateView({ destinationId: "" }));
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "all" });
  await act(async () => model.selectBuiltin("attention"));
  await act(async () => model.updateView({ attentionOnly: false }));
  expect(model.activeEntry).toEqual({ kind: "builtin", id: "all" });
});

it("keeps the saved-view selection while editing its filters", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => model.saveView("待读资料"));
  const id = model.views[0].id;
  await act(async () => model.updateView({ status: "read", destinationId: "craft", attentionOnly: true }));
  expect(model.activeEntry).toEqual({ kind: "view", id });
  expect(model.view.name).toBe("待读资料");
  expect(model.isModified).toBe(true);
  expect(model.views[0].status).toBe("all");
});

it("preserves session identity when receiving an unchanged scroll or preview value", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => model.updateSession({ scrollTop: 400, selectedKey: "selected" }));
  const session = model.session;
  await act(async () => model.updateSession({ scrollTop: 400, selectedKey: "selected" }));
  expect(model.session).toBe(session);
});

it("creates a view with a chosen layout atomically and retains inherited filters and display settings", async () => {
  await act(async () => root.render(<CollectionViewsProvider><Probe /></CollectionViewsProvider>));
  await act(async () => model.updateView({ source: "dida", query: "热管理", tags: ["汽车"], widths: { title: 700 }, density: "compact" }));
  await act(async () => model.updateSession({ offset: 120, scrollTop: 520 }));
  await act(async () => model.saveView("稍后学习", { layout: "gallery", id: "must-not-be-reused", name: "must-not-override-name" }));
  expect(model.views[0]).toMatchObject({ name: "稍后学习", layout: "gallery", source: "dida", query: "热管理", tags: ["汽车"], widths: { title: 700 }, density: "compact" });
  expect(model.view.id).not.toBe("must-not-be-reused");
  expect(model.session).toMatchObject({ offset: 0, scrollTop: 0 });
  expect(parseCollectionViews(localStorage.getItem(COLLECTION_VIEWS_KEY)).view).toEqual(model.view);
});

it("accepts known condition colors and treats missing or unknown saved values as disabled", () => {
  const stored = (colorMode?: string) => JSON.stringify({ version: 2, view: { ...defaultCollectionView(), colorMode }, views: [] });
  expect(parseCollectionViews(stored("status")).view.colorMode).toBe("status");
  expect(parseCollectionViews(stored("source")).view.colorMode).toBe("source");
  expect(parseCollectionViews(stored("future-value")).view.colorMode).toBeUndefined();
  expect(parseCollectionViews(stored()).view.colorMode).toBeUndefined();
});
