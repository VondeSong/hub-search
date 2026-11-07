// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SearchFilterSummary } from "./FilterBar";
it("shows exclusions explicitly and resets filters without changing library scope", async () => {
  const host = document.createElement("div"); document.body.appendChild(host); const root = createRoot(host);
  const props: ComponentProps<typeof SearchFilterSummary> = {
    activeSpaces: [], spaces: [], folders: [], selectedLibraryIds: ["one"],
    dateFilter: "7", folderId: "folder", searchScope: "title", sourceFilters: { craft: true, task: true, pdf: false, media: true, attachment: true },
    dateMenuOpen: false, folderMenuOpen: false, searchScopeMenuOpen: false, syncing: false,
    refreshIndex: vi.fn(), startWindowDrag: vi.fn(), setDateFilter: vi.fn(), setDateMenuOpen: vi.fn(), setFolderId: vi.fn(), setFolderMenuOpen: vi.fn(), setSearchScope: vi.fn(), setSearchScopeMenuOpen: vi.fn(), setSourceFilters: vi.fn(),
  };
  try {
    await act(async () => root.render(<SearchFilterSummary {...props} />));
    expect(host.textContent).toContain("排除PDF"); expect(host.textContent).toContain("最近 7 天");
    await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "清除筛选")!.click());
    expect(props.setDateFilter).toHaveBeenCalledWith("any"); expect(props.setFolderId).toHaveBeenCalledWith(""); expect(props.setSearchScope).toHaveBeenCalledWith("all");
    expect(props.selectedLibraryIds).toEqual(["one"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
