// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { browseFolderScope, browseSubpage, browseTrail, groupBrowseContents, LibraryBrowse, type LibraryPosition } from "./LibraryBrowse";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import { LIBRARY_BROWSE_STATE_KEY, LIBRARY_TOPICS_KEY } from "./LibraryBrowseState";

const invoke = vi.hoisted(() => vi.fn());
const profile = vi.hoisted(() => new Map<string, string>());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./UserProfileStorage", () => ({ USER_PROFILE_PREPARE_FLUSH_EVENT: "hub:prepare-user-profile-flush", userProfileStorage: {
  getItem: (key: string) => profile.get(key) ?? null,
  setItem: (key: string, value: string) => profile.set(key, value),
} }));
beforeEach(() => profile.clear());

it("keeps cyclic and missing-parent directories reachable without changing source metadata", () => {
  const folders = [{id:"a",name:"甲",parentId:"b"},{id:"b",name:"乙",parentId:"a"},{id:"c",name:"丙",parentId:"unknown"}];
  const before = JSON.stringify(folders);
  const tree = groupBrowseContents({folders,documents:[],craftLocationsSynced:true});
  expect(tree.children.get("")?.map(item => item.id).sort()).toEqual(["a","c"]);
  expect(browseTrail(tree,"b").map(item=>item.id)).toEqual(["a","b"]);
  expect(tree.detached.size).toBe(2);
  expect(JSON.stringify(folders)).toBe(before);
});

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

it("keeps folders reachable when cached parents are missing or cyclic", () => {
  const tree = groupBrowseContents({ ...contents, folders: [
    { id: "a", name: "目录 A", parentId: "b" },
    { id: "b", name: "目录 B", parentId: "a" },
    { id: "self", name: "自身循环", parentId: "self" },
    { id: "orphan", name: "缺少上级", parentId: "missing" },
    { id: "child", name: "正常下级", parentId: "b" },
  ] });
  const reachable = new Set<string>();
  const visit = (parent: string) => {
    for (const folder of tree.children.get(parent) ?? []) {
      expect(reachable.has(folder.id)).toBe(false);
      reachable.add(folder.id); visit(folder.id);
    }
  };
  visit("");
  expect(reachable.size).toBe(5);
  expect(browseTrail(tree, "child").map(node => node.id)).toEqual(["a", "b", "child"]);
  expect(browseFolderScope(tree, "a", true)).toEqual(["a", "b", "child"]);
  expect(tree.detached).toEqual(new Set(["a", "self", "orphan"]));
  expect(tree.nodes.get("a")?.parentId).toBe("b");
});

it("groups a deep cache iteratively and retains every document in its folder scope", () => {
  const folders = Array.from({ length: 10000 }, (_, index) => ({
    id: `folder-${index}`, name: `目录 ${index}`, parentId: index < 9999 ? `folder-${index + 1}` : undefined,
  }));
  const documents = Array.from({ length: 10000 }, (_, index) => ({
    id: `doc-${index}`, title: `文档 ${index}`, path: `${index}.md`, folderId: `folder-${index}`,
  }));
  const tree = groupBrowseContents({ folders, documents, craftLocationsSynced: false });
  expect(tree.detached.size).toBe(0);
  expect(browseTrail(tree, "folder-0")).toHaveLength(10000);
  expect(browseFolderScope(tree, "folder-9999", true)).toHaveLength(10000);
  expect(tree.pages.get("folder-0")?.[0].id).toBe("doc-0");
  expect(tree.documentFolders.size).toBe(10000);
});

it("locates each Feishu shortcut in its own folder while preserving one document identity", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const library: LibrarySummary = { id: "wiki", provider: "feishu", name: "知识空间", connected: true, documentCount: 1, excludedPaths: [] };
  invoke.mockResolvedValue({
    folders: [{ id: "original", name: "原位置" }, { id: "shortcut", name: "快捷方式位置" }],
    documents: [
      { id: "shared", nodeId: "original-node", title: "接口说明", path: "原位置/接口说明", folderId: "original" },
      { id: "shared", nodeId: "shortcut-node", title: "接口说明", path: "快捷方式位置/接口说明", folderId: "shortcut" },
    ], craftLocationsSynced: false,
  });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onPosition = vi.fn(), onPreview = vi.fn();
  try {
    await act(async () => root.render(<LibraryBrowse libraries={[library]} onPosition={onPosition}
      onPreview={onPreview} onClosePreview={vi.fn()} />));
    const rows = Array.from(container.querySelectorAll(".library-browser-result"));
    expect(rows).toHaveLength(2);
    const locate = rows[1].querySelector<HTMLButtonElement>(".library-browser-result-actions button")!;
    await act(async () => locate.click());
    expect(onPosition).toHaveBeenCalledWith({ libraryId: "wiki", folderId: "shortcut", documentId: "shared" });
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({
      documentId: "shared", entityKey: "wiki:wiki:shortcut-node:shared", folderId: "shortcut",
    }));
    await act(async () => root.render(<LibraryBrowse libraries={[library]} position={{ libraryId: "wiki", folderId: "shortcut" }}
      onPosition={onPosition} onPreview={onPreview} onClosePreview={vi.fn()} />));
    invoke.mockResolvedValueOnce([{
      id: "shared", documentId: "shared", spaceId: "wiki", provider: "feishu", title: "接口说明", folderId: "original",
    }]);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="在当前目录搜索"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "接口");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(invoke).toHaveBeenCalledWith("local_search", expect.objectContaining({ documentIds: ["shared"], folderIds: null }));
    const scopedLocate = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "定位")!;
    await act(async () => scopedLocate.click());
    expect(onPosition).toHaveBeenLastCalledWith({ libraryId: "wiki", folderId: "shortcut", documentId: "shared" });
  } finally {
    await act(async () => root.unmount()); invoke.mockReset();
  }
});

it("bounds initial folder rendering and can reveal a selected path beyond the first page", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previousScroll = Element.prototype.scrollIntoView;
  let scrolled: Element | undefined;
  Element.prototype.scrollIntoView = function () { scrolled = this; };
  const library: LibrarySummary = { id: "large", provider: "obsidian", name: "大库", connected: true, documentCount: 10000, excludedPaths: [] };
  const folders = Array.from({ length: 1000 }, (_, index) => ({ id: `folder-${index}`, name: `目录 ${String(index).padStart(4, "0")}` }));
  invoke.mockResolvedValue({ folders, documents: [], craftLocationsSynced: false });
  const container = document.createElement("div");
  const root = createRoot(container);
  const onPosition = vi.fn();
  const render = (position: LibraryPosition) => root.render(<LibraryBrowse libraries={[library]} position={position}
    onPosition={onPosition} onPreview={vi.fn()} onClosePreview={vi.fn()} />);
  try {
    await act(async () => render({ libraryId: library.id, folderId: "" }));
    const list = container.querySelector('[aria-label="当前目录内容"]')!;
    expect(list.querySelectorAll(".library-browser-row").length).toBe(100);
    const more = Array.from(list.querySelectorAll("button")).find(button => button.textContent === "显示更多目录")!;
    expect(more).toBeDefined();
    await act(async () => more.click());
    expect(list.querySelectorAll(".library-browser-row").length).toBe(200);
    await act(async () => render({ libraryId: library.id, folderId: "folder-999" }));
    const tree = container.querySelector('[aria-label="资料库目录"]')!;
    expect(tree.querySelector('[aria-current="location"]')?.textContent).toContain("目录 0999");
    expect(scrolled).toBe(tree.querySelector('[aria-current="location"]'));
    expect(tree.querySelectorAll("ul .library-browser-row").length).toBeLessThanOrEqual(201);
    const columnsButton = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "分栏浏览")!;
    await act(async () => columnsButton.click());
    const rootColumn = container.querySelectorAll(".library-browser-column")[1];
    expect(rootColumn.querySelector('[aria-current="location"]')?.textContent).toBe("目录 0999");
    expect(rootColumn.querySelectorAll(".library-browser-row")).toHaveLength(201);
  } finally {
    await act(async () => root.unmount()); invoke.mockReset();
    Element.prototype.scrollIntoView = previousScroll;
  }
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
    id: "nested", documentId: "nested", spaceId: library.id, provider: "obsidian", title: "搜索命中", path: "a/b/nested.md", folderId: "c",
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
      selected={{provider:"obsidian",libraryId:"vault",spaceId:"vault",documentId:"root",id:"root",entityKey:"root",title:"根文档"} as SearchResult}
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

it("uses root and page identities for exact Craft page search and opens a navigable page body", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
  const library = {id:"craft",provider:"craft",name:"Craft",connected:true,documentCount:1,excludedPaths:[]} as LibrarySummary;
  const documents = [{id:"root",title:"根",path:"根",folderId:"root-folder"},
    {id:"craft-subpage:root:child",title:"子页",path:"根",folderId:"child-folder",documentId:"root",pageId:"child",contentType:"craft_subpage"},
    {id:"craft-subpage:root:leaf",title:"下级页",path:"根",folderId:"child-folder",documentId:"root",pageId:"leaf",contentType:"craft_subpage"}];
  invoke.mockImplementation(async command => command === "library_contents" ? {folders:[{id:"root-folder",name:"根"},{id:"child-folder",name:"子页",parentId:"root-folder"}],documents,craftLocationsSynced:true,
    pageFolders:{"root-folder":"root","child-folder":"craft-subpage:root:child"}} : []);
  const container=document.createElement("div"), root=createRoot(container), onPreview=vi.fn();
  try {
    await act(async()=>root.render(<LibraryBrowse libraries={[library]} position={{libraryId:"craft",folderId:"child-folder"}} onPosition={vi.fn()}
      onPreview={onPreview} onClosePreview={vi.fn()} />));
    const input=container.querySelector<HTMLInputElement>('[aria-label="在当前目录搜索"]')!;
    await act(async()=>{
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"依据"); input.dispatchEvent(new Event("input",{bubbles:true}));
    });
    await act(async()=>container.querySelector(".library-browser-search")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    expect(invoke).toHaveBeenCalledWith("local_search",expect.objectContaining({documentIds:["root"],pageIds:["child","leaf"],folderIds:null}));
    const folderButton=Array.from(container.querySelectorAll<HTMLButtonElement>(".library-browser-tree button.library-browser-row")).find(button=>button.textContent==="子页")!;
    await act(async()=>folderButton.click());
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({documentId:"root",pageId:"child",contentType:"craft_subpage"}));
  } finally {await act(async()=>root.unmount());invoke.mockReset();}
});

it("persists a real topic reference and view state without writing to any source", async () => {
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
  const library={id:"vault",provider:"obsidian",name:"本地库",connected:true,documentCount:3,excludedPaths:[]} as LibrarySummary;
  invoke.mockResolvedValue(contents);
  const container=document.createElement("div"), root=createRoot(container);
  const button=(label:string)=>Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(item=>item.getAttribute("aria-label")===label || item.textContent===label)!;
  try {
    await act(async()=>root.render(<LibraryBrowse libraries={[library]} position={{libraryId:"vault",folderId:""}} onPosition={vi.fn()} onPreview={vi.fn()} onClosePreview={vi.fn()}/>));
    await act(async()=>button("新建专题").click());
    const input=container.querySelector<HTMLInputElement>('[aria-label="专题名称"]')!;
    await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"验收资料");input.dispatchEvent(new Event("input",{bubbles:true}));});
    await act(async()=>container.querySelector(".library-browser-topic-editor")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
    const add=Array.from(container.querySelectorAll<HTMLButtonElement>(".library-browser-result .library-browser-topic-menu button")).find(item=>item.textContent==="验收资料")!;
    await act(async()=>add.click());
    const saved=JSON.parse(profile.get(LIBRARY_TOPICS_KEY)!);
    expect(saved[0].items[0]).toEqual(expect.objectContaining({kind:"document",result:expect.objectContaining({libraryId:"vault"})}));
    expect(invoke.mock.calls.every(([command])=>command==="library_contents")).toBe(true);
    expect(JSON.parse(profile.get(LIBRARY_BROWSE_STATE_KEY)!)).toEqual(expect.objectContaining({mode:"tree",readerOpen:true}));
    const other={...library,id:"other",name:"其他库"};
    await act(async()=>root.render(<LibraryBrowse libraries={[library,other]} position={{libraryId:"other",folderId:""}}
      onPosition={vi.fn()} onPreview={vi.fn()} onClosePreview={vi.fn()}/>));
    expect(container.querySelector(".library-browser-shortcuts")?.textContent).toContain("验收资料1");
    await act(async()=>root.unmount());
    const restored=createRoot(container);
    try {
      await act(async()=>restored.render(<LibraryBrowse libraries={[library]} onPosition={vi.fn()} onPreview={vi.fn()} onClosePreview={vi.fn()}/>));
      expect(container.querySelector(".library-browser-shortcuts")?.textContent).toContain("验收资料1");
    } finally {await act(async()=>restored.unmount());}
  } finally {invoke.mockReset();}
});

it("groups a large directory snapshot within the local two-second budget", () => {
  const folders=Array.from({length:20000},(_,i)=>({id:String(i),name:`目录${i}`,parentId:i%10 ? String(i-i%10) : undefined}));
  const documents=folders.map(folder=>({id:`doc-${folder.id}`,title:"同名笔记",path:`${folder.id}/笔记.md`,folderId:folder.id}));
  const start=performance.now();
  const tree=groupBrowseContents({folders,documents,craftLocationsSynced:true});
  expect(tree.nodes.size).toBe(20000);
  expect(tree.documentFolders.size).toBe(20000);
  expect(performance.now()-start).toBeLessThan(2000);
});

it("restores the saved column scroll instead of jumping to the last column", async () => {
  Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT:true});
  profile.set(LIBRARY_BROWSE_STATE_KEY, JSON.stringify({mode:"columns", scroll:{
    [JSON.stringify(["vault", "a", false, "", "columns"])]: {list:0, tree:0, columns:72},
  }}));
  invoke.mockResolvedValue(contents);
  const container=document.createElement("div"), root=createRoot(container);
  const library={id:"vault",provider:"obsidian",name:"本地库",connected:true,documentCount:3,excludedPaths:[]} as LibrarySummary;
  try {
    await act(async()=>root.render(<LibraryBrowse libraries={[library]} position={{libraryId:"vault",folderId:"a"}}
      onPosition={vi.fn()} onPreview={vi.fn()} onClosePreview={vi.fn()}/>));
    expect(container.querySelector<HTMLElement>(".library-browser-columns")!.scrollLeft).toBe(72);
  } finally {await act(async()=>root.unmount());invoke.mockReset();}
});
