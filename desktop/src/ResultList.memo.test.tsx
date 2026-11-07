// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResultList, type ResultListProps } from "./ResultList";
import type { SearchResult } from "./SearchTypes";

function result(index: number): SearchResult {
  return {
    id: `result-${index}`,
    entityKey: `craft:page:${index}`,
    documentId: `page-${index}`,
    blockId: `block-${index}`,
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: `结果 ${index}`,
    documentTitle: `结果 ${index}`,
    path: `Car/结果 ${index}`,
    snippet: "",
    matchTerms: ["结果"],
    matchField: "title",
    matchCount: 1,
    subMatches: [],
  };
}

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("ResultList row memoization", () => {
  it("rerenders only the previous and next selected rows", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const renderLibraryIcon = vi.fn(() => <span>icon</span>);
    const results = [result(0), result(1), result(2)];
    const stableProps: Omit<ResultListProps, "selectedIndex"> = {
      query: "结果",
      results,
      isMobileLayout: false,
      onHoverResult: () => undefined,
      onSelectResult: () => undefined,
      onOpenResult: () => undefined,
      onContextResult: () => undefined,
      onPrepareResultLink: () => undefined,
      onDragResult: () => undefined,
      renderLibraryIcon,
    };

    await act(async () => root.render(<ResultList {...stableProps} selectedIndex={0} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(3);

    await act(async () => root.render(<ResultList {...stableProps} selectedIndex={1} />));
    expect(renderLibraryIcon).toHaveBeenCalledTimes(5);

    await act(async () => root.unmount());
  });
});
