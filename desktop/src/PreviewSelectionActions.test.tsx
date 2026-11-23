// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreviewSelectionActions,
  type SelectionNotifyTone,
  type SelectionSnippetOutcome,
} from "./PreviewSelectionActions";
import {
  AgentPanelContext,
  AgentTextMaterialContext,
  type Entry,
  type TextMaterial,
} from "./StandaloneAgentLauncher";

const containers: HTMLElement[] = [];

afterEach(() => {
  containers.splice(0).forEach((container) => container.remove());
  document.getSelection()?.removeAllRanges();
  vi.restoreAllMocks();
});

function mockSelection(node: Node, text: string, top = 180) {
  const rect = { left: 120, top, right: 260, bottom: top + 20, width: 140, height: 20 };
  const range = {
    getClientRects: () => [rect],
    getBoundingClientRect: () => rect,
  };
  const removeAllRanges = vi.fn();
  vi.spyOn(document, "getSelection").mockReturnValue({
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: node,
    focusNode: node,
    toString: () => text,
    getRangeAt: () => range,
    removeAllRanges,
  } as unknown as Selection);
  return { removeAllRanges };
}

function setBox(element: HTMLElement) {
  element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function Harness({
  articleKey = "article-a",
  title = "测试文档",
  bodyText = "左前门卡扣顺序需核对现场试装记录。",
  isSnippetSaved,
  onSaveSnippet,
  onNotify,
  onOpenAgent,
  onSetPending,
}: {
  articleKey?: string;
  title?: string;
  bodyText?: string;
  isSnippetSaved?: (text: string) => boolean;
  onSaveSnippet?: (text: string) => SelectionSnippetOutcome;
  onNotify?: (msg: string, tone?: SelectionNotifyTone) => void;
  onOpenAgent: (entry: Entry) => void;
  onSetPending: (value: TextMaterial | null) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <AgentPanelContext.Provider value={(entry) => onOpenAgent(entry as Entry)}>
      <AgentTextMaterialContext.Provider
        value={{ selection: null, clearSelection: () => undefined, pending: null, setPending: onSetPending }}
      >
        <div ref={ref} key={articleKey} className="preview-content">
          <p className="body-copy">{bodyText}</p>
          <input className="editable-input" defaultValue="输入框内容" />
        </div>
        <PreviewSelectionActions
          scrollRef={ref}
          contentKey={articleKey}
          title={title}
          agentEntry={{ itemKey: articleKey, title }}
          isSnippetSaved={isSnippetSaved}
          onSaveSnippet={onSaveSnippet}
          onNotify={onNotify}
        />
      </AgentTextMaterialContext.Provider>
    </AgentPanelContext.Provider>
  );
}

describe("PreviewSelectionActions", () => {
  it("rebinds to new keyed DOM when switching from article A to article B", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const onNotify = vi.fn();
    const onOpenAgent = vi.fn();
    const onSetPending = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await act(async () =>
      root.render(
        <Harness
          articleKey="reading:a"
          title="文章 A"
          bodyText="文章 A 的正文段落。"
          onNotify={onNotify}
          onOpenAgent={onOpenAgent}
          onSetPending={onSetPending}
        />,
      ),
    );

    const regionA = container.querySelector<HTMLDivElement>(".preview-content")!;
    setBox(regionA);
    mockSelection(container.querySelector(".body-copy")!.firstChild!, "文章 A 的正文");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.body.querySelector(".preview-selection-pill")).not.toBeNull();

    // Switch to Article B (React unmounts regionA and mounts a new regionB on the same ref object)
    await act(async () =>
      root.render(
        <Harness
          articleKey="reading:b"
          title="文章 B"
          bodyText="文章 B 的全新正文内容。"
          onNotify={onNotify}
          onOpenAgent={onOpenAgent}
          onSetPending={onSetPending}
        />,
      ),
    );

    const regionB = container.querySelector<HTMLDivElement>(".preview-content")!;
    expect(regionB).not.toBe(regionA);
    // Stale pill from Article A is dismissed on switch
    expect(document.body.querySelector(".preview-selection-pill")).toBeNull();

    setBox(regionB);
    const textNodeB = container.querySelector(".body-copy")!.firstChild!;
    mockSelection(textNodeB, "全新正文内容");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.body.querySelector(".preview-selection-pill")).not.toBeNull();

    // Scroll on the newly bound regionB still triggers sync cleanly
    mockSelection(textNodeB, "全新正文内容", 240);
    await act(async () => {
      regionB.dispatchEvent(new Event("scroll"));
    });
    expect(document.body.querySelector<HTMLDivElement>(".preview-selection-pill")?.style.top).toBe("232px");

    // Copy copies Article B text
    const buttonsB = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button"));
    await act(async () => buttonsB[buttonsB.length - 1].click());
    expect(writeText).toHaveBeenCalledWith("全新正文内容");
    expect(onNotify).toHaveBeenCalledWith("已复制所选摘录", "success");

    // Ask Assistant sends Article B's title and agentEntry
    mockSelection(textNodeB, "文章 B 的全新正文");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    await act(async () => document.body.querySelector<HTMLButtonElement>(".preview-selection-pill .primary-ask")!.click());
    expect(onSetPending).toHaveBeenCalledWith({
      kind: "text",
      title: "文章 B",
      text: "文章 B 的全新正文",
    });
    expect(onOpenAgent).toHaveBeenCalledWith({ itemKey: "reading:b", title: "文章 B" });

    await act(async () => root.unmount());
  });

  it("reports real outcomes for duplicate snippet toggle, snippet storage failure, and clipboard failures", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);
    const root = createRoot(container);

    const saved = new Set<string>();
    let failStorage = false;
    const onNotify = vi.fn();
    const onOpenAgent = vi.fn();
    const onSetPending = vi.fn();
    const onSaveSnippet = vi.fn((text: string): SelectionSnippetOutcome => {
      if (failStorage) throw new Error("个人数据尚未加载");
      if (saved.has(text)) {
        saved.delete(text);
        return "removed";
      }
      saved.add(text);
      return "added";
    });

    const renderHarness = () =>
      root.render(
        <Harness
          isSnippetSaved={(text) => saved.has(text)}
          onSaveSnippet={onSaveSnippet}
          onNotify={onNotify}
          onOpenAgent={onOpenAgent}
          onSetPending={onSetPending}
        />,
      );

    await act(async () => renderHarness());
    const region = container.querySelector<HTMLDivElement>(".preview-content")!;
    setBox(region);
    const textNode = container.querySelector(".body-copy")!.firstChild!;

    // 1st click adds snippet
    mockSelection(textNode, "左前门卡扣顺序");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    let snippetBtn = document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button")[0];
    expect(snippetBtn.textContent).toBe("摘录收藏");
    expect(snippetBtn.getAttribute("aria-pressed")).toBe("false");
    await act(async () => snippetBtn.click());
    expect(onNotify).toHaveBeenLastCalledWith("已收藏所选摘录", "success");

    // 2nd click on same snippet removes it and reports cancellation
    await act(async () => renderHarness());
    mockSelection(textNode, "左前门卡扣顺序");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    snippetBtn = document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button")[0];
    expect(snippetBtn.textContent).toBe("取消摘录");
    expect(snippetBtn.getAttribute("aria-pressed")).toBe("true");
    await act(async () => snippetBtn.click());
    expect(onNotify).toHaveBeenLastCalledWith("已取消摘录收藏", "success");

    // Storage failure reports error and does not falsely claim saved
    failStorage = true;
    mockSelection(textNode, "左前门卡扣顺序");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    snippetBtn = document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button")[0];
    await act(async () => snippetBtn.click());
    expect(onNotify).toHaveBeenLastCalledWith("摘录收藏失败：个人数据尚未加载", "error");
    expect(document.body.querySelector(".preview-selection-pill")).not.toBeNull();

    // Clipboard unavailable + execCommand fails => reports error, never claims success
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    document.execCommand = vi.fn(() => false);
    let copyButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button"));
    await act(async () => copyButtons[copyButtons.length - 1].click());
    expect(onNotify).toHaveBeenLastCalledWith("复制摘录失败：系统剪贴板不可用", "error");
    expect(document.body.querySelector(".preview-selection-pill")).not.toBeNull();

    // Clipboard fallback succeeds via execCommand("copy")
    document.execCommand = vi.fn(() => true);
    copyButtons = Array.from(document.body.querySelectorAll<HTMLButtonElement>(".preview-selection-pill button"));
    await act(async () => copyButtons[copyButtons.length - 1].click());
    expect(onNotify).toHaveBeenLastCalledWith("已复制所选摘录", "success");
    expect(document.body.querySelector(".preview-selection-pill")).toBeNull();

    // Ignore selections inside input
    const input = container.querySelector<HTMLInputElement>(".editable-input")!;
    mockSelection(input, "输入框内容");
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(document.body.querySelector(".preview-selection-pill")).toBeNull();

    await act(async () => root.unmount());
  });
});
