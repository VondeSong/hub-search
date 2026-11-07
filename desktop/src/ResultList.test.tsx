import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResultList } from "./ResultList";
import type { SearchResult } from "./SearchTypes";

function pathMatchResult(): SearchResult {
  return {
    id: "craft-child",
    entityKey: "craft:page:child",
    documentId: "child",
    blockId: "child",
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: "麦克风",
    documentTitle: "麦克风",
    path: "Car/项目/T29/麦克风",
    snippet: "",
    matchTerms: ["T29"],
    matchField: "path",
    matchCount: 1,
    subMatches: [],
  };
}

describe("ResultList", () => {
  it("highlights a query matched only in the compact path", () => {
    const html = renderToStaticMarkup(
      <ResultList
        query="T29"
        results={[pathMatchResult()]}
        selectedIndex={0}
        isMobileLayout={false}
        onHoverResult={() => undefined}
        onSelectResult={() => undefined}
        onOpenResult={() => undefined}
        onContextResult={() => undefined}
        onPrepareResultLink={() => undefined}
        onDragResult={() => undefined}
        renderLibraryIcon={() => <span>icon</span>}
      />,
    );

    expect(html).toContain('<mark>T29</mark>');
    expect(html).toContain("麦克风");
    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
  });
});
