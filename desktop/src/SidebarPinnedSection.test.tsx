// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_PINS_KEY,
  SIDEBAR_RECENT_COLLAPSED_KEY,
  SidebarPinnedSection,
} from "./SidebarPinnedSection";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { SmartCollection } from "./SmartCollections";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  window.localStorage.clear();
});

function sampleSpace(): LibrarySummary {
  return {
    id: "lib-car",
    provider: "craft",
    name: "Car",
    connected: true,
    documentCount: 48,
    excludedPaths: [],
  };
}

function sampleCollection(): SmartCollection {
  return {
    id: "col-harness",
    name: "线束专题",
    query: "线束",
    libraryIds: null,
    folderId: "",
    folderLabel: "",
    dateFilter: "any",
    sourceFilters: { craft: false, task: false, pdf: false, media: false, attachment: false },
    searchScope: "all",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

function sampleResult(id = "doc-1", title = "左前门线束规格"): SearchResult {
  return {
    id,
    entityKey: `craft:${id}`,
    documentId: id,
    blockId: id,
    contentType: "document",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "lib-car",
    libraryName: "Car",
    spaceId: "lib-car",
    spaceName: "Car",
    title,
    documentTitle: title,
    path: `Car/${title}`,
    snippet: "",
    matchTerms: [],
    matchField: "title",
    matchCount: 0,
    subMatches: [],
  };
}

describe("SidebarPinnedSection", () => {
  it("pins libraries, collections, and favorite docs with persistence and unpin support", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const onOpenPinnedLibrary = vi.fn();
    const onApplySmartCollection = vi.fn();
    const onOpenPinnedResult = vi.fn();
    const space = sampleSpace();
    const collection = sampleCollection();
    const fav = sampleResult();

    await act(async () =>
      root.render(
        <SidebarPinnedSection
          spaces={[space]}
          smartCollections={[collection]}
          favoriteResults={[fav]}
          onApplySmartCollection={onApplySmartCollection}
          onOpenPinnedLibrary={onOpenPinnedLibrary}
          onOpenPinnedResult={onOpenPinnedResult}
        />,
      ),
    );

    expect(container.querySelector(".sidebar-pin-empty")).not.toBeNull();

    // Open picker and pin library
    const addBtn = container.querySelector<HTMLButtonElement>(".sidebar-pin-add-btn")!;
    await act(async () => addBtn.click());
    const pickerItems = Array.from(container.querySelectorAll<HTMLButtonElement>(".sidebar-pin-picker-item"));
    expect(pickerItems.map((el) => el.textContent)).toEqual(["Car", "线束专题", "左前门线束规格"]);

    await act(async () => pickerItems[0].click());
    expect(container.querySelector(".sidebar-pin-picker")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_PINS_KEY) ?? "[]")).toHaveLength(1);

    // Pin smart collection and result
    await act(async () => addBtn.click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".sidebar-pin-picker-item")[0].click());
    await act(async () => addBtn.click());
    await act(async () => container.querySelectorAll<HTMLButtonElement>(".sidebar-pin-picker-item")[0].click());

    const openButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".sidebar-pin-open"));
    expect(openButtons.map((el) => el.textContent)).toEqual(["Car", "线束专题", "左前门线束规格"]);

    await act(async () => openButtons[0].click());
    expect(onOpenPinnedLibrary).toHaveBeenCalledWith("lib-car");
    await act(async () => openButtons[1].click());
    expect(onApplySmartCollection).toHaveBeenCalledWith(collection);
    await act(async () => openButtons[2].click());
    expect(onOpenPinnedResult).toHaveBeenCalledWith(fav);

    // Unpin the first item
    await act(async () => container.querySelector<HTMLButtonElement>(".sidebar-pin-remove")!.click());
    expect(container.querySelectorAll(".sidebar-pin-row")).toHaveLength(2);
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_PINS_KEY) ?? "[]")).toHaveLength(2);

    await act(async () => root.unmount());
  });

  it("keeps recently opened collapsed by default and persists toggle state", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const onOpenPinnedResult = vi.fn();
    const recent = sampleResult("recent-1", "最近查看的文档");

    await act(async () =>
      root.render(
        <SidebarPinnedSection
          spaces={[]}
          smartCollections={[]}
          viewHistory={[recent]}
          onApplySmartCollection={() => undefined}
          onOpenPinnedResult={onOpenPinnedResult}
        />,
      ),
    );

    const toggle = container.querySelector<HTMLButtonElement>(".sidebar-recent-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".sidebar-recent-list")).toBeNull();

    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem(SIDEBAR_RECENT_COLLAPSED_KEY)).toBe("false");

    const item = container.querySelector<HTMLButtonElement>(".sidebar-recent-open")!;
    expect(item.textContent).toBe("最近查看的文档");
    await act(async () => item.click());
    expect(onOpenPinnedResult).toHaveBeenCalledWith(recent);

    await act(async () => root.unmount());
  });
});
