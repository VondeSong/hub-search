// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SearchResultsPane } from "./SearchResultsPane";

vi.mock("./TagGovernanceInbox", () => ({ TagGovernanceInbox: () => null }));
vi.mock("./TagAssignmentInbox", () => ({ TagAssignmentInbox: () => null }));
vi.mock("./TagPropertiesCard", () => ({ TagPropertiesCard: () => null }));

it("keeps tag controls, focus and existing cards mounted during library refresh", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const noop = () => undefined;
  const props: ComponentProps<typeof SearchResultsPane> = {
    resultLabel: "标签 · 1", error: "", searching: false, query: "", results: [], recentGroups: [], selectedIndex: 0,
    isMobileLayout: false, semanticRecentDates: false, onHoverResult: noop, onSelectResult: noop,
    onOpenResult: noop, onPrepareResultLink: noop, onDragResult: noop, onCopyResultLink: noop,
    onCopyResultMarkdown: noop, onCopyResultTitle: noop, onCopyResultSummary: noop, onRevealResult: noop,
    canRevealResult: () => false, renderLibraryIcon: () => null, collectionView: "tags",
    collectionTags: [{ name: "共同标签", normalizedName: "共同标签", count: 2 }],
    tagLibraries: [{ id: "main", name: "Main", provider: "craft", connected: true, documentCount: 2, excludedPaths: [] }],
    onChangeTagLibraries: noop,
  };
  try {
    await act(async () => root.render(<SearchResultsPane {...props} />));
    const section = container.querySelector(".tag-overview");
    const card = container.querySelector(".tag-overview-grid button");
    const filter = container.querySelector<HTMLButtonElement>(".tag-library-filter button")!;
    filter.focus();
    await act(async () => root.render(<SearchResultsPane {...props} searching tagsLoading />));
    expect(container.querySelector(".tag-overview")).toBe(section);
    expect(container.querySelector(".tag-overview-grid button")).toBe(card);
    expect(document.activeElement).toBe(filter);
    expect(section?.getAttribute("aria-busy")).toBe("true");
    await act(async () => root.render(<SearchResultsPane {...props} collectionTags={[{ ...props.collectionTags![0], count: 1 }]} />));
    expect(container.querySelector(".tag-overview-grid button")).toBe(card);
    expect(card?.querySelector("small")?.textContent).toBe("1");
    expect(section?.getAttribute("aria-busy")).toBe("false");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
