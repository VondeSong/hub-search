// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
import type { SearchResult } from "./SearchTypes";
const { platform } = vi.hoisted(() => ({ platform: { platform: "windows" } }));
vi.mock("./RuntimePlatform", () => ({ runtimeCapabilities: platform }));

function result(): SearchResult {
  return {
    id: "preview-result",
    entityKey: "craft:preview:result",
    documentId: "page",
    blockId: "block",
    contentType: "craft_subpage",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "library",
    libraryName: "Car",
    spaceId: "space",
    spaceName: "Car",
    title: "预览页面",
    documentTitle: "预览页面",
    path: "Car/预览页面",
    snippet: "",
    matchTerms: ["预览"],
    matchField: "title",
    matchCount: 1,
    subMatches: [],
  };
}

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
});

describe("PreviewPane memoization", () => {
  it("skips an equivalent parent update and reacts to visible state changes", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const providerName = vi.fn(() => "Craft");
    const props: PreviewPaneProps = {
      selected: result(),
      canGoBack: false,
      canGoForward: false,
      previewPinned: false,
      onNavigatePreviewHistory: () => undefined,
      onTogglePreviewPinned: () => undefined,
      selectedMatchTerms: ["预览"],
      previewMatchCount: 0,
      previewMatchIndex: 0,
      copiedResultId: "",
      spaces: [],
      pdfPreview: null,
      ocrImagePreview: null,
      previewLoading: false,
      renderedPreviewMarkdown: <p>正文</p>,
      onOpenLink: () => undefined,
      previewCard: createRef<HTMLElement>(),
      startWindowDrag: () => undefined,
      onCloseMobilePreview: () => undefined,
      setPdfPreviewPage: () => undefined,
      navigatePreviewMatch: () => undefined,
      copySelectedLink: () => undefined,
      openSelectedResult: () => undefined,
      providerName,
    };

    await act(async () => root.render(<PreviewPane {...props} />));
    const initialCalls = providerName.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    await act(async () => root.render(<PreviewPane {...props} />));
    expect(providerName).toHaveBeenCalledTimes(initialCalls);

    await act(async () => root.render(<PreviewPane {...props} copiedResultId="preview-result" />));
    expect(providerName.mock.calls.length).toBeGreaterThan(initialCalls);

    await act(async () => root.render(<PreviewPane {...props} previewMatchCount={2} previewMatchIndex={0} canGoBack canGoForward />));
    expect(container.querySelector('.preview-actions > button[aria-label="上一个命中"]')).not.toBeNull();
    expect(container.querySelector('.preview-actions > button[aria-label="上一个预览"]')).not.toBeNull();
    expect(container.querySelector('.preview-actions > button[aria-label="固定预览"]')).not.toBeNull();
    expect(container.querySelector(".preview-more-menu")).toBeNull();

    await act(async () => root.render(<PreviewPane {...props} previewMatchCount={2} pdfPreview={{ text: "PDF", pageNumber: 1, pageCount: 2, sourceType: "pdf_native" }} />));
    expect(container.querySelector(".preview-more-menu")?.textContent).toContain("下一页");
    expect(container.querySelector(".preview-more-menu")?.textContent).not.toContain("上一个命中");
    expect(container.querySelector<HTMLButtonElement>(".preview-open-action")?.disabled).toBe(false);
    const desktopOpen = vi.fn();
    await act(async () => root.render(<PreviewPane {...props} openSelectedResult={desktopOpen} />));
    await act(async () => container.querySelector<HTMLButtonElement>(".preview-open-action")!.click());
    expect(desktopOpen).toHaveBeenCalledWith(props.selected, "preview");
    platform.platform = "android";
    const openSource = vi.fn();
    await act(async () => root.render(<PreviewPane {...props} openSelectedResult={openSource} />));
    const sourceButton = container.querySelector<HTMLButtonElement>(".preview-open-action")!;
    expect(sourceButton.disabled).toBe(false);
    await act(async () => sourceButton.click());
    expect(openSource).toHaveBeenCalledWith(props.selected, "preview");
    platform.platform = "windows";

    const openLink = vi.fn();
    await act(async () => root.render(<PreviewPane {...props}
      selected={{ ...result(), provider: "dida365", title: "[任务标题](https://dida365.com/webapp/#p/task)", documentTitle: "[任务标题](https://dida365.com/webapp/#p/task)", taskStatus: 0 }}
      previewMarkdown={"# [任务标题](https://dida365.com/webapp/#p/task)\n\n**状态：** 已完成"}
      onOpenLink={openLink}
    />));
    await act(async () => vi.dynamicImportSettled());
    expect(container.querySelector(".preview-heading .preview-task-status")?.getAttribute("aria-label")).toBe("已完成");
    expect(container.querySelector(".preview-heading .preview-task-status svg circle")).not.toBeNull();
    expect(container.querySelector(".preview-heading .preview-task-status svg path")).not.toBeNull();
    const titleLink = container.querySelector<HTMLAnchorElement>(".preview-heading h1 a");
    expect(titleLink?.textContent).toBe("任务标题");
    await act(async () => titleLink?.click());
    expect(openLink).toHaveBeenCalledWith("https://dida365.com/webapp/#p/task");

    const content = container.querySelector<HTMLDivElement>(".preview-content")!;
    Object.defineProperties(content, {
      scrollTop: { value: 300, writable: true },
      clientHeight: { value: 500 },
      scrollHeight: { value: 1600 },
      scrollTo: { value: vi.fn() },
    });
    await act(async () => content.dispatchEvent(new Event("scroll", { bubbles: true })));
    const topButton = container.querySelector<HTMLButtonElement>(".preview-scroll-top");
    expect(topButton?.getAttribute("aria-label")).toBe("回到预览顶部");
    await act(async () => topButton?.click());
    expect(content.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });

    await act(async () => root.unmount());
  });
});
