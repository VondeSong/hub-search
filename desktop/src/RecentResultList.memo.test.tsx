// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentResultList, type RecentResultListProps } from "./RecentResultList";
import type { SearchResult } from "./SearchTypes";

function result(index: number): SearchResult {
  return {
    id: `recent-${index}`,
    entityKey: `craft:recent:${index}`,
    documentId: `page-${index}`,
    blockId: `block-${index}`,
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: `最近结果 ${index}`,
    documentTitle: `最近结果 ${index}`,
    path: `Car/最近结果 ${index}`,
    snippet: "",
    matchTerms: [],
    matchField: "",
    matchCount: 0,
    modifiedAt: 1_700_000_000 + index,
    subMatches: [],
  };
}

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("RecentResultList row memoization", () => {
  it("rerenders only the previous and next selected rows", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const renderLibraryIcon = vi.fn(() => <span>icon</span>);
    const results = [result(0), result(1), result(2)];
    const stableProps: Omit<RecentResultListProps, "selectedIndex"> = {
      recentGroups: [{
        key: "recent",
        label: "最近浏览",
        entries: results.map((entry, index) => ({ result: entry, index })),
      }],
      isMobileLayout: false,
      semanticRecentDates: true,
      onHoverResult: () => undefined,
      onSelectResult: () => undefined,
      onOpenResult: () => undefined,
      onContextResult: () => undefined,
      onPrepareResultLink: () => undefined,
      onDragResult: () => undefined,
      renderLibraryIcon,
    };

    await act(async () => root.render(<RecentResultList {...stableProps} selectedIndex={0} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("最近结果 0");

    await act(async () => root.render(<RecentResultList {...stableProps} selectedIndex={1} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(5);
    expect(container.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain("最近结果 1");

    await act(async () => root.unmount());
  });

  it("does not render an orphan separator when a result has no useful path", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const item = result(0);
    item.libraryName = "";
    item.path = "";

    await act(async () => root.render(<RecentResultList
      recentGroups={[{ key: "today", label: "今天", entries: [{ result: item, index: 0 }] }]}
      selectedIndex={-1}
      isMobileLayout={false}
      semanticRecentDates
      onHoverResult={() => undefined}
      onSelectResult={() => undefined}
      onOpenResult={() => undefined}
      onContextResult={() => undefined}
      onPrepareResultLink={() => undefined}
      onDragResult={() => undefined}
      renderLibraryIcon={() => <span>icon</span>}
    />));

    expect(container.querySelector(".recent-separator")).toBeNull();
    expect(container.querySelector(".recent-path")).toBeNull();
    await act(async () => root.unmount());
  });

  it("visually distinguishes pages without body content", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const empty = result(0);
    const populated = { ...result(1), snippet: "页面正文" };

    await act(async () => root.render(<RecentResultList
      recentGroups={[{ key: "recent", label: "最近", entries: [{ result: empty, index: 0 }, { result: populated, index: 1 }] }]}
      selectedIndex={-1}
      isMobileLayout={false}
      semanticRecentDates
      onHoverResult={() => undefined}
      onSelectResult={() => undefined}
      onOpenResult={() => undefined}
      onContextResult={() => undefined}
      onPrepareResultLink={() => undefined}
      onDragResult={() => undefined}
      renderLibraryIcon={() => <span>icon</span>}
    />));

    expect(container.querySelectorAll(".recent-item.empty-content")).toHaveLength(1);
    expect(container.querySelector(".recent-item.empty-content")?.textContent).toContain("最近结果 0");
    await act(async () => root.unmount());
  });
});
