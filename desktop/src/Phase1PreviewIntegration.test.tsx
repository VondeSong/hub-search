// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LibraryBrowse } from "./LibraryBrowse";
import { PreviewPane, type PreviewPaneProps } from "./PreviewPane";
import { TaskWorkspace } from "./TaskWorkspace";
import { UnifiedTaskProvider } from "./UnifiedTaskData";
import type { LibrarySummary, SearchResult } from "./SearchTypes";
import type { UnifiedTask } from "./TaskWorkspacePresentation";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  window.localStorage.clear();
  vi.clearAllMocks();
});

function baseResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    id: "doc-1",
    entityKey: "craft:doc-1",
    documentId: "doc-1",
    blockId: "doc-1",
    contentType: "document",
    sourceType: "craft_page",
    provider: "craft",
    libraryId: "lib-car",
    libraryName: "Car",
    spaceId: "lib-car",
    spaceName: "Car",
    title: "测试页面",
    documentTitle: "测试页面",
    path: "Car/测试页面",
    snippet: "",
    matchTerms: [],
    matchField: "title",
    matchCount: 0,
    subMatches: [],
    ...overrides,
  };
}

function basePreviewProps(overrides: Partial<PreviewPaneProps> = {}): PreviewPaneProps {
  return {
    selected: baseResult(),
    canGoBack: false,
    canGoForward: false,
    previewPinned: false,
    onNavigatePreviewHistory: () => undefined,
    onTogglePreviewPinned: () => undefined,
    selectedMatchTerms: [],
    previewMatchCount: 0,
    previewMatchIndex: 0,
    copiedResultId: "",
    spaces: [],
    pdfPreview: null,
    ocrImagePreview: null,
    previewLoading: false,
    renderedPreviewMarkdown: <p>测试正文</p>,
    onOpenLink: () => undefined,
    previewCard: createRef<HTMLElement>(),
    startWindowDrag: () => undefined,
    onCloseMobilePreview: () => undefined,
    setPdfPreviewPage: () => undefined,
    navigatePreviewMatch: () => undefined,
    copySelectedLink: () => undefined,
    openSelectedResult: () => undefined,
    providerName: (provider) => provider === "hub" ? "Hub" : "Craft",
    ...overrides,
  };
}

describe("Phase 1 preview & split integration", () => {
  it("merges moreMenuItems with wide-text toggle into one menu and hides hub favorites", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const onToggleFavorite = vi.fn();
    const onTogglePreviewFocus = vi.fn();
    await act(async () =>
      root.render(
        <PreviewPane
          {...basePreviewProps({
            onToggleFavorite,
            onTogglePreviewFocus,
            moreMenuItems: <button type="button" className="danger">保留 Craft，移除滴答</button>,
          })}
        />,
      ),
    );

    // Exactly one overflow menu combining custom task action + wide-text toggle
    const menus = container.querySelectorAll(".preview-more-menu");
    expect(menus).toHaveLength(1);
    expect(menus[0].textContent).toContain("保留 Craft，移除滴答");
    expect(menus[0].textContent).toContain("宽松行宽");
    expect(container.querySelector(".preview-favorite-btn")).not.toBeNull();
    expect(container.querySelector(".preview-focus-btn")).not.toBeNull();

    // Hub items must not show external-library page favorite star
    await act(async () =>
      root.render(
        <PreviewPane
          {...basePreviewProps({
            selected: baseResult({
              provider: "hub",
              contentType: "reading",
              libraryId: "@hub:reading",
              spaceId: "@hub:reading",
            }),
            onToggleFavorite,
            onTogglePreviewFocus,
          })}
        />,
      ),
    );
    expect(container.querySelector(".preview-favorite-btn")).toBeNull();
    expect(container.querySelector(".preview-focus-btn")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("renders resizable reader split and focus-mode Escape exit in LibraryBrowse", async () => {
    vi.mocked(invoke).mockResolvedValue({ folders: [], documents: [], craftLocationsSynced: true });
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const space: LibrarySummary = {
      id: "lib-car",
      provider: "craft",
      name: "Car",
      connected: true,
      documentCount: 12,
      excludedPaths: [],
    };
    const onExitFocusMode = vi.fn();
    const selected = baseResult();

    await act(async () =>
      root.render(
        <LibraryBrowse
          libraries={[space]}
          position={{ libraryId: "lib-car", folderId: "" }}
          onPosition={() => undefined}
          selected={selected}
          onPreview={() => undefined}
          onClosePreview={() => undefined}
          focusMode
          onExitFocusMode={onExitFocusMode}
          preview={<div>mock preview</div>}
        />,
      ),
    );

    const browser = container.querySelector<HTMLDivElement>(".library-browser")!;
    expect(browser.classList.contains("library-focus-mode")).toBe(true);

    const resizer = container.querySelector<HTMLDivElement>(".library-reader-resizer")!;
    const libraryBody = container.querySelector<HTMLDivElement>(".library-browser-body")!;
    libraryBody.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}),
    });
    resizer.getBoundingClientRect = () => ({
      left: 454, top: 0, right: 460, bottom: 700, width: 6, height: 700, x: 454, y: 0, toJSON: () => ({}),
    });
    expect(resizer).not.toBeNull();
    expect(resizer.getAttribute("aria-valuenow")).toBe("54");

    // Real pointer drag moves reader width from 54% to 62%
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 456, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 376, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 376, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("62");
    expect(window.localStorage.getItem("hub.library-browse.reader-percent.v1")).toBe("62");

    // Off-center single click inside the 6px hit zone must NOT shift width
    resizer.getBoundingClientRect = () => ({
      left: 374, top: 0, right: 380, bottom: 700, width: 6, height: 700, x: 374, y: 0, toJSON: () => ({}),
    });
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 375, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 375, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("62");
    expect(window.localStorage.getItem("hub.library-browse.reader-percent.v1")).toBe("62");

    // Off-center double click resets back to default 54%
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 375, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 375, bubbles: true }));
      resizer.dispatchEvent(new MouseEvent("dblclick", { clientX: 375, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("54");
    expect(window.localStorage.getItem("hub.library-browse.reader-percent.v1")).toBe("54");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("56");
    expect(window.localStorage.getItem("hub.library-browse.reader-percent.v1")).toBe("56");

    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("54");

    await act(async () => {
      browser.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onExitFocusMode).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("wires task preview favorites, focus mode, merged more menu, and split resizer", async () => {
    const linkedTask: UnifiedTask = {
      id: "craft:task-1",
      provider: "craft",
      libraryId: "lib-car",
      libraryName: "Car",
      sourceId: "block-1",
      documentId: "doc-task-1",
      documentTitle: "底盘试装",
      path: "Car/底盘试装",
      title: "核对卡扣顺序",
      status: "open",
      completed: false,
      isAllDay: true,
      parentTaskId: "",
      parentPageId: "doc-task-1",
      depth: 0,
      isProject: false,
      linkedProviders: ["craft", "dida365"],
      syncState: "linked",
    };

    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === "list_unified_tasks") {
        return {
          tasks: [linkedTask],
          syncReviews: [],
          total: 1,
          open: 1,
          completed: 0,
          craft: 1,
          dida365: 0,
          obsidian: 0,
          linked: 1,
        };
      }
      if (command === "local_document") {
        return "# 底盘试装\n\n## 卡扣检查\n\n核对左前门卡扣顺序。";
      }
      return undefined;
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);
    const onToggleFavorite = vi.fn(() => "added" as const);
    const onToggleSnippetFavorite = vi.fn(() => "added" as const);

    await act(async () =>
      root.render(
        <UnifiedTaskProvider dataVersion="phase1-test">
          <TaskWorkspace
            desktopSidebarVisible
            favoriteIds={new Set()}
            snippetFavoriteIds={new Set()}
            onToggleFavorite={onToggleFavorite}
            onToggleSnippetFavorite={onToggleSnippetFavorite}
          />
        </UnifiedTaskProvider>,
      ),
    );

    const row = container.querySelector<HTMLElement>(".task-row")!;
    expect(row).not.toBeNull();
    await act(async () => row.click());

    // Resizer supports real drag, ignores off-center single click, and resets on off-center double click
    const taskBody = container.querySelector<HTMLDivElement>(".task-workspace-body")!;
    const resizer = container.querySelector<HTMLDivElement>(".task-workspace-body > .pane-resizer")!;
    taskBody.getBoundingClientRect = () => ({
      left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, x: 0, y: 0, toJSON: () => ({}),
    });
    resizer.getBoundingClientRect = () => ({
      left: 554, top: 0, right: 560, bottom: 700, width: 6, height: 700, x: 554, y: 0, toJSON: () => ({}),
    });
    expect(resizer).not.toBeNull();
    expect(resizer.getAttribute("aria-valuenow")).toBe("44");

    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 555, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX: 455, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 455, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("54");
    expect(window.localStorage.getItem("hub.tasks.preview-percent.v1")).toBe("54");

    // Off-center single click does not alter width
    resizer.getBoundingClientRect = () => ({
      left: 454, top: 0, right: 460, bottom: 700, width: 6, height: 700, x: 454, y: 0, toJSON: () => ({}),
    });
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 455, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 455, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("54");

    // Off-center double click resets to 44%
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("pointerdown", { clientX: 455, bubbles: true }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX: 455, bubbles: true }));
      resizer.dispatchEvent(new MouseEvent("dblclick", { clientX: 455, bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("44");

    await act(async () => {
      resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("46");
    expect(window.localStorage.getItem("hub.tasks.preview-percent.v1")).toBe("46");
    await act(async () => {
      resizer.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(resizer.getAttribute("aria-valuenow")).toBe("44");

    // Favorite star and merged more menu (single menu with both Craft unlink + wide text)
    const favBtn = container.querySelector<HTMLButtonElement>(".task-preview-pane .preview-favorite-btn")!;
    expect(favBtn).not.toBeNull();
    await act(async () => favBtn.click());
    expect(onToggleFavorite).toHaveBeenCalledTimes(1);

    const moreMenus = container.querySelectorAll(".task-preview-pane .preview-more-menu");
    expect(moreMenus).toHaveLength(1);
    expect(moreMenus[0].textContent).toContain("保留 Craft，移除滴答");
    expect(moreMenus[0].textContent).toContain("宽松行宽");

    // Focus mode toggles on click and exits on Escape
    const focusBtn = container.querySelector<HTMLButtonElement>(".task-preview-pane .preview-focus-btn")!;
    await act(async () => focusBtn.click());
    const body = container.querySelector<HTMLDivElement>(".task-workspace-body")!;
    expect(body.classList.contains("task-focus-mode")).toBe(true);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(body.classList.contains("task-focus-mode")).toBe(false);

    await act(async () => root.unmount());
  });

  it("collapses search workspace grid to single track and centers focus-mode paper across all four workspaces", async () => {
    const fsSpec = "node:fs";
    const { existsSync, readFileSync } = await import(/* @vite-ignore */ fsSpec) as {
      existsSync: (path: string) => boolean;
      readFileSync: (path: string, encoding: string) => string;
    };
    const cssPath = existsSync("src/BaseWhiteTheme.css")
      ? "src/BaseWhiteTheme.css"
      : "desktop/src/BaseWhiteTheme.css";
    const baseWhiteCss = readFileSync(cssPath, "utf8");
    expect(baseWhiteCss).toContain(".workspace.with-preview.preview-focus-mode");
    expect(baseWhiteCss).toContain(".unified-shell .workspace.with-preview.preview-focus-mode");
    expect(baseWhiteCss).toContain(".workspace.with-preview.preview-focus-mode:has(.agent-panel:not([hidden]))");
    expect(baseWhiteCss).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(baseWhiteCss).toContain("grid-column: 1 / -1;");
    expect(baseWhiteCss).toContain(".collections-workspace .collection-body.reading-focus-mode > .collection-detail.preview-pane:not(:has(> .agent-panel:not([hidden]))) > .preview-card");
    expect(baseWhiteCss).toContain(".task-workspace-body.task-focus-mode > .task-preview-pane:not(:has(> .agent-panel:not([hidden]))) > .preview-card");
    expect(baseWhiteCss).toContain(".library-browser.library-focus-mode .library-browser-reader > .preview-pane:not(:has(> .agent-panel:not([hidden]))) > .preview-card");
    expect(baseWhiteCss).toContain(".library-browser-body.library-browser-reading:not(:has(> .library-browser-reader[hidden])) > .library-browser-reader");
    expect(baseWhiteCss).toContain("margin-inline: auto;");
    // TOC popover & LibraryBrowse preview-actions overflow/button specificity checks
    expect(baseWhiteCss).toContain("overflow: visible;");
    expect(baseWhiteCss).toContain(".preview-actions .preview-toc-wrap > button.preview-toc-trigger.active");
    expect(baseWhiteCss).toContain(".desktop-app-shell .preview-actions .preview-toc-popover button.preview-toc-item");
    expect(baseWhiteCss).toContain("display: block;");
    expect(baseWhiteCss).toContain("text-overflow: ellipsis;");
    expect(baseWhiteCss).toContain("white-space: nowrap;");
    expect(baseWhiteCss).toContain(".preview-toc-popover button.preview-toc-item.level-2");
    expect(baseWhiteCss).toContain(".preview-toc-popover button.preview-toc-item.level-3");
    expect(baseWhiteCss).toContain(".desktop-app-shell .library-browser-reader .preview-actions .preview-more-menu > div button");
  });
});
