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
