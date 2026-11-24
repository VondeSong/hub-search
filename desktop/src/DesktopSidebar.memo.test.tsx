// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSidebar } from "./DesktopSidebar";
import type { LibrarySummary } from "./SearchTypes";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  window.localStorage.clear();
});

describe("DesktopSidebar render isolation", () => {
  it("keeps the library panel stable across unrelated sidebar updates", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const space: LibrarySummary = {
      id: "library-1",
      provider: "craft",
      name: "Car",
      connected: true,
      documentCount: 48,
      excludedPaths: [],
    };
    const renderLibraryIcon = vi.fn(() => <i>icon</i>);
    const props: ComponentProps<typeof DesktopSidebar> = {
      activeView: "home",
      smartCollections: [],
      activeSmartCollectionId: "",
      currentSearchCanBeSaved: false,
      spaces: [space],
      selectedLibraryIds: null,
      renderLibraryIcon,
      onSelectView: () => undefined,
      onToggleLibrary: () => undefined,
      onToggleAllLibraries: () => undefined,
      onManageLibraries: () => undefined,
      favoriteCount: 0,
      taskOpenCount: 0,
      journalCount: 0,
      journalDates: [],
      selectedJournalDate: "",
      onSelectJournalDate: () => undefined,
      historyCount: 0,
      flashcardDueCount: 0,
      tags: [],
      selectedTag: "",
      tagOverviewMode: "all",
      favoriteTags: [],
      recentTags: [],
      customTagGroups: [],
      tagProperties: {},
      tagsLoading: false,
      onSelectTagsOverview: () => undefined,
      onSelectCleanupTags: () => undefined,
      onSelectTag: () => undefined,
      onToggleFavoriteTag: () => undefined,
      onCreateTagGroup: () => undefined,
      onDeleteTagGroup: () => undefined,
      onAssignTagToGroup: () => undefined,
      onCreateSmartCollection: () => true,
      onApplySmartCollection: () => undefined,
      onRenameSmartCollection: () => true,
      onDeleteSmartCollection: () => undefined,
      onCollapse: () => undefined,
    };

    await act(async () => root.render(<DesktopSidebar {...props} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(1);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    expect(container.querySelector(".desktop-sidebar")?.dispatchEvent(contextMenu)).toBe(false);
    expect(contextMenu.defaultPrevented).toBe(true);

    await act(async () => root.render(<DesktopSidebar {...props} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<DesktopSidebar {...props} favoriteCount={1} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(1);

    await act(async () => root.render(<DesktopSidebar {...props} favoriteCount={1} selectedLibraryIds={[]} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(2);

    await act(async () => root.unmount());
  });

  it("keeps disclosure, selection, and management as distinct library actions", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const toggleAllLibraries = vi.fn();
    const manageLibraries = vi.fn();
    const props: ComponentProps<typeof DesktopSidebar> = {
      activeView: "home",
      smartCollections: [],
      activeSmartCollectionId: "",
      currentSearchCanBeSaved: false,
      spaces: [{ id: "library-1", provider: "craft", name: "Car", connected: true, documentCount: 48, excludedPaths: [] }],
      selectedLibraryIds: null,
      renderLibraryIcon: () => <i>icon</i>,
      onSelectView: () => undefined,
      onToggleLibrary: () => undefined,
      onToggleAllLibraries: toggleAllLibraries,
      onManageLibraries: manageLibraries,
      favoriteCount: 0,
      taskOpenCount: 0,
      journalCount: 0,
      journalDates: [],
      selectedJournalDate: "",
      onSelectJournalDate: () => undefined,
      historyCount: 0,
      flashcardDueCount: 0,
      tags: [],
      selectedTag: "",
      tagOverviewMode: "all",
      favoriteTags: [],
      recentTags: [],
      customTagGroups: [],
      tagProperties: {},
      tagsLoading: false,
      onSelectTagsOverview: () => undefined,
      onSelectCleanupTags: () => undefined,
      onSelectTag: () => undefined,
      onToggleFavoriteTag: () => undefined,
      onCreateTagGroup: () => undefined,
      onDeleteTagGroup: () => undefined,
      onAssignTagToGroup: () => undefined,
      onCreateSmartCollection: () => true,
      onApplySmartCollection: () => undefined,
      onRenameSmartCollection: () => true,
      onDeleteSmartCollection: () => undefined,
      onCollapse: () => undefined,
    };

    await act(async () => root.render(<DesktopSidebar {...props} />));
    const disclosure = container.querySelector<HTMLButtonElement>(".sidebar-library-disclosure")!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    await act(async () => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(toggleAllLibraries).not.toHaveBeenCalled();

    await act(async () => container.querySelector<HTMLButtonElement>(".sidebar-library-more")!.click());
    const menu = container.querySelector<HTMLElement>("[role=menu]")!;
    const menuButtons = Array.from(menu.querySelectorAll("button"));
    expect(menuButtons.map((button) => button.textContent)).toEqual(["取消全部选择", "管理资料库…"]);
    await act(async () => menuButtons[1].click());
    expect(manageLibraries).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=menu]")).toBeNull();

    await act(async () => root.unmount());
  });
});
