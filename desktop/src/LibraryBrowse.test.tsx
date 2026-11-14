// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { browseFolderScope, browseSubpage, browseTrail, groupBrowseContents, LibraryBrowse, type LibraryPosition } from "./LibraryBrowse";
import type { LibrarySummary, SearchResult } from "./SearchTypes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

const contents = {
  folders: [
    { id: "a", name: "同名" },
    { id: "b", name: "同名", parentId: "a" },
    { id: "c", name: "同名" },
    { id: "orphan", name: "缺少上级", parentId: "missing" },
  ],
  documents: [
    { id: "root", title: "根文档", path: "root.md" },
    { id: "nested", title: "子目录文档", path: "a/b/nested.md", folderId: "b" },
    { id: "unresolved", title: "未定位文档", path: "", folderId: "missing" },
  ],
  craftLocationsSynced: false,
};

it("keeps duplicate names distinct and scopes results by identity", () => {
  const tree = groupBrowseContents(contents);
  expect(browseTrail(tree, "b").map(node => node.id)).toEqual(["a", "b"]);
  expect(browseFolderScope(tree, "a", true)).toEqual(["a", "b"]);
  expect(browseFolderScope(tree, "a", false)).toEqual(["a"]);
  expect(browseFolderScope(tree, "", false)).toEqual([""]);
  expect(browseFolderScope(tree, "", true)).toBeNull();
  expect(tree.children.get("")?.map(node => node.id)).toEqual(expect.arrayContaining(["a", "c", "orphan"]));
  expect(tree.documentFolders.has("unresolved")).toBe(false);
  expect(tree.unresolved.map(node => node.id)).toEqual(["unresolved"]);
});

it("loads a cached library, searches descendants and locates a preview inside its actual folder", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const library: LibrarySummary = { id: "vault", provider: "obsidian", name: "本地库", connected: false, documentCount: 3, excludedPaths: [] };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let position: LibraryPosition = { libraryId: library.id, folderId: "a" };
  let selected: SearchResult | undefined;
  invoke.mockImplementation(async command => command === "library_contents" ? contents : [{
    id: "nested", documentId: "nested", spaceId: library.id, provider: "obsidian", title: "搜索命中", path: "a/b/nested.md",
  }]);
  const render = () => root.render(<LibraryBrowse
    libraries={[library]} position={position} selected={selected}
    onPosition={next => { position = next; render(); }}
    onPreview={next => { selected = next; render(); }}
    onClosePreview={() => { selected = undefined; render(); }}
  />);
  const button = (label: string) => Array.from(container.querySelectorAll("button")).find(item => item.textContent === label)!;
  try {
    await act(async () => render());
    expect(container.textContent).toContain("正在浏览本地缓存");
    expect(invoke).toHaveBeenCalledWith("library_contents", { libraryId: library.id });
    const input = container.querySelector<HTMLInputElement>('input[aria-label="在当前目录搜索"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "命中");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(invoke).toHaveBeenCalledWith("local_search", expect.objectContaining({ folderIds: ["a", "b"], query: "命中" }));
    await act(async () => button("定位").click());
    expect(position.folderId).toBe("b");
    expect(selected?.documentId).toBe("nested");
    expect(container.textContent).toContain("子目录文档");
    expect(browseSubpage({ ...selected!, provider: "craft" }, "#craft-subpage=page-2", "子页面")).toEqual(expect.objectContaining({ blockId: "page-2", documentId: "nested", title: "子页面" }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invoke.mockReset();
  }
});

it("shows all libraries, opens real folder levels in column mode and restores the last folder when switching back", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const obsidian: LibrarySummary = { id: "vault", provider: "obsidian", name: "Obsidian 测试库", connected: true, documentCount: 3, excludedPaths: [] };
  const craft: LibrarySummary = { ...obsidian, id: "craft", provider: "craft", name: "Craft 测试库", documentCount: 0 };
  const libraries = [obsidian, craft];
  invoke.mockImplementation(async (_, args) => args.libraryId === obsidian.id ? contents : {
    folders: [], documents: [], craftLocationsSynced: true,
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  let position: LibraryPosition | undefined;
  let selected: SearchResult | undefined;
  const render = () => root.render(<LibraryBrowse libraries={libraries} position={position} selected={selected}
    onPosition={next => { position = next; render(); }} onPreview={next => { selected = next; render(); }}
    onClosePreview={() => { selected = undefined; render(); }} preview={selected && <article>原文预览</article>} />);
  const click = async (parent: ParentNode, label: string) => {
    const button = Array.from(parent.querySelectorAll("button")).find(item => item.textContent?.startsWith(label));
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  const columns = () => Array.from(container.querySelectorAll(".library-browser-column"));
  try {
    await act(async () => render());
    expect(container.textContent).toContain("尚未选择文档");
    expect(invoke.mock.calls.filter(([command]) => command === "library_contents")).toHaveLength(2);
    await click(container, "分栏浏览");
    expect(columns()).toHaveLength(1);
    await click(columns()[0], obsidian.name);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="快速定位目录"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "同名 / 同名");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(container.querySelector(".library-browser-tree")!, "同名");
    expect(position?.folderId).toBe("b");
    expect(columns()).toHaveLength(4);
    await click(columns()[3], "子目录文档");
    expect(container.querySelector('[aria-label="阅读区"]')?.textContent).toContain("原文预览");
    await click(columns()[0], craft.name);
    expect(columns()).toHaveLength(2);
    await click(columns()[0], obsidian.name);
    expect(position?.folderId).toBe("b");
    expect(invoke.mock.calls.filter(([command]) => command === "library_contents")).toHaveLength(2);
  } finally {
    await act(async () => root.unmount());
    invoke.mockReset();
  }
});

it("returns from a Craft subpage to the original document without changing the browse scope", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const library: LibrarySummary = { id: "craft", provider: "craft", name: "Craft 库", connected: true, documentCount: 1, excludedPaths: [] };
  const parent = {
    id: "root", entityKey: "root", contentType: "document", provider: "craft",
    libraryId: library.id, spaceId: library.id, documentId: "root", title: "根文档",
  } as SearchResult;
  invoke.mockResolvedValue({ ...contents, documents: [contents.documents[0]] });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onPosition = vi.fn();
  const onPreview = vi.fn();
  const render = (selected: SearchResult | undefined) => root.render(<LibraryBrowse
    libraries={[library]} onPosition={onPosition} selected={selected} onPreview={onPreview} onClosePreview={vi.fn()} />);
  const home = () => Array.from(container.querySelectorAll("button")).find(item => item.textContent === "返回文档首页");
  try {
    await act(async () => render(parent));
    expect(home()).toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("library_contents", { libraryId: library.id });
    const child = browseSubpage(parent, "#craft-subpage=child", "子页面");
    const grandchild = browseSubpage(child, "#craft-subpage=grandchild", "深层子页面");
    expect(grandchild).toEqual(expect.objectContaining({
      contentType: "craft_subpage", sourceType: "craft_page", documentId: "root", pageId: "grandchild",
    }));
    await act(async () => render(grandchild));
    expect(invoke).toHaveBeenCalledWith("library_contents", { libraryId: library.id });
    expect(home()).toBeDefined();
    await act(async () => home()!.click());
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({
      documentId: "root", blockId: "root", contentType: "document", title: "根文档",
    }));
    expect(onPosition).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    invoke.mockReset();
  }
});

it("browses cached documents across libraries, preserves a hidden preview and tolerates one unavailable library", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const library: LibrarySummary = { id: "vault", provider: "obsidian", name: "本地库", connected: false, documentCount: 3, excludedPaths: [] };
  const libraries = [library, { ...library, id: "unavailable", name: "暂不可用的库" }];
  invoke.mockImplementation(async (command, args) => {
    if (command !== "library_contents") throw new Error(`Unexpected command: ${command}`);
    if (args.libraryId !== library.id) throw new Error("来源暂不可用");
    return contents;
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onPreview = vi.fn();
  const onToggleFavorite = vi.fn();
  const onPosition = vi.fn();
  document.body.append(container);
  const button = (label: string) => Array.from(container.querySelectorAll("button"))
    .find(item => item.getAttribute("aria-label") === label || item.textContent === label)!;
  try {
    await act(async () => root.render(<LibraryBrowse libraries={libraries} onPosition={onPosition}
      onPreview={onPreview} onClosePreview={vi.fn()} onToggleFavorite={onToggleFavorite}
      preview={<article><input aria-label="预览内状态" defaultValue="保留阅读状态" /></article>} />));
    expect(container.querySelector('[aria-label="当前目录内容"]')?.textContent).toContain("子目录文档");
    expect(container.textContent).toContain("部分资料库读取失败");
    await act(async () => container.querySelector(".library-browser")!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(container.querySelector(".library-browser-search input"));
    await act(async () => button("收藏 根文档").click());
    expect(onToggleFavorite).toHaveBeenCalledWith(expect.objectContaining({ libraryId: "vault", documentId: "root" }));
    const reader = container.querySelector<HTMLElement>('[aria-label="阅读区"]')!;
    const previewInput = reader.querySelector("input");
    await act(async () => button("收起阅读区").click());
    expect(reader.hidden).toBe(true);
    expect(reader.querySelector("input")).toBe(previewInput);
    const documentButton = Array.from(container.querySelectorAll(".library-browser-result > button"))
      .find(item => item.textContent?.startsWith("根文档")) as HTMLButtonElement;
    await act(async () => documentButton.click());
    expect(reader.hidden).toBe(false);
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ documentId: "root" }));
    expect(reader.querySelector("input")).toBe(previewInput);
    await act(async () => button("定位").click());
    expect(onPosition).toHaveBeenCalledWith(expect.objectContaining({ libraryId: "vault", folderId: "", documentId: "root" }));
  } finally {
    await act(async () => root.unmount());
    container.remove();
    invoke.mockReset();
  }
});
